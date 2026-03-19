import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { gunzipSync, gzipSync } from 'zlib';
import WebSocket from 'ws';
import { VOICE_INPUT_CONFIG_FILE } from '../lib/config.mjs';
import { createSerialTaskQueue, readJson, writeJsonAtomic } from './fs-utils.mjs';

const DEFAULT_VOICE_PROVIDER = 'volcengine';
const DEFAULT_VOLCENGINE_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
const DEFAULT_VOLCENGINE_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const DEFAULT_VOLCENGINE_MODEL_LABEL = '豆包流式语音识别模型 2.0';
const DEFAULT_VOICE_INPUT_LANGUAGE = 'zh-CN';
const VOICE_INPUT_TIMEOUT_MS = 25 * 1000;

const VOLCENGINE_MESSAGE_TYPE = {
  fullClientRequest: 0x1,
  audioOnlyRequest: 0x2,
  fullServerResponse: 0x9,
  error: 0xf,
};

const VOLCENGINE_SERIALIZATION = {
  none: 0x0,
  json: 0x1,
};

const VOLCENGINE_COMPRESSION = {
  none: 0x0,
  gzip: 0x1,
};

const configWriteQueue = createSerialTaskQueue();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWsEndpoint(value) {
  const normalized = trimString(value);
  if (!normalized) return DEFAULT_VOLCENGINE_ENDPOINT;
  return /^wss?:\/\//i.test(normalized) ? normalized : DEFAULT_VOLCENGINE_ENDPOINT;
}

function normalizeVoiceProvider(value) {
  return trimString(value) === DEFAULT_VOICE_PROVIDER ? DEFAULT_VOICE_PROVIDER : DEFAULT_VOICE_PROVIDER;
}

function normalizeVoiceInputConfig(value = {}) {
  const rawVolcengine = value?.volcengine && typeof value.volcengine === 'object'
    ? value.volcengine
    : {};
  return {
    enabled: value?.enabled !== false,
    provider: normalizeVoiceProvider(value?.provider),
    volcengine: {
      appId: trimString(rawVolcengine.appId),
      accessKey: trimString(rawVolcengine.accessKey),
      endpoint: normalizeWsEndpoint(rawVolcengine.endpoint),
      resourceId: trimString(rawVolcengine.resourceId) || DEFAULT_VOLCENGINE_RESOURCE_ID,
      language: trimString(rawVolcengine.language) || DEFAULT_VOICE_INPUT_LANGUAGE,
      modelLabel: trimString(rawVolcengine.modelLabel) || DEFAULT_VOLCENGINE_MODEL_LABEL,
    },
  };
}

function mergeVoiceInputConfig(current, patch = {}) {
  const next = normalizeVoiceInputConfig(current);
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    next.enabled = patch.enabled !== false;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'provider')) {
    next.provider = normalizeVoiceProvider(patch.provider);
  }
  if (patch?.volcengine && typeof patch.volcengine === 'object') {
    const currentVolcengine = next.volcengine;
    const volcenginePatch = patch.volcengine;
    if (Object.prototype.hasOwnProperty.call(volcenginePatch, 'appId')) {
      currentVolcengine.appId = trimString(volcenginePatch.appId);
    }
    if (Object.prototype.hasOwnProperty.call(volcenginePatch, 'accessKey')) {
      currentVolcengine.accessKey = trimString(volcenginePatch.accessKey);
    }
    if (Object.prototype.hasOwnProperty.call(volcenginePatch, 'endpoint')) {
      currentVolcengine.endpoint = normalizeWsEndpoint(volcenginePatch.endpoint);
    }
    if (Object.prototype.hasOwnProperty.call(volcenginePatch, 'resourceId')) {
      currentVolcengine.resourceId = trimString(volcenginePatch.resourceId) || DEFAULT_VOLCENGINE_RESOURCE_ID;
    }
    if (Object.prototype.hasOwnProperty.call(volcenginePatch, 'language')) {
      currentVolcengine.language = trimString(volcenginePatch.language) || DEFAULT_VOICE_INPUT_LANGUAGE;
    }
    if (Object.prototype.hasOwnProperty.call(volcenginePatch, 'modelLabel')) {
      currentVolcengine.modelLabel = trimString(volcenginePatch.modelLabel) || DEFAULT_VOLCENGINE_MODEL_LABEL;
    }
  }
  return normalizeVoiceInputConfig(next);
}

function createVoiceInputError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeMimeType(value) {
  return trimString(value).toLowerCase().split(';')[0];
}

function sanitizeOriginalName(value) {
  const normalized = trimString(value).replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() || '';
  return base.slice(0, 255);
}

