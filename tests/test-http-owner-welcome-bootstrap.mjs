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
const ownerCookie = 'session_token=test-owner-session';

function randomPort() {
  return 42000 + Math.floor(Math.random() * 3000);
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
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function resolveEventContent(port, sessionId, event, extraHeaders = {}) {
  if (typeof event?.content === 'string' && event.content) return event.content;
  if (!event?.bodyAvailable || !Number.isInteger(event?.seq)) return '';
  const bodyResponse = await request(port, 'GET', `/api/sessions/${sessionId}/events/${event.seq}/body`, null, extraHeaders);
  assert.equal(bodyResponse.status, 200, 'event body should load when advertised');
  return bodyResponse.json?.body?.value || '';
}

function setupTempHome({ preseedArchivedBasicChat = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-owner-welcome-'));
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
      'test-owner-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'micro-agent',
        name: 'Micro Agent',
        visibility: 'private',
        toolProfile: 'micro-agent',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: { kind: 'none', label: 'Thinking' },
      },
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
  writeFileSync(join(localBin, 'fake-codex'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  chmodSync(join(localBin, 'fake-codex'), 0o755);

  if (preseedArchivedBasicChat) {
    writeFileSync(
      join(configDir, 'chat-sessions.json'),
      JSON.stringify([
        {
          id: 'legacy_archived_basic_chat',
          folder: '/Users/jiujianian',
          tool: 'fake-codex',
          appId: 'app_basic_chat',
          appName: 'Basic Chat',
          name: 'new session',
          autoRenamePending: true,
          created: '2026-03-26T00:40:58.504Z',
          updatedAt: '2026-03-26T00:45:04.507Z',
          sourceId: 'chat',
          sourceName: 'Chat',
          archived: true,
          archivedAt: '2026-03-26T00:43:08.829Z',
        },
      ], null, 2),
      'utf8',
    );
  }

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
      const res = await request(port, 'GET', '/api/auth/me', null, { Cookie: ownerCookie });
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

async function assertWelcomeBootstrapped(port, { archivedCount = 0 } = {}) {
  const list = await request(port, 'GET', '/api/sessions', null, { Cookie: ownerCookie });
  assert.equal(list.status, 200, 'owner session list should load');
  assert.equal(list.json?.archivedCount, archivedCount, 'archived count should be preserved');
  assert.equal((list.json?.sessions || []).length, 3, 'starter owner session set should include welcome plus two verified showcases');

  const sessionNames = (list.json?.sessions || []).map((session) => session.name);
  assert.deepEqual(sessionNames, [
    'Welcome',
    '[示例] 上传一份表格，我把清洗后的文件回给你',
    '[示例] 发一封邮件到这个实例，会自动开一个新会话',
  ], 'starter sessions should appear in the intended sidebar order');

  for (const [index, session] of (list.json?.sessions || []).entries()) {
    assert.equal(session.pinned, true, 'starter sessions should be pinned for discoverability');
    assert.equal(session.sidebarOrder, index + 1, 'starter sessions should keep a stable sidebar order');
  }

  const welcomeSession = list.json?.sessions?.[0];
  assert.ok(welcomeSession?.id, 'welcome session should have an id');
  assert.equal(welcomeSession.appId, 'app_welcome', 'welcome session should use the built-in Welcome app');
  assert.equal(welcomeSession.tool, 'micro-agent', 'welcome bootstrap should prefer Micro Agent when it is available');
  assert.equal(welcomeSession.sourceId, 'chat', 'welcome session should be categorized as chat UI');
  assert.equal(welcomeSession.sourceName, 'Chat', 'welcome session should preserve the chat source label');
  assert.ok(Number(welcomeSession.messageCount || 0) >= 1, 'welcome session should include the starter assistant message');

  const events = await request(port, 'GET', `/api/sessions/${welcomeSession.id}/events`, null, { Cookie: ownerCookie });
  assert.equal(events.status, 200, 'welcome session events should load');
  const welcomeEvent = (events.json?.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
  assert.ok(welcomeEvent, 'welcome session should include an assistant onboarding message');
  const welcomeContent = await resolveEventContent(port, welcomeSession.id, welcomeEvent, { Cookie: ownerCookie });
  assert.match(welcomeContent, /我是 Rowan|先接手、再梳理、再推进执行/u, 'welcome copy should come from the built-in Welcome app');
  assert.match(welcomeContent, /左侧我已经先放了 2 个真实跑通过的示例会话/u, 'welcome copy should point owners to the verified showcase sessions');

  const fileShowcaseSession = list.json?.sessions?.[1];
  const fileShowcaseEvents = await request(port, 'GET', `/api/sessions/${fileShowcaseSession.id}/events?filter=all`, null, { Cookie: ownerCookie });
  assert.equal(fileShowcaseEvents.status, 200, 'file showcase session events should load');
  const fileShowcaseMessages = (fileShowcaseEvents.json?.events || []).filter((event) => event.type === 'message');
  assert.ok(fileShowcaseMessages.some((event) => event.role === 'user'), 'file showcase should include a sample user ask');
  assert.ok(fileShowcaseMessages.some((event) => event.role === 'assistant'), 'file showcase should include a sample assistant reply');
  const fileUserMessage = fileShowcaseMessages.find((event) => event.role === 'user');
  const fileAssistantMessage = [...fileShowcaseMessages].reverse().find((event) => event.role === 'assistant' && Array.isArray(event.attachments) && event.attachments.length > 0);
  assert.equal(fileUserMessage?.attachments?.length, 1, 'file showcase should include a sample uploaded file');
  assert.equal(fileAssistantMessage?.attachments?.length, 2, 'file showcase should include downloadable result files');
  const fileShowcaseContent = await resolveEventContent(port, fileShowcaseSession.id, fileAssistantMessage, { Cookie: ownerCookie });
  assert.match(fileShowcaseContent, /直接下载|结果文件/u, 'file showcase should end with a concrete downloadable deliverable');
  const fileDownloadRes = await fetch(`http://127.0.0.1:${port}/api/assets/${fileAssistantMessage.attachments[0].assetId}/download`, {
    method: 'GET',
    headers: { Cookie: ownerCookie },
  });
  assert.equal(fileDownloadRes.status, 200, 'file showcase result attachment should be downloadable');
  const downloadedBuffer = Buffer.from(await fileDownloadRes.arrayBuffer());
  assert.equal(downloadedBuffer.subarray(0, 2).toString('hex'), '504b', 'downloaded showcase spreadsheet should keep its xlsx zip signature');

  const emailShowcaseSession = list.json?.sessions?.[2];
  const emailShowcaseEvents = await request(port, 'GET', `/api/sessions/${emailShowcaseSession.id}/events?filter=all`, null, { Cookie: ownerCookie });
  assert.equal(emailShowcaseEvents.status, 200, 'email showcase session events should load');
  const emailShowcaseMessages = (emailShowcaseEvents.json?.events || []).filter((event) => event.type === 'message');
  assert.equal(emailShowcaseMessages.length, 3, 'email showcase should keep the expected three-message transcript');
  const emailIntroContent = await resolveEventContent(port, emailShowcaseSession.id, emailShowcaseMessages[0], { Cookie: ownerCookie });
  const emailUserContent = await resolveEventContent(port, emailShowcaseSession.id, emailShowcaseMessages[1], { Cookie: ownerCookie });
  assert.match(emailIntroContent, /自动多出一个新会话/u, 'email showcase should explain the automatic session behavior');
  assert.match(emailUserContent, /Inbound email\./u, 'email showcase should mirror the actual inbound email session format');

  const secondList = await request(port, 'GET', '/api/sessions', null, { Cookie: ownerCookie });
  assert.equal(secondList.status, 200, 'owner should be able to reload the session list');
  assert.equal((secondList.json?.sessions || []).length, 3, 'reloading should not create duplicate starter sessions');
  assert.equal(secondList.json?.sessions?.[0]?.id, welcomeSession.id, 'starter bootstrap should be idempotent for welcome');
}

async function runScenario(options) {
  const { home } = setupTempHome(options);
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    await assertWelcomeBootstrapped(port, {
      archivedCount: options?.preseedArchivedBasicChat ? 1 : 0,
    });
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
}

await runScenario();
await runScenario({ preseedArchivedBasicChat: true });
