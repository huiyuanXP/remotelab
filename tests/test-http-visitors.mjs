#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const ownerCookie = 'session_token=test-owner-session';

function randomPort() {
  return 40500 + Math.floor(Math.random() * 5000);
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

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-visitors-'));
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

    const createVisitorResponse = await request(port, 'POST', '/api/visitors', {
      name: 'Judge iPhone',
      appId: videoCutAppId,
      language: 'zh-CN',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(createVisitorResponse.status, 201, 'owner should be able to create a visitor preset');
    assert.match(createVisitorResponse.json?.visitor?.id || '', /^visitor_[a-f0-9]+$/);
    assert.match(createVisitorResponse.json?.visitor?.shareToken || '', /^visit_[a-f0-9]+$/);
    assert.equal(createVisitorResponse.json?.visitor?.language, 'zh-CN');

    const visitorListResponse = await request(port, 'GET', '/api/visitors', null, {
      Cookie: ownerCookie,
    });
    assert.equal(visitorListResponse.status, 200, 'owner should be able to list visitors');
    assert.equal(
      (visitorListResponse.json?.visitors || []).some((visitor) => visitor.name === 'Judge iPhone' && visitor.appId === videoCutAppId),
      true,
      'new visitor should appear in the visitor list with the assigned app',
    );

    const publicVisit = await request(port, 'GET', `/visitor/${createVisitorResponse.json.visitor.shareToken}`);
    assert.equal(publicVisit.status, 302, 'visitor link should bootstrap a visitor session');
    assert.equal(publicVisit.headers.location, '/?visitor=1');
    assert.ok(publicVisit.headers['set-cookie']?.length, 'visitor link should set a visitor cookie');

    const visitorCookie = publicVisit.headers['set-cookie'][0].split(';', 1)[0];
    const visitorAuth = await request(port, 'GET', '/api/auth/me', null, {
      Cookie: visitorCookie,
    });
    assert.equal(visitorAuth.status, 200, 'visitor auth should work after opening a visitor link');
    assert.equal(visitorAuth.json?.role, 'visitor');
    assert.equal(visitorAuth.json?.appId, videoCutAppId);
    assert.equal(visitorAuth.json?.visitorId, createVisitorResponse.json.visitor.id);
    assert.equal(visitorAuth.json?.preferredLanguage, 'zh-CN');

    const mixedCookie = `${ownerCookie}; ${visitorCookie}`;
    const mixedOwnerAuth = await request(port, 'GET', '/api/auth/me', null, {
      Cookie: mixedCookie,
    });
    assert.equal(mixedOwnerAuth.status, 200, 'default mixed-cookie auth should preserve the owner session');
    assert.equal(mixedOwnerAuth.json?.role, 'owner');

    const mixedVisitorAuth = await request(port, 'GET', '/api/auth/me?visitor=1', null, {
      Cookie: mixedCookie,
    });
    assert.equal(mixedVisitorAuth.status, 200, 'visitor-mode auth should prefer the visitor session when both cookies exist');
    assert.equal(mixedVisitorAuth.json?.role, 'visitor');
    assert.equal(mixedVisitorAuth.json?.visitorId, createVisitorResponse.json.visitor.id);

    const mixedVisitorApps = await request(port, 'GET', '/api/apps?visitor=1', null, {
      Cookie: mixedCookie,
    });
    assert.equal(mixedVisitorApps.status, 403, 'visitor-mode requests with mixed cookies should not inherit owner-only access');

    const wsMessages = [];
    const visitorSocket = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?visitor=1`, {
        headers: { Cookie: mixedCookie },
      });
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
      socket.on('message', (data) => {
        try {
          wsMessages.push(JSON.parse(data.toString()));
        } catch {}
      });
    });

    const ownerSessionCreate = await request(port, 'POST', '/api/sessions', {
      folder: repoRoot,
      tool: 'fake-codex',
      name: 'Owner-only broadcast check',
    }, {
      Cookie: ownerCookie,
    });
    assert.equal(ownerSessionCreate.status, 201, 'owner should still be able to create a normal session');
    await sleep(250);
    visitorSocket.close();
    assert.equal(
      wsMessages.some((message) => message.type === 'sessions_invalidated'),
      false,
      'visitor-mode websocket with mixed cookies should not subscribe as an owner client',
    );

    const ownerAllUsers = await request(port, 'GET', `/api/sessions?includeVisitor=1&appId=${videoCutAppId}`, null, {
      Cookie: ownerCookie,
    });
    assert.equal(ownerAllUsers.status, 200, 'owner should be able to list visitor sessions');
    const visitorSession = (ownerAllUsers.json?.sessions || []).find((session) => session.visitorId === createVisitorResponse.json.visitor.id);
    assert.ok(visitorSession, 'visitor session should appear in owner all-users view');
    assert.equal(visitorSession.visitorName, 'Judge iPhone', 'visitor session should preserve the visitor name for owner UI');
    assert.equal(visitorSession.appId, videoCutAppId, 'visitor session should stay inside the assigned app scope');

    const deleteVisitorResponse = await request(port, 'DELETE', `/api/visitors/${createVisitorResponse.json.visitor.id}`, null, {
      Cookie: ownerCookie,
    });
    assert.equal(deleteVisitorResponse.status, 200, 'owner should be able to delete a visitor preset');

    console.log('test-http-visitors: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
