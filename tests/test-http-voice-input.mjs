#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import { gzipSync } from 'zlib';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 41000 + Math.floor(Math.random() * 4000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text, buffer });
      });
    });
    req.on('error', reject);
    if (body) {
      if (body instanceof Buffer) req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

function setupTempHome(voiceWsPort) {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-voice-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'voice-input.json'),
    JSON.stringify({
      enabled: true,
      provider: 'volcengine',
      volcengine: {
        appId: 'test-app-id',
        accessKey: 'test-access-key',
        endpoint: `ws://127.0.0.1:${voiceWsPort}`,
        resourceId: 'volc.seedasr.sauc.duration',
        language: 'zh-CN',
        modelLabel: 'Mock Voice Model',
      },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-voice-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'voice received' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 30);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 'server shutdown');
}

function buildVoiceProviderResponseFrame(payloadObject, sequence = 2) {
  const header = Buffer.alloc(4);
  header.writeUInt8((0x1 << 4) | 0x1, 0);
  header.writeUInt8((0x9 << 4) | 0x3, 1);
  header.writeUInt8((0x1 << 4) | 0x1, 2);
  header.writeUInt8(0x00, 3);

  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(sequence, 0);

  const payload = gzipSync(Buffer.from(JSON.stringify(payloadObject), 'utf8'));
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, sequenceBuffer, payloadSize, payload]);
}

function startMockVoiceProvider(port) {
  const server = new WebSocketServer({ port });
  server.on('connection', (socket) => {
    let messageCount = 0;
    socket.on('message', () => {
      messageCount += 1;
      if (messageCount < 2) return;
      socket.send(buildVoiceProviderResponseFrame({
        audio_info: { duration: 920 },
        result: {
          additions: { log_id: 'mock-log-id' },
          text: '这是一条语音测试',
          utterances: [
            {
              definite: true,
              text: '这是一条语音测试',
            },
          ],
        },
      }));
    });
  });
  return server;
}

async function createSession(port) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name: 'Voice input session',
  });
  assert.equal(res.status, 201, 'session should be created');
  return res.json.session;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    return ['completed', 'failed', 'cancelled'].includes(res.json.run.state) ? res.json.run : false;
  }, `run ${runId} terminal`);
}

let chatServer = null;
let mockVoiceServer = null;
let home = '';

try {
  const voiceWsPort = randomPort();
  const chatPort = randomPort();
  mockVoiceServer = startMockVoiceProvider(voiceWsPort);
  ({ home } = setupTempHome(voiceWsPort));
  chatServer = await startServer({ home, port: chatPort });

  const configRes = await request(chatPort, 'GET', '/api/voice-input/config');
  assert.equal(configRes.status, 200, 'voice input config should load');
  assert.equal(configRes.json.config.configured, true, 'voice input config should be marked configured');
  assert.equal(configRes.json.config.hasAccessKey, true, 'owner summary should report access key presence');
  assert.equal(Object.prototype.hasOwnProperty.call(configRes.json.config, 'accessKey'), false, 'access key should never be echoed');

  const session = await createSession(chatPort);
  const transcriptionRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/voice-transcriptions`, {
    audio: {
      data: Buffer.from('fake-wave-audio').toString('base64'),
      mimeType: 'audio/wav',
      originalName: 'voice.wav',
    },
    persistAudio: true,
  });
  assert.equal(transcriptionRes.status, 200, 'voice transcription should succeed');
  assert.equal(transcriptionRes.json.transcript, '这是一条语音测试');
  assert.equal(transcriptionRes.json.attachment.originalName, 'voice.wav');
  assert.match(transcriptionRes.json.attachment.filename || '', /\.wav$/, 'saved audio should keep a wav extension');

  const messageRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/messages`, {
    text: transcriptionRes.json.transcript,
    images: [transcriptionRes.json.attachment],
  });
  assert.ok(messageRes.status === 202 || messageRes.status === 200, 'message send with saved voice attachment should be accepted');
  assert.ok(messageRes.json?.run?.id, 'message send should create a run');

  const run = await waitForRunTerminal(chatPort, messageRes.json.run.id);
  assert.equal(run.state, 'completed', 'voice attachment run should complete');

  const userMessage = await waitFor(async () => {
    const res = await request(chatPort, 'GET', `/api/sessions/${session.id}/events`);
    if (res.status !== 200) return false;
    return (res.json.events || []).find((event) => event.type === 'message' && event.role === 'user') || false;
  }, 'user message with saved voice attachment');

  assert.equal(userMessage.content, '这是一条语音测试');
  assert.equal(userMessage.images?.length, 1, 'user message should keep the saved voice attachment');
  assert.equal(userMessage.images[0].mimeType, 'audio/wav');
  assert.equal(userMessage.images[0].originalName, 'voice.wav');

  const mediaRes = await request(chatPort, 'GET', `/api/media/${userMessage.images[0].filename}`);
  assert.equal(mediaRes.status, 200, 'saved voice attachment should be downloadable');
  assert.match(mediaRes.headers['content-type'] || '', /^audio\/wav/, 'saved voice attachment should keep its mime type');

  console.log('test-http-voice-input: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  if (mockVoiceServer) {
    await new Promise((resolve) => mockVoiceServer.close(resolve));
  }
  await stopServer(chatServer);
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
}