function resolveFileExtension(originalName, mimeType = '') {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const directExtension = extname(originalName || '').toLowerCase();
  if (/^\.[a-z0-9]+$/.test(directExtension)) {
    return directExtension;
  }
  if (normalizedMimeType === 'audio/mp4' || normalizedMimeType === 'audio/x-m4a') return '.m4a';
  if (normalizedMimeType === 'audio/webm') return '.webm';
  if (normalizedMimeType === 'audio/ogg') return '.ogg';
  if (normalizedMimeType === 'audio/mpeg') return '.mp3';
  if (normalizedMimeType === 'audio/wav' || normalizedMimeType === 'audio/x-wav') return '.wav';
  if (normalizedMimeType === 'audio/pcm' || normalizedMimeType === 'audio/l16') return '.pcm';
  if (normalizedMimeType === 'video/mp4') return '.mp4';
  return '.bin';
}

function isDirectPreferredAudioFormat(mimeType = '', originalName = '') {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const extension = extname(originalName).toLowerCase();
  return [
    'audio/wav',
    'audio/x-wav',
    'audio/pcm',
    'audio/l16',
    'audio/mpeg',
  ].includes(normalizedMimeType)
    || ['.wav', '.pcm', '.mp3'].includes(extension);
}

function isDirectSupportedAudioFormat(mimeType = '', originalName = '') {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const extension = extname(originalName).toLowerCase();
  if (isDirectPreferredAudioFormat(normalizedMimeType, originalName)) return true;
  return ['audio/webm', 'audio/ogg'].includes(normalizedMimeType)
    || ['.webm', '.ogg'].includes(extension);
}

function resolveVolcengineAudioConfig(mimeType = '', originalName = '') {
  const normalizedMimeType = normalizeMimeType(mimeType);
  const extension = extname(originalName).toLowerCase();
  if (normalizedMimeType.includes('pcm') || extension === '.pcm') {
    return { format: 'pcm', codec: 'raw' };
  }
  if (normalizedMimeType.includes('mp3') || extension === '.mp3') {
    return { format: 'mp3', codec: 'raw' };
  }
  if (normalizedMimeType.includes('ogg') || extension === '.ogg') {
    return { format: 'ogg', codec: 'opus' };
  }
  if (normalizedMimeType.includes('webm') || extension === '.webm') {
    return { format: 'webm', codec: 'opus' };
  }
  return { format: 'wav', codec: 'raw' };
}

function buildVolcengineHeader(options) {
  const header = Buffer.alloc(4);
  header.writeUInt8((0x1 << 4) | 0x1, 0);
  header.writeUInt8((options.messageType << 4) | options.messageTypeFlags, 1);
  header.writeUInt8((options.serialization << 4) | options.compression, 2);
  header.writeUInt8(0x00, 3);
  return header;
}

function encodeVolcenginePayload(payload, compression) {
  if (compression === VOLCENGINE_COMPRESSION.gzip && payload.length > 0) {
    return gzipSync(payload);
  }
  return payload;
}

function buildVolcengineBinaryFrame(options) {
  const compressedPayload = encodeVolcenginePayload(options.payload, options.compression);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(compressedPayload.length, 0);
  return Buffer.concat([
    buildVolcengineHeader(options),
    ...(options.prefixBuffers || []),
    payloadSize,
    compressedPayload,
  ]);
}

function buildVolcengineFullClientRequestFrame(payloadObject, sequence = 1) {
  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(sequence, 0);
  return buildVolcengineBinaryFrame({
    messageType: VOLCENGINE_MESSAGE_TYPE.fullClientRequest,
    messageTypeFlags: 0b0001,
    serialization: VOLCENGINE_SERIALIZATION.json,
    compression: VOLCENGINE_COMPRESSION.gzip,
    prefixBuffers: [sequenceBuffer],
    payload: Buffer.from(JSON.stringify(payloadObject), 'utf8'),
  });
}

function buildVolcengineAudioRequestFrame(audioBuffer, sequence, isFinal = false) {
  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(isFinal ? -Math.abs(sequence) : sequence, 0);
  return buildVolcengineBinaryFrame({
    messageType: VOLCENGINE_MESSAGE_TYPE.audioOnlyRequest,
    messageTypeFlags: isFinal ? 0b0011 : 0b0001,
    serialization: VOLCENGINE_SERIALIZATION.none,
    compression: VOLCENGINE_COMPRESSION.gzip,
    prefixBuffers: [sequenceBuffer],
    payload: audioBuffer,
  });
}

