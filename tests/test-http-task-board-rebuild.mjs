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
  return 44000 + Math.floor(Math.random() * 4000);
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
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-task-board-rebuild-'));
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
const isTaskBoardPrompt = prompt.includes('You are arranging the RemoteLab owner task board above sessions.');
const isSessionBoardPrompt = prompt.includes('You are arranging the RemoteLab owner board for session work.');

let payload = JSON.stringify({ workflowState: 'parked', workflowPriority: 'medium', reason: 'default' });
if (isTaskBoardPrompt) {
  payload = JSON.stringify({
    columns: [
      { key: 'focus_now', label: 'Focus now', order: 10, description: 'Most important tasks to check first.' },
      { key: 'background_done', label: 'Background & done', order: 20, description: 'Tasks that can wait.' },
    ],
    tasks: uniqueIds.map((sessionId, index) => ({
      id: index === 0 ? 'task_focus_now' : 'task_' + (index + 1),
      title: index === 0 ? 'Ship task board MVP' : 'Related stream ' + index,
      projectLabel: 'RemoteLab',
      boardSummary: index === 0 ? 'The task-board layer is the new main attention surface.' : 'This work can stay in the background for now.',
      workingSummary: index === 0 ? 'Progress is active and the owner should inspect this first.' : 'This task exists, but it does not need immediate action.',
      nextAction: index === 0 ? 'Review the task detail and decide whether to continue implementation.' : 'Leave this task parked until the focus task settles.',
      priority: index === 0 ? 'high' : 'low',
    })),
    assignments: uniqueIds.map((sessionId, index) => ({
      sessionId,
      taskId: index === 0 ? 'task_focus_now' : 'task_' + (index + 1),
    })),
    placements: uniqueIds.map((sessionId, index) => ({
      taskId: index === 0 ? 'task_focus_now' : 'task_' + (index + 1),
      columnKey: index === 0 ? 'focus_now' : 'background_done',
      order: (index + 1) * 10,
      priority: index === 0 ? 'high' : 'low',
      reason: index === 0 ? 'This is the most important task to inspect.' : 'This task can stay in the background.',
    })),
  });
} else if (isSessionBoardPrompt) {
  payload = JSON.stringify({
    columns: [
      { key: 'active_work', label: 'Active work', order: 10, description: 'Current sessions in motion.' },
    ],
    placements: uniqueIds.map((sessionId, index) => ({
      sessionId,
      columnKey: 'active_work',
      order: (index + 1) * 10,
      priority: index === 0 ? 'high' : 'medium',
      reason: 'Keep the internal session board simple during tests.',
    })),
  });
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: isTaskBoardPrompt ? 'task-board-thread' : 'default-thread' }));
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

  await waitFor(async () => {
    const response = await request(port, 'GET', '/login').catch(() => null);
    return response?.status === 200;
  }, 'chat server start');

  return {
    child,
    getLogs() { return logs; },
  };
}

async function main() {
  const { home, tempBin } = setupTempHome();
  const port = randomPort();
  let server = null;

  try {
    server = await startServer({ home, tempBin, port });

    const first = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'fake-codex',
      name: 'Task board focus session',
      group: 'RemoteLab',
      description: 'Build the higher-level task board.',
    });
    assert.equal(first.status, 201, `expected first session creation to succeed: ${first.text}`);

    const second = await request(port, 'POST', '/api/sessions', {
      folder: home,
      tool: 'fake-codex',
      name: 'Task board background session',
      group: 'RemoteLab',
      description: 'Background cleanup work.',
    });
    assert.equal(second.status, 201, `expected second session creation to succeed: ${second.text}`);

    const rebuild = await request(port, 'POST', '/api/task-board/rebuild', {});
    assert.equal(rebuild.status, 200, `expected task board rebuild to succeed: ${rebuild.text}`);
    assert.equal(rebuild.json?.ok, true, 'task board rebuild should report success');
    assert.equal(rebuild.json?.taskBoard?.columns?.[0]?.key, 'focus_now');
    assert.ok(Array.isArray(rebuild.json?.taskBoard?.tasks), 'task board rebuild should return tasks');
    assert.equal(rebuild.json?.taskBoard?.tasks?.[0]?.title, 'Ship task board MVP');

    const taskBoard = await request(port, 'GET', '/api/task-board');
    assert.equal(taskBoard.status, 200, `expected task board endpoint to succeed: ${taskBoard.text}`);
    assert.equal(taskBoard.json?.taskBoard?.columns?.[0]?.key, 'focus_now');

    const sessionList = await request(port, 'GET', '/api/sessions?includeVisitor=1');
    assert.equal(sessionList.status, 200, `expected session list to succeed: ${sessionList.text}`);
    assert.ok(Array.isArray(sessionList.json?.taskBoard?.tasks), 'session list payload should include task board');
    assert.ok(
      sessionList.json?.sessions?.every((session) => session?.task?.id && session?.task?.title),
      'every session should carry its resolved task metadata after rebuild',
    );
  } finally {
    server?.child?.kill('SIGTERM');
    await sleep(200);
    rmSync(home, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('test-http-task-board-rebuild: ok');
}).catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
