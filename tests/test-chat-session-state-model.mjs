#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(
  join(repoRoot, 'static', 'chat', 'session-state-model.js'),
  'utf8',
);

const context = { console };
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, {
  filename: 'session-state-model.js',
});

const model = context.RemoteLabSessionStateModel;

assert.ok(model, 'session state model should attach to the global scope');

function makeActivity(overrides = {}) {
  return {
    run: {
      state: 'idle',
      phase: null,
      runId: null,
      cancelRequested: false,
      ...overrides.run,
    },
    queue: {
      state: 'idle',
      count: 0,
      ...overrides.queue,
    },
    rename: {
      state: 'idle',
      error: null,
      ...overrides.rename,
    },
    compact: {
      state: 'idle',
      ...overrides.compact,
    },
  };
}

function makeSession(overrides = {}) {
  return {
    id: 'session-test',
    activity: makeActivity(),
    ...overrides,
  };
}

const boardLayout = {
  columns: [
    { key: 'focus_now', label: 'Focus now', order: 10, description: 'Highest attention' },
    { key: 'shared_tracks', label: 'Shared tracks', order: 20, description: 'Grouped active work' },
  ],
};

const runningSession = makeSession({
  activity: makeActivity({
    run: { state: 'running', phase: 'accepted', runId: 'run-1' },
  }),
});
const runningStatus = model.getSessionStatusSummary(runningSession);
assert.equal(runningStatus.primary.key, 'running');
assert.equal(model.isSessionBusy(runningSession), true);

const queuedSession = makeSession({
  activity: makeActivity({
    queue: { state: 'queued', count: 2 },
  }),
});
const queuedStatus = model.getSessionStatusSummary(queuedSession);
assert.equal(queuedStatus.primary.key, 'queued');
assert.equal(queuedStatus.primary.title, '2 follow-ups queued');
assert.equal(model.isSessionBusy(queuedSession), true);

const compactingSession = makeSession({
  activity: makeActivity({
    compact: { state: 'pending' },
  }),
});
assert.equal(model.getSessionStatusSummary(compactingSession).primary.key, 'compacting');
assert.equal(model.isSessionBusy(compactingSession), true);

const renamingSession = makeSession({
  activity: makeActivity({
    rename: { state: 'pending', error: null },
  }),
});
assert.equal(model.getSessionStatusSummary(renamingSession).primary.key, 'renaming');
assert.equal(model.isSessionBusy(renamingSession), false);

const renameFailedSession = makeSession({
  activity: makeActivity({
    rename: { state: 'failed', error: 'rename crashed' },
  }),
});
const renameFailedStatus = model.getSessionStatusSummary(renameFailedSession);
assert.equal(renameFailedStatus.primary.key, 'rename-failed');
assert.equal(renameFailedStatus.primary.title, 'rename crashed');

assert.equal(
  JSON.stringify(Array.from(model.getBoardColumns(boardLayout), (column) => column.key)),
  JSON.stringify(['focus_now', 'shared_tracks']),
  'board columns should come from the model-defined layout in left-to-right order',
);

const fallbackBoardColumn = model.getSessionBoardColumn(makeSession(), null, []);
assert.equal(fallbackBoardColumn.key, 'unassigned');

const focusBoardColumn = model.getSessionBoardColumn(
  makeSession({
    board: {
      columnKey: 'focus_now',
      columnLabel: 'Focus now',
      columnOrder: 10,
      order: 20,
      priority: 'high',
    },
  }),
  boardLayout,
);
assert.equal(focusBoardColumn.key, 'focus_now');

assert.equal(model.normalizeSessionWorkflowPriority('P1'), 'high');
assert.equal(model.normalizeSessionWorkflowPriority('normal'), 'medium');
assert.equal(model.normalizeSessionWorkflowPriority('later'), 'low');

const explicitHighPriority = model.getSessionBoardPriority(
  makeSession({ board: { priority: 'urgent' } }),
);
assert.equal(explicitHighPriority.key, 'high');
assert.equal(explicitHighPriority.rank, 3);

const workflowPriorityFallback = model.getSessionBoardPriority(
  makeSession({ workflowPriority: 'done-later', board: {} }),
);
assert.equal(workflowPriorityFallback.key, 'medium', 'unknown priority strings should fall back to medium attention');

assert.ok(
  model.compareBoardSessions(
    makeSession({ board: { order: 10, priority: 'low' }, updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ board: { order: 20, priority: 'high' }, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) < 0,
  'explicit board order should sort sessions before priority and recency',
);

assert.ok(
  model.compareBoardSessions(
    makeSession({ board: { priority: 'high' }, updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ board: { priority: 'low' }, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) < 0,
  'higher board priority should sort before lower board priority when explicit order ties',
);

assert.ok(
  model.compareBoardSessions(
    makeSession({ board: { priority: 'medium' }, pinned: true, updatedAt: '2026-03-14T12:00:00.000Z' }),
    makeSession({ board: { priority: 'medium' }, updatedAt: '2026-03-14T13:00:00.000Z' }),
  ) < 0,
  'pinned sessions should break ties inside a board column',
);

const toolFallbackStatus = model.getSessionStatusSummary(
  makeSession({ tool: 'codex' }),
  { includeToolFallback: true },
);
assert.equal(toolFallbackStatus.primary.key, 'tool');
assert.equal(toolFallbackStatus.primary.label, 'codex');

const idleStatus = model.getSessionStatusSummary(makeSession());
assert.equal(idleStatus.primary.key, 'idle');
assert.equal(idleStatus.primary.label, 'idle');

console.log('test-chat-session-state-model: ok');