function parseVolcengineServerPacket(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) {
    return { type: 'unknown' };
  }
  const messageType = (data.readUInt8(1) >> 4) & 0x0f;
  const messageTypeFlags = data.readUInt8(1) & 0x0f;
  const serialization = (data.readUInt8(2) >> 4) & 0x0f;
  const compression = data.readUInt8(2) & 0x0f;
  if (messageType === VOLCENGINE_MESSAGE_TYPE.error) {
    if (data.length < 12) {
      return { type: 'error', code: 0, message: 'Unknown voice input server error' };
    }
    const code = data.readUInt32BE(4);
    const size = data.readUInt32BE(8);
    const message = data.subarray(12, 12 + size).toString('utf8');
    return { type: 'error', code, message };
  }
  if (messageType !== VOLCENGINE_MESSAGE_TYPE.fullServerResponse || data.length < 12) {
    return { type: 'unknown' };
  }
  const sequence = data.readInt32BE(4);
  const payloadSize = data.readUInt32BE(8);
  const compressedPayload = data.subarray(12, 12 + payloadSize);
  const payload = compression === VOLCENGINE_COMPRESSION.gzip
    ? gunzipSync(compressedPayload)
    : compressedPayload;
  let decoded = payload.toString('utf8');
  if (serialization === VOLCENGINE_SERIALIZATION.json) {
    try {
      decoded = JSON.parse(decoded);
    } catch {}
  }
  return {
    type: 'response',
    data: decoded,
    sequence,
    isFinal: messageTypeFlags === 0b0010 || messageTypeFlags === 0b0011,
  };
}

function extractVolcengineTranscript(payload) {
  const utterances = Array.isArray(payload?.result?.utterances) ? payload.result.utterances : [];
  const utteranceText = utterances.map((item) => trimString(item?.text)).filter(Boolean).join(' ').trim();
  if (utteranceText) return utteranceText;
  const nestedText = trimString(payload?.result?.text);
  if (nestedText) return nestedText;
  return trimString(payload?.text);
}

function createVolcengineAuthHeaders(options) {
  return {
    'X-Api-App-Id': options.appId,
    'X-Api-App-Key': options.appId,
    'X-Api-Access-Key': options.accessKey,
    'X-Api-Resource-Id': options.resourceId,
    'X-Api-Connect-Id': options.connectId,
  };
}

async function transcodeAudioToWav(inputBuffer, options = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-voice-input-'));
  const inputExtension = resolveFileExtension(options.originalName || '', options.mimeType || '');
  const inputPath = join(tempDir, `input${inputExtension}`);
  const outputPath = join(tempDir, 'output.wav');
  let stderr = '';
  try {
    await writeFile(inputPath, inputBuffer);
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vn',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        outputPath,
      ], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4096) {
          stderr += String(chunk || '');
        }
      });
      child.on('error', (error) => {
        reject(createVoiceInputError(
          'VOICE_INPUT_TRANSCODE_FAILED',
          error?.code === 'ENOENT'
            ? 'Voice input needs ffmpeg on this machine to handle this audio format.'
            : 'Voice input failed to start ffmpeg for audio normalization.',
          500,
        ));
      });
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(createVoiceInputError(
          'VOICE_INPUT_TRANSCODE_FAILED',
          trimString(stderr) || 'Voice input failed to normalize the recorded audio.',
          422,
        ));
      });
    });
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function prepareAudioForTranscription(audio) {
  const originalName = sanitizeOriginalName(audio?.originalName || audio?.name || 'voice-input');
  const mimeType = normalizeMimeType(audio?.mimeType || '');
  const buffer = Buffer.isBuffer(audio?.buffer)
    ? audio.buffer
    : Buffer.from(typeof audio?.data === 'string' ? audio.data : '', 'base64');
  if (!buffer.length) {
    throw createVoiceInputError('VOICE_INPUT_EMPTY_AUDIO', 'Voice input did not receive any audio bytes.', 400);
  }
  if (isDirectPreferredAudioFormat(mimeType, originalName)) {
    return {
      buffer,
      mimeType: mimeType || 'audio/wav',
      originalName,
      audioConfig: resolveVolcengineAudioConfig(mimeType, originalName),
    };
  }
  try {
    const transcodedBuffer = await transcodeAudioToWav(buffer, { mimeType, originalName });
    const baseName = basename(originalName, extname(originalName)) || 'voice-input';
    return {
      buffer: transcodedBuffer,
      mimeType: 'audio/wav',
      originalName: `${baseName}.wav`,
      audioConfig: { format: 'wav', codec: 'raw' },
    };
  } catch (error) {
    if (isDirectSupportedAudioFormat(mimeType, originalName)) {
      return {
        buffer,
        mimeType,
        originalName,
        audioConfig: resolveVolcengineAudioConfig(mimeType, originalName),
      };
    }
    throw error;
  }
}

