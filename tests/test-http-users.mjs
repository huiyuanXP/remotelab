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
  return 44000 + Math.floor(Math.random() * 5000);
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

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-users-'));
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
setTimeout(() => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'boot ok' }
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
}, 50);
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

try {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });
  try {
    const initialUsers = await request(port, 'GET', '/api/users', null, {
      Cookie: ownerCookie,
    });
    assert.equal(initialUsers.status, 200, 'owner should be able to list users');
    assert.deepEqual(initialUsers.json?.users || [], [], 'new temp home should start with no extra users');

    const createAppResponse = await request(port, 'POST', '/api/apps', {
      name: 'Video Cut Demo',
      systemPrompt: 'Use the local video-cut workflow when asked.',
      welcomeMessage: '请上传一段原始视频，并说明要保留什么。',
      tool: 'fake-codex',
      skills: [],
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(createAppResponse.status, 201, 'owner should be able to create a regular shareable app');
    const videoCutAppId = createAppResponse.json?.app?.id;
    assert.ok(videoCutAppId, 'created app should return an id');

    const createUser = await request(port, 'POST', '/api/users', {
      name: 'Judge iPhone',
      appIds: [videoCutAppId, 'app_basic_chat'],
      defaultAppId: videoCutAppId,
      language: 'zh-CN',
      folder: repoRoot,
      tool: 'fake-codex',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(createUser.status, 201, 'owner should be able to create a managed user');
    assert.match(createUser.json?.user?.id || '', /^user_[a-f0-9]{24}$/);
    assert.equal(createUser.json?.user?.name, 'Judge iPhone');
    assert.deepEqual(createUser.json?.user?.appIds, [videoCutAppId, 'app_basic_chat']);
    assert.equal(createUser.json?.user?.defaultAppId, videoCutAppId);
    assert.equal(createUser.json?.user?.language, 'zh-CN');
    assert.ok(createUser.json?.session?.id, 'creating a user should auto-seed a starter session');
    assert.equal(createUser.json?.session?.userId, createUser.json?.user?.id, 'starter session should bind to the new user');
    assert.equal(createUser.json?.session?.userName, 'Judge iPhone', 'starter session should inherit the user name');
    assert.equal(createUser.json?.session?.appId, videoCutAppId, 'starter session should use the default app');
    assert.equal(createUser.json?.session?.sourceId, 'chat', 'starter session should be categorized as chat UI');

    const seededEvents = await request(port, 'GET', `/api/sessions/${createUser.json.session.id}/events`, null, {
      Cookie: ownerCookie,
    });
    assert.equal(seededEvents.status, 200, 'seeded user session events should load');
    const welcomeEvent = (seededEvents.json?.events || []).find((event) => event.type === 'message' && event.role === 'assistant');
    assert.ok(welcomeEvent, 'seeded user session should include the app welcome message');
    const welcomeContent = await resolveEventContent(
      port,
      createUser.json.session.id,
      welcomeEvent,
      { Cookie: ownerCookie },
    );
    assert.match(welcomeContent, /请上传一段原始视频/u, 'seeded session should use the selected app onboarding copy');

    const listedUsers = await request(port, 'GET', '/api/users', null, {
      Cookie: ownerCookie,
    });
    assert.equal(listedUsers.status, 200, 'users should remain listable after creation');
    assert.equal((listedUsers.json?.users || []).length, 1, 'created user should appear in the listing');
    assert.equal(listedUsers.json?.users?.[0]?.id, createUser.json?.user?.id);
    assert.equal(listedUsers.json?.users?.[0]?.language, 'zh-CN');

    const allSessions = await request(port, 'GET', '/api/sessions?includeVisitor=1', null, {
      Cookie: ownerCookie,
    });
    assert.equal(allSessions.status, 200, 'owner should be able to list all sessions');
    const seededSession = (allSessions.json?.sessions || []).find((session) => session.id === createUser.json?.session?.id);
    assert.ok(seededSession, 'seeded user session should appear in the owner session list');
    assert.equal(seededSession.userId, createUser.json?.user?.id);
    assert.equal(seededSession.userName, 'Judge iPhone');
    assert.equal(seededSession.appId, videoCutAppId);

    const updatedUser = await request(port, 'PATCH', `/api/users/${createUser.json.user.id}`, {
      name: 'Judge iPhone 2',
      appIds: ['app_basic_chat'],
      defaultAppId: 'app_basic_chat',
      language: 'en',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(updatedUser.status, 200, 'owner should be able to update a managed user');
    assert.equal(updatedUser.json?.user?.name, 'Judge iPhone 2');
    assert.deepEqual(updatedUser.json?.user?.appIds, ['app_basic_chat']);
    assert.equal(updatedUser.json?.user?.defaultAppId, 'app_basic_chat');
    assert.equal(updatedUser.json?.user?.language, 'en');

    const visitorCreate = await request(port, 'POST', '/api/visitors', {
      name: 'Judge iPhone 2',
      appId: videoCutAppId,
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(visitorCreate.status, 201, 'owner should be able to create a visitor share link');
    assert.ok(visitorCreate.json?.visitor?.id, 'visitor share link should include an id');

    const userSharePatch = await request(port, 'PATCH', `/api/users/${createUser.json.user.id}`, {
      shareVisitorId: visitorCreate.json.visitor.id,
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(userSharePatch.status, 200, 'owner should be able to attach a share visitor to a user');
    assert.equal(userSharePatch.json?.user?.shareVisitorId, visitorCreate.json.visitor.id);

    const blockedSession = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Blocked Video Cut Session',
      userId: createUser.json.user.id,
      appId: videoCutAppId,
      sourceId: 'chat',
      sourceName: 'Chat',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(blockedSession.status, 400, 'user should not be able to create sessions for disallowed apps');
    assert.equal(blockedSession.json?.error, 'Selected app is not allowed for this user');

    const allowedSession = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Basic Chat Follow-up',
      userId: createUser.json.user.id,
      sourceId: 'chat',
      sourceName: 'Chat',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(allowedSession.status, 201, 'user should still be able to create sessions for allowed apps');
    assert.equal(allowedSession.json?.session?.userId, createUser.json.user.id);
    assert.equal(allowedSession.json?.session?.userName, 'Judge iPhone 2');
    assert.equal(allowedSession.json?.session?.appId, 'app_basic_chat', 'missing appId should fall back to the user default');

    const deleteUser = await request(port, 'DELETE', `/api/users/${createUser.json.user.id}`, null, {
      Cookie: ownerCookie,
    });
    assert.equal(deleteUser.status, 200, 'owner should be able to delete a managed user');

    const visitorListAfterDelete = await request(port, 'GET', '/api/visitors', null, {
      Cookie: ownerCookie,
    });
    assert.equal(visitorListAfterDelete.status, 200, 'owner should still be able to list visitors after deleting a user');
    assert.equal(
      (visitorListAfterDelete.json?.visitors || []).some((visitor) => visitor.id === visitorCreate.json?.visitor?.id),
      false,
      'deleting a user should also clean up its linked share visitor',
    );

    const finalUsers = await request(port, 'GET', '/api/users', null, {
      Cookie: ownerCookie,
    });
    assert.equal(finalUsers.status, 200);
    assert.deepEqual(finalUsers.json?.users || [], [], 'deleted users should disappear from the active listing');

    console.log('test-http-users: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
