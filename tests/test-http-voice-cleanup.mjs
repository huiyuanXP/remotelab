#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

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

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-voice-cleanup-'));
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
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const prompt = process.argv.slice(2).join(' ');
const prefersEnglishTechnicalTerms = prompt.includes('Prefer English technical/product terms, repo names, commands, paths, and identifiers when the project context strongly supports them');
const collapsesConflictingTerms = prompt.includes('two conflicting terms for what is probably one concept');
const allowsFluencySmoothing = prompt.includes('Allow light fluency smoothing');
const hasMixedLanguageHint = prompt.includes("Match the speaker's natural language mix");
let transcript = 'voice received';
if (prompt.includes('Raw ASR transcript:') && prompt.includes('请先把轻云版那个通道再发一次') && prompt.includes('内部发布通道名字')) {
  transcript = '请先把青云版那个通道再发一次';
} else if (prompt.includes('Raw ASR transcript:') && prompt.includes('请帮我把那个服务重起一下')) {
  transcript = '请帮我把 RemoteLab 服务重启一下';
} else if (prompt.includes('Raw ASR transcript:') && prompt.includes('把那个润木啦 assistant cake 再激进一点') && prompt.includes('assistant check')) {
  transcript = prefersEnglishTechnicalTerms && collapsesConflictingTerms && allowsFluencySmoothing && hasMixedLanguageHint
    ? '把那个 RemoteLab assistant check 再激进一点'
    : '把那个润木啦 assistant cake 再激进一点';
}
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-voice-cleanup-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: transcript }
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

