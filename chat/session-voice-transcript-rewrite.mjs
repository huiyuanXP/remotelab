import { readFile } from 'fs/promises';
import { join } from 'path';
import { MEMORY_DIR } from '../lib/config.mjs';
import { formatAttachmentContextLine, getMessageAttachments } from './attachment-utils.mjs';

const VOICE_TRANSCRIPT_REWRITE_BOOTSTRAP_FILE = join(MEMORY_DIR, 'bootstrap.md');
const VOICE_TRANSCRIPT_REWRITE_PROJECTS_FILE = join(MEMORY_DIR, 'projects.md');
const VOICE_TRANSCRIPT_REWRITE_RECENT_HISTORY_WINDOW = 24;
const VOICE_TRANSCRIPT_REWRITE_RECENT_MESSAGE_LIMIT = 8;
const VOICE_TRANSCRIPT_REWRITE_SESSION_SUMMARY_MAX_CHARS = 1600;
const VOICE_TRANSCRIPT_REWRITE_RECENT_DISCUSSION_MAX_CHARS = 2400;
const DEFAULT_VOICE_TRANSCRIPT_REWRITE_LANGUAGE_HINT = 'Match the speaker\'s natural language mix. Chinese messages may naturally include English technical/product terms, repository names, commands, file paths, and identifiers when the surrounding context supports them.';
const VOICE_TRANSCRIPT_REWRITE_DEVELOPER_INSTRUCTIONS = [
  'You are a hidden transcript cleanup worker inside RemoteLab.',
  'Do not use tools, do not ask follow-up questions, and do not mention internal process.',
  'Fix likely transcription mistakes, likely English technical-term substitutions, and light fluency issues, but never answer the user or continue the conversation.',
  'When project or session context strongly supports the intended term, normalize to that term instead of preserving an obviously wrong ASR variant.',
  'Return only the final cleaned transcript text.',
].join(' ');

function normalizeVoiceTranscriptRewriteText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipVoiceTranscriptRewriteText(value, maxChars = 1200) {
  const text = normalizeVoiceTranscriptRewriteText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.65));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[… clipped …]\n${text.slice(-tailChars).trimStart()}`;
}

function formatVoiceTranscriptRewriteImages(images = []) {
  return formatAttachmentContextLine(images);
}

function formatVoiceTranscriptRewriteDiscussionEvent(event) {
  if (!(event && event.type === 'message')) return '';
  const label = event.role === 'assistant' ? 'Assistant' : 'User';
  const parts = [];
  const content = clipVoiceTranscriptRewriteText(event.content, 700);
  const imageLine = formatVoiceTranscriptRewriteImages(getMessageAttachments(event));
  if (content) parts.push(content);
  if (imageLine) parts.push(imageLine);
  if (parts.length === 0) return '';
  return `[${label}]\n${parts.join('\n')}`;
}

async function loadVoiceTranscriptRewriteMemoryContext() {
  const entries = [
    { label: 'Collaboration bootstrap', path: VOICE_TRANSCRIPT_REWRITE_BOOTSTRAP_FILE, maxChars: 2600 },
    { label: 'Project pointers', path: VOICE_TRANSCRIPT_REWRITE_PROJECTS_FILE, maxChars: 2200 },
  ];
  const parts = [];

  for (const entry of entries) {
    try {
      const text = clipVoiceTranscriptRewriteText(await readFile(entry.path, 'utf8'), entry.maxChars);
      if (text) {
        parts.push(`${entry.label}:\n${text}`);
      }
    } catch {}
  }

  return parts.join('\n\n');
}

async function loadVoiceTranscriptRewriteSessionContext(sessionId, sessionMeta = null, { loadContextHead, loadSessionHistory } = {}) {
  if (typeof loadContextHead !== 'function') {
    throw new TypeError('loadVoiceTranscriptRewriteSessionContext requires loadContextHead');
  }
  if (typeof loadSessionHistory !== 'function') {
    throw new TypeError('loadVoiceTranscriptRewriteSessionContext requires loadSessionHistory');
  }

  const latestSeq = Number.isInteger(sessionMeta?.latestSeq) ? sessionMeta.latestSeq : 0;
  const fromSeq = latestSeq > 0
    ? Math.max(1, latestSeq - VOICE_TRANSCRIPT_REWRITE_RECENT_HISTORY_WINDOW + 1)
    : 1;
  const [contextHead, recentEvents] = await Promise.all([
    loadContextHead(sessionId).catch(() => null),
    loadSessionHistory(sessionId, {
      fromSeq,
      includeBodies: true,
    }).catch(() => []),
  ]);

  const parts = [];
  const summary = clipVoiceTranscriptRewriteText(
    typeof contextHead?.summary === 'string' ? contextHead.summary : '',
    VOICE_TRANSCRIPT_REWRITE_SESSION_SUMMARY_MAX_CHARS,
  );
  if (summary) {
    parts.push(`Current session summary:\n${summary}`);
  }

  const recentDiscussion = recentEvents
    .filter((event) => event?.type === 'message' && (event.role === 'user' || event.role === 'assistant'))
    .slice(-VOICE_TRANSCRIPT_REWRITE_RECENT_MESSAGE_LIMIT)
    .map(formatVoiceTranscriptRewriteDiscussionEvent)
    .filter(Boolean)
    .join('\n\n');
  if (recentDiscussion) {
    parts.push(`Recent discussion:\n${clipVoiceTranscriptRewriteText(recentDiscussion, VOICE_TRANSCRIPT_REWRITE_RECENT_DISCUSSION_MAX_CHARS)}`);
  }

  return parts.join('\n\n');
}

function buildVoiceTranscriptRewritePrompt(sessionMeta, transcript, memoryContext, sessionContext, options = {}) {
  const languageHint = normalizeVoiceTranscriptRewriteText(options.language) || DEFAULT_VOICE_TRANSCRIPT_REWRITE_LANGUAGE_HINT;
  return [
    'You are cleaning up automatic speech recognition text for a RemoteLab chat composer.',
    'Rewrite the raw transcript into the message the speaker most likely intended.',
    'Use stable collaboration memory plus the current session summary and recent discussion to disambiguate names, terms, references, and obvious ASR mistakes.',
    'Prefer the current session context when it clearly resolves a reference.',
    'Prefer English technical/product terms, repo names, commands, paths, and identifiers when the project context strongly supports them, even if the raw transcript rendered them phonetically or as odd Chinese words.',
    'If the transcript contains suspicious out-of-domain words, duplicated near-synonyms, or two conflicting terms for what is probably one concept, treat that as a likely ASR error and resolve it to the single most plausible intended term from context.',
    'Preserve exact casing, spelling, and formatting for supported technical names when you can infer them confidently from context.',
    'Allow light fluency smoothing: merge broken fragments, remove accidental repetitions, fix punctuation, and make the sentence sound natural without changing meaning.',
    'Keep the same meaning, tone, and request.',
    'Do not answer the request, summarize the conversation, or add any new facts, steps, or conclusions that are not already supported by the raw transcript or the context provided here.',
    'If something is uncertain, stay close to the raw transcript instead of guessing.',
    'Keep the result concise and chat-ready.',
    'Return only the final cleaned transcript.',
    '',
    languageHint ? `Language hint: ${languageHint}` : '',
    sessionMeta?.appName ? `Session app: ${sessionMeta.appName}` : '',
    sessionMeta?.sourceName ? `Session source: ${sessionMeta.sourceName}` : '',
    sessionMeta?.folder ? `Working folder: ${sessionMeta.folder}` : '',
    memoryContext ? `Persistent collaboration memory:\n${memoryContext}` : 'Persistent collaboration memory: [none]',
    sessionContext ? `Current session context:\n${sessionContext}` : 'Current session context: [none]',
    '',
    'Raw ASR transcript:',
    transcript,
    '',
    'Final cleaned transcript:',
  ].filter(Boolean).join('\n');
}

function normalizeVoiceTranscriptRewriteOutput(value) {
  let text = normalizeVoiceTranscriptRewriteText(value);
  if (!text) return '';
  text = text
    .replace(/^```[a-z0-9_-]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .replace(/^(final rewritten transcript|rewritten transcript|transcript)\s*:\s*/i, '')
    .trim();
  const quotedMatch = text.match(/^["“](.*)["”]$/s);
  if (quotedMatch?.[1]) {
    text = quotedMatch[1].trim();
  }
  return text;
}