async function transcribeWithVolcengine(audio, config, options = {}) {
  const connectId = randomUUID();
  const language = trimString(options.language) || config.language || DEFAULT_VOICE_INPUT_LANGUAGE;
  const requestPayload = {
    user: {
      uid: randomUUID(),
    },
    audio: {
      format: audio.audioConfig.format,
      codec: audio.audioConfig.codec,
      rate: 16000,
      bits: 16,
      channel: 1,
      ...(language ? { language } : {}),
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: 'full',
    },
  };
  return await new Promise((resolve, reject) => {
    let settled = false;
    let sequence = 1;
    let finalText = '';
    const ws = new WebSocket(config.endpoint, {
      headers: createVolcengineAuthHeaders({
        appId: config.appId,
        accessKey: config.accessKey,
        resourceId: config.resourceId,
        connectId,
      }),
    });

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback();
    };

    const timeoutId = setTimeout(() => {
      settle(() => {
        ws.close();
        reject(createVoiceInputError('VOICE_INPUT_TIMEOUT', 'Voice input transcription timed out.', 504));
      });
    }, VOICE_INPUT_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(buildVolcengineFullClientRequestFrame(requestPayload, sequence));
      sequence += 1;
      ws.send(buildVolcengineAudioRequestFrame(audio.buffer, sequence, true));
    });

    ws.on('message', (rawData) => {
      const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
      const packet = parseVolcengineServerPacket(data);
      if (packet.type === 'error') {
        settle(() => {
          ws.close();
          reject(createVoiceInputError(
            'VOICE_INPUT_PROVIDER_ERROR',
            packet.message || `Voice input provider error (${packet.code || 'unknown'}).`,
            502,
          ));
        });
        return;
      }
      if (packet.type !== 'response') return;
      const text = extractVolcengineTranscript(packet.data);
      if (text) {
        finalText = text;
      }
      const hasDefiniteUtterance = Array.isArray(packet.data?.result?.utterances)
        && packet.data.result.utterances.some((item) => item?.definite === true);
      if (!packet.isFinal && !hasDefiniteUtterance) {
        return;
      }
      settle(() => {
        ws.close();
        resolve({
          text: finalText,
          durationMs: Number(packet.data?.audio_info?.duration || 0),
          logId: trimString(packet.data?.result?.additions?.log_id),
        });
      });
    });

    ws.on('error', (error) => {
      settle(() => {
        reject(createVoiceInputError(
          'VOICE_INPUT_PROVIDER_ERROR',
          trimString(error?.message) || 'Voice input provider websocket error.',
          502,
        ));
      });
    });

    ws.on('close', () => {
      if (settled) return;
      settle(() => {
        reject(createVoiceInputError(
          'VOICE_INPUT_PROVIDER_ERROR',
          'Voice input provider closed the transcription stream unexpectedly.',
          502,
        ));
      });
    });
  });
}

export async function readVoiceInputConfig() {
  const stored = await readJson(VOICE_INPUT_CONFIG_FILE, null);
  return normalizeVoiceInputConfig(stored || {});
}

export async function updateVoiceInputConfig(patch = {}) {
  return configWriteQueue(async () => {
    const current = await readVoiceInputConfig();
    const next = mergeVoiceInputConfig(current, patch);
    await writeJsonAtomic(VOICE_INPUT_CONFIG_FILE, next);
    return next;
  });
}

export function isVoiceInputConfigured(config) {
  const normalized = normalizeVoiceInputConfig(config || {});
  return normalized.enabled
    && normalized.provider === DEFAULT_VOICE_PROVIDER
    && !!trimString(normalized.volcengine.appId)
    && !!trimString(normalized.volcengine.accessKey);
}

export function buildVoiceInputConfigSummary(config, authSession = null) {
  const normalized = normalizeVoiceInputConfig(config || {});
  const configured = isVoiceInputConfigured(normalized);
  const summary = {
    enabled: normalized.enabled,
    configured,
    provider: normalized.provider,
    providerLabel: 'Volcengine',
    modelLabel: normalized.volcengine.modelLabel,
    language: normalized.volcengine.language,
    endpoint: normalized.volcengine.endpoint,
    resourceId: normalized.volcengine.resourceId,
  };
  if (authSession?.role === 'owner') {
    summary.appId = normalized.volcengine.appId;
    summary.hasAccessKey = !!normalized.volcengine.accessKey;
  }
  return summary;
}

export async function transcribeVoiceInputAudio(audio, options = {}) {
  const config = await readVoiceInputConfig();
  if (!isVoiceInputConfigured(config)) {
    throw createVoiceInputError(
      'VOICE_INPUT_NOT_CONFIGURED',
      'Voice input is not configured yet. Add the provider details in Settings first.',
      503,
    );
  }
  const preparedAudio = await prepareAudioForTranscription(audio);
  const transcription = await transcribeWithVolcengine(preparedAudio, config.volcengine, options);
  return {
    provider: config.provider,
    modelLabel: config.volcengine.modelLabel,
    language: trimString(options.language) || config.volcengine.language,
    transcript: trimString(transcription.text),
    durationMs: Number(transcription.durationMs || 0),
    logId: transcription.logId,
  };
}