async function createSession(port, name = 'RemoteLab voice cleanup session') {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
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
let home = '';

try {
  const chatPort = randomPort();
  ({ home } = setupTempHome());
  chatServer = await startServer({ home, port: chatPort });

  const session = await createSession(chatPort);

  const missingTranscriptRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/voice-transcriptions`, {});
  assert.equal(missingTranscriptRes.status, 400, 'voice cleanup should reject empty requests');
  assert.match(missingTranscriptRes.json?.error || '', /providedTranscript/i, 'voice cleanup should require a transcript string');

  const audioRemovedRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/voice-transcriptions`, {
    providedTranscript: '请帮我把那个服务重起一下',
    audio: {
      data: Buffer.from('fake-wave-audio').toString('base64'),
      mimeType: 'audio/wav',
      originalName: 'voice.wav',
    },
  });
  assert.equal(audioRemovedRes.status, 410, 'audio-based voice input should be removed');
  assert.match(audioRemovedRes.json?.error || '', /removed/i, 'removed voice input should report a clear migration hint');

  const plainRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/voice-transcriptions`, {
    providedTranscript: '请帮我把那个服务重起一下',
    rewriteWithContext: false,
  });
  assert.equal(plainRes.status, 200, 'plain transcript cleanup should succeed');
  assert.equal(plainRes.json.transcript, '请帮我把那个服务重起一下');
  assert.equal(plainRes.json.rewriteApplied, false, 'cleanup should be a no-op when rewrite is disabled');
  assert.equal(Object.prototype.hasOwnProperty.call(plainRes.json || {}, 'rawTranscript'), false, 'no-op cleanup should not emit a raw transcript copy');

  const rewrittenRes = await request(chatPort, 'POST', `/api/sessions/${session.id}/voice-transcriptions`, {
    providedTranscript: '请帮我把那个服务重起一下',
    rewriteWithContext: true,
  });
  assert.equal(rewrittenRes.status, 200, 'rewrite cleanup should succeed');
  assert.equal(rewrittenRes.json.transcript, '请帮我把 RemoteLab 服务重启一下');
  assert.equal(rewrittenRes.json.rawTranscript, '请帮我把那个服务重起一下');
  assert.equal(rewrittenRes.json.rewriteApplied, true, 'rewrite cleanup should report when it changes the transcript');

  const contextualSession = await createSession(chatPort, 'RemoteLab contextual cleanup session');
  const contextSeedRes = await request(chatPort, 'POST', `/api/sessions/${contextualSession.id}/messages`, {
    text: '这轮里提到的“青云版”就是内部发布通道名字。',
  });
  assert.ok(contextSeedRes.status === 202 || contextSeedRes.status === 200, 'context seed message should be accepted');
  assert.ok(contextSeedRes.json?.run?.id, 'context seed message should create a run');
  await waitForRunTerminal(chatPort, contextSeedRes.json.run.id);

  const contextRewriteRes = await request(chatPort, 'POST', `/api/sessions/${contextualSession.id}/voice-transcriptions`, {
    providedTranscript: '请先把轻云版那个通道再发一次',
    rewriteWithContext: true,
  });
  assert.equal(contextRewriteRes.status, 200, 'session-context transcript cleanup should succeed');
  assert.equal(contextRewriteRes.json.transcript, '请先把青云版那个通道再发一次');
  assert.equal(contextRewriteRes.json.rawTranscript, '请先把轻云版那个通道再发一次');
  assert.equal(contextRewriteRes.json.rewriteApplied, true, 'session-context transcript cleanup should use recent discussion when stable memory is not enough');

  const mixedLanguageSession = await createSession(chatPort, 'RemoteLab mixed-language cleanup session');
  const mixedSeedRes = await request(chatPort, 'POST', `/api/sessions/${mixedLanguageSession.id}/messages`, {
    text: '这轮要改的是 RemoteLab 的 assistant check，目标是让它更激进一点。',
  });
  assert.ok(mixedSeedRes.status === 202 || mixedSeedRes.status === 200, 'mixed-language context seed message should be accepted');
  assert.ok(mixedSeedRes.json?.run?.id, 'mixed-language context seed should create a run');
  await waitForRunTerminal(chatPort, mixedSeedRes.json.run.id);

  const mixedRewriteRes = await request(chatPort, 'POST', `/api/sessions/${mixedLanguageSession.id}/voice-transcriptions`, {
    providedTranscript: '把那个润木啦 assistant cake 再激进一点',
    rewriteWithContext: true,
  });
  assert.equal(mixedRewriteRes.status, 200, 'mixed-language transcript cleanup should succeed');
  assert.equal(mixedRewriteRes.json.transcript, '把那个 RemoteLab assistant check 再激进一点');
  assert.equal(mixedRewriteRes.json.rawTranscript, '把那个润木啦 assistant cake 再激进一点');
  assert.equal(mixedRewriteRes.json.rewriteApplied, true, 'mixed-language transcript cleanup should infer technical terms from project and session context');

  const rewrittenSendRes = await request(chatPort, 'POST', `/api/sessions/${contextualSession.id}/messages`, {
    requestId: 'req-context-rewrite',
    text: '请先把轻云版那个通道再发一次',
    rewriteWithContext: true,
  });
  assert.ok(rewrittenSendRes.status === 202 || rewrittenSendRes.status === 200, 'message submission with rewrite should be accepted');
  assert.ok(rewrittenSendRes.json?.run?.id, 'message submission with rewrite should create a run');
  await waitForRunTerminal(chatPort, rewrittenSendRes.json.run.id);

  const eventsRes = await request(chatPort, 'GET', `/api/sessions/${contextualSession.id}/events?filter=all`);
  assert.equal(eventsRes.status, 200, 'event history should load after the rewritten message is accepted');
  const rewrittenUserEvent = Array.isArray(eventsRes.json?.events)
    ? [...eventsRes.json.events].reverse().find((event) => event?.type === 'message' && event.role === 'user' && event.requestId === 'req-context-rewrite')
    : null;
  assert.equal(rewrittenUserEvent?.content, '请先把青云版那个通道再发一次', 'message submission should persist the cleaned transcript into canonical session history');

  console.log('test-http-voice-cleanup: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  await stopServer(chatServer);
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
}
