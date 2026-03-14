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
  return 40000 + Math.floor(Math.random() * 4000);
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

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-board-rebuild-'));
  const configDir = join(home, '.config', 'remotelab');
  const tempBin = join(home, 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(tempBin, { recursive: true });

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

  const fakeCodexPath = join(tempBin, 'fake-codex');
  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const uniqueIds = [...new Set(
  prompt
    .split('\\n')
    .filter((line) => line.startsWith('- id='))
    .map((line) => line.replace(/^- id=/, '').split('|')[0].trim())
    .filter(Boolean)
)];
const isBoardPrompt = prompt.includes('You are arranging the RemoteLab owner board for session work.');
const payload = isBoardPrompt
  ? JSON.stringify({
      columns: [
        { key: 'focus_now', label: 'Focus now', order: 10, description: 'Things the owner should look at first.' },
        { key: 'shared_tracks', label: 'Shared tracks', order: 20, description: 'Related work streams that can share a lane.' },
      ],
      placements: uniqueIds.map((sessionId, index) => ({
        sessionId,
        columnKey: index === 0 ? 'focus_now' : 'shared_tracks',
        order: (index + 1) * 10,
        priority: index === 0 ? 'high' : 'medium',
        reason: index === 0 ? 'Current anchor session deserves first attention.' : 'Related work can share a broader track.',
      })),
    })
  : JSON.stringify({ workflowState: 'parked', workflowPriority: 'medium', reason: 'default' });

console.log(JSON.stringify({ type: 'thread.started', thread_id: isBoardPrompt ? 'board-thread' : 'workflow-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
process.exit(0);
`,
    'utf8',
  );
  chmodSync(fakeCodexPath, 0o755);

  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify(
      [
        {
          id: 'fake-codex',
          name: 'Fake Codex',
          command: 'fake-codex',
          runtimeFamily: 'codex-json',
          models: [{ id: 'fake-model', label: 'Fake model' }],
          reasoning: {
            kind: 'enum',
            label: 'Reasoning',
            levels: ['low'],
            default: 'low',
          },
        },
      ],
      null,
      2,
    ),
    'utf8',
  );

  return { home, tempBin };
}

async function startServer({ home, tempBin, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${tempBin}:${process.env.PATH}`,
      CHAT_PORT: String(port),
      SECURE_COOKIES: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { logs += chunk.toString(); });
  child._testLogs = () => logs;

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

async function createSession(port, name, group, description) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group,
    description,
  });
  assert.equal(res.status, 201, 'session creation should succeed');
  return res.json.session;
}

try {
  const { home, tempBin } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, tempBin, port });

  try {
    const first = await createSession(port, 'Board anchor', 'RemoteLab', 'Primary board task');
    const second = await createSession(port, 'Follow-up', 'RemoteLab', 'Related work');
    const third = await createSession(port, 'Another stream', 'Ops', 'Infra follow-up');

    const rebuild = await request(port, 'POST', '/api/board/rebuild', { sessionId: first.id });
    assert.equal(rebuild.status, 200, 'board rebuild should succeed');
    assert.equal(rebuild.json?.ok, true, `board rebuild should report success: ${rebuild.text}\nlogs:\n${server._testLogs?.() || ''}`);
    assert.deepEqual(
      rebuild.json?.board?.columns?.map((column) => column.key),
      ['focus_now', 'shared_tracks'],
      'board rebuild should persist the model-defined columns',
    );

    const list = await request(port, 'GET', '/api/sessions');
    assert.equal(list.status, 200, 'session listing should succeed after rebuild');
    assert.deepEqual(
      list.json?.board?.columns?.map((column) => column.key),
      ['focus_now', 'shared_tracks'],
      'session listing should expose the board layout summary',
    );

    const byId = new Map((list.json?.sessions || []).map((session) => [session.id, session]));
    assert.equal(byId.get(first.id)?.board?.columnKey, 'focus_now', 'anchor session should land in the focus column');
    assert.equal(byId.get(first.id)?.board?.priority, 'high', 'anchor session should keep the high priority placement');
    assert.equal(byId.get(second.id)?.board?.columnKey, 'shared_tracks', 'related work should reuse a shared track column');
    assert.equal(byId.get(third.id)?.board?.columnKey, 'shared_tracks', 'similar work should not splinter into duplicate columns');

    console.log('test-http-board-rebuild: ok');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