export async function rewriteVoiceTranscriptForSessionWithContext(sessionId, transcript, services = {}, options = {}) {
  const {
    findSessionMeta,
    loadContextHead,
    loadSessionHistory,
    runAssistantPrompt,
  } = services;

  if (typeof findSessionMeta !== 'function') {
    throw new TypeError('rewriteVoiceTranscriptForSessionWithContext requires findSessionMeta');
  }
  if (typeof runAssistantPrompt !== 'function') {
    throw new TypeError('rewriteVoiceTranscriptForSessionWithContext requires runAssistantPrompt');
  }

  const rawTranscript = normalizeVoiceTranscriptRewriteText(transcript);
  if (!rawTranscript) {
    return {
      transcript: '',
      changed: false,
      skipped: 'empty_transcript',
    };
  }

  const sessionMeta = await findSessionMeta(sessionId);
  if (!sessionMeta?.tool) {
    return {
      transcript: rawTranscript,
      changed: false,
      skipped: 'session_tool_unavailable',
    };
  }

  const [memoryContext, sessionContext] = await Promise.all([
    loadVoiceTranscriptRewriteMemoryContext(),
    loadVoiceTranscriptRewriteSessionContext(sessionId, sessionMeta, {
      loadContextHead,
      loadSessionHistory,
    }),
  ]);
  const rewritten = normalizeVoiceTranscriptRewriteOutput(await runAssistantPrompt({
    ...sessionMeta,
    effort: 'low',
    thinking: false,
  }, buildVoiceTranscriptRewritePrompt(sessionMeta, rawTranscript, memoryContext, sessionContext, options), {
    developerInstructions: VOICE_TRANSCRIPT_REWRITE_DEVELOPER_INSTRUCTIONS,
    systemPrefix: '',
  }));

  if (!rewritten) {
    return {
      transcript: rawTranscript,
      changed: false,
      skipped: 'empty_rewrite',
    };
  }

  return {
    transcript: rewritten,
    changed: rewritten !== rawTranscript,
    tool: sessionMeta.tool,
    model: sessionMeta.model || '',
  };
}
