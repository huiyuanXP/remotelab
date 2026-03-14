import { dirname } from 'path';
import { CHAT_TASK_BOARD_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import {
  normalizeSessionDescription,
  normalizeSessionGroup,
} from './session-naming.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';

const DEFAULT_TASK_BOARD_COLUMN_KEY = 'unassigned_tasks';
const DEFAULT_TASK_BOARD_COLUMN_LABEL = 'Unassigned tasks';
const DEFAULT_TASK_BOARD_COLUMN_DESCRIPTION = 'Tasks that are not yet arranged on the task board.';
const FALLBACK_TASK_TITLE = 'Untitled task';
const TASK_TITLE_MAX_CHARS = 80;
const TASK_PROJECT_LABEL_MAX_CHARS = 48;
const TASK_BOARD_SUMMARY_MAX_CHARS = 240;
const TASK_WORKING_SUMMARY_MAX_CHARS = 720;
const TASK_NEXT_ACTION_MAX_CHARS = 180;

let taskBoardCache = null;
let taskBoardCacheMtimeMs = null;
const runTaskBoardMutation = createSerialTaskQueue();

function normalizeInlineText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function normalizeTaskText(value, maxChars) {
  const normalized = normalizeInlineText(value);
  if (!normalized) return '';
  if (!Number.isInteger(maxChars) || maxChars <= 0) return normalized;
  return Array.from(normalized).slice(0, maxChars).join('');
}

function normalizeTaskId(value) {
  const text = normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || '';
}

function normalizeBoardColumnKey(value) {
  const text = normalizeInlineText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || '';
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function clone(value) {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value));
}

function getSessionSortTime(session) {
  const stamp = session?.lastEventAt || session?.updatedAt || session?.created || '';
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function normalizeTaskPriority(value, workflowState = '') {
  const explicit = normalizeSessionWorkflowPriority(value || '');
  if (explicit) return explicit;
  const normalizedState = normalizeSessionWorkflowState(workflowState || '');
  if (normalizedState === 'waiting_user') return 'high';
  if (normalizedState === 'done') return 'low';
  return 'medium';
}

function inferFallbackTaskNextAction(session) {
  const workflowState = normalizeSessionWorkflowState(session?.workflowState || '');
  const runState = typeof session?.activity?.run?.state === 'string'
    ? session.activity.run.state
    : '';
  const queuedCount = Number.isInteger(session?.activity?.queue?.count)
    ? session.activity.queue.count
    : 0;
  if (runState === 'running') {
    return 'Let the current run finish, then review whether follow-up is needed.';
  }
  if (queuedCount > 0) {
    return queuedCount === 1
      ? 'Wait for the queued follow-up to run, then review the latest result.'
      : 'Wait for the queued follow-ups to finish, then review the latest result.';
  }
  if (workflowState === 'waiting_user') {
    return 'Open the latest session and provide the missing input or approval.';
  }
  if (workflowState === 'done') {
    return 'Review only if you want another iteration or follow-up change.';
  }
  return 'Open the latest session and decide the next concrete step.';
}

function deriveFallbackProjectLabel(session) {
  const group = normalizeSessionGroup(session?.group || '');
  if (group) return group;
  const appName = normalizeTaskText(session?.appName || '', TASK_PROJECT_LABEL_MAX_CHARS);
  if (appName) return appName;
  const sourceName = normalizeTaskText(session?.sourceName || '', TASK_PROJECT_LABEL_MAX_CHARS);
  if (sourceName) return sourceName;
  return '';
}

function buildFallbackTaskTitle(session) {
  const currentName = normalizeTaskText(session?.name || '', TASK_TITLE_MAX_CHARS);
  if (currentName) return currentName;
  const description = normalizeSessionDescription(session?.description || '');
  if (description) {
    return normalizeTaskText(description, TASK_TITLE_MAX_CHARS);
  }
  return FALLBACK_TASK_TITLE;
}

function buildFallbackTaskFromSessions(taskId, sessions = []) {
  const sortedSessions = [...sessions]
    .filter((session) => session?.id)
    .sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a));
  const anchor = sortedSessions[0] || null;
  const projectLabel = deriveFallbackProjectLabel(anchor);
  const description = normalizeSessionDescription(anchor?.description || '');
  const workflowState = normalizeSessionWorkflowState(anchor?.workflowState || '');
  const priority = normalizeTaskPriority(anchor?.workflowPriority || '', workflowState);
  return {
    id: normalizeTaskId(taskId) || `task_${Date.now().toString(36)}`,
    title: buildFallbackTaskTitle(anchor),
    ...(projectLabel ? { projectLabel } : {}),
    ...(description ? { boardSummary: normalizeTaskText(description, TASK_BOARD_SUMMARY_MAX_CHARS) } : {}),
    ...(description ? { workingSummary: normalizeTaskText(description, TASK_WORKING_SUMMARY_MAX_CHARS) } : {}),
    nextAction: normalizeTaskText(inferFallbackTaskNextAction(anchor), TASK_NEXT_ACTION_MAX_CHARS),
    priority,
    updatedAt: normalizeInlineText(anchor?.lastEventAt || anchor?.updatedAt || anchor?.created || ''),
  };
}

function ensureFallbackTaskId(sessionId, seenTaskIds) {
  const base = normalizeTaskId(`session_${sessionId}`) || `session_${Date.now().toString(36)}`;
  if (!seenTaskIds.has(base)) return base;
  let index = 2;
  while (seenTaskIds.has(`${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}

function normalizeStoredTaskBoardState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { state: null, changed: true };
  }

  const columns = [];
  const columnMeta = new Map();
  const seenColumnKeys = new Set();
  const rawColumns = Array.isArray(state.columns) ? state.columns : [];
  const rawTasks = Array.isArray(state.tasks) ? state.tasks : [];
  const rawAssignments = Array.isArray(state.assignments) ? state.assignments : [];
  const rawPlacements = Array.isArray(state.placements) ? state.placements : [];

  for (const entry of rawColumns) {
    if (!entry || typeof entry !== 'object') continue;
    const key = normalizeBoardColumnKey(entry.key || entry.label);
    const label = normalizeTaskText(entry.label || entry.key || '', TASK_TITLE_MAX_CHARS);
    if (!key || !label || seenColumnKeys.has(key)) continue;
    const column = {
      key,
      label,
      order: normalizeInteger(entry.order, columns.length * 10),
    };
    const description = normalizeTaskText(entry.description || entry.title || '', TASK_BOARD_SUMMARY_MAX_CHARS);
    if (description) {
      column.description = description;
    }
    columns.push(column);
    columnMeta.set(key, column);
    seenColumnKeys.add(key);
  }

  for (const entry of rawPlacements) {
    if (!entry || typeof entry !== 'object') continue;
    const key = normalizeBoardColumnKey(entry.columnKey || entry.columnLabel || entry.label || '');
    const label = normalizeTaskText(entry.columnLabel || entry.label || entry.columnKey || '', TASK_TITLE_MAX_CHARS);
    if (!key || !label || seenColumnKeys.has(key)) continue;
    const column = {
      key,
      label,
      order: normalizeInteger(entry.columnOrder, (columns.length * 10) + 10),
    };
    columns.push(column);
    columnMeta.set(key, column);
    seenColumnKeys.add(key);
  }

  const tasks = [];
  const taskMeta = new Map();
  const seenTaskIds = new Set();

  for (const entry of rawTasks) {
    if (!entry || typeof entry !== 'object') continue;
    const taskId = normalizeTaskId(entry.id || entry.taskId || entry.title);
    if (!taskId || seenTaskIds.has(taskId)) continue;
    const title = normalizeTaskText(entry.title || entry.name || entry.id || '', TASK_TITLE_MAX_CHARS);
    if (!title) continue;
    const task = {
      id: taskId,
      title,
      priority: normalizeTaskPriority(entry.priority || entry.workflowPriority || ''),
    };
    const projectLabel = normalizeTaskText(entry.projectLabel || entry.project || entry.group || '', TASK_PROJECT_LABEL_MAX_CHARS);
    const boardSummary = normalizeTaskText(entry.boardSummary || entry.summary || entry.description || '', TASK_BOARD_SUMMARY_MAX_CHARS);
    const workingSummary = normalizeTaskText(entry.workingSummary || entry.detailSummary || '', TASK_WORKING_SUMMARY_MAX_CHARS);
    const nextAction = normalizeTaskText(entry.nextAction || entry.next || '', TASK_NEXT_ACTION_MAX_CHARS);
    const updatedAt = normalizeInlineText(entry.updatedAt || '');
    if (projectLabel) task.projectLabel = projectLabel;
    if (boardSummary) task.boardSummary = boardSummary;
    if (workingSummary) task.workingSummary = workingSummary;
    if (nextAction) task.nextAction = nextAction;
    if (updatedAt) task.updatedAt = updatedAt;
    tasks.push(task);
    taskMeta.set(taskId, task);
    seenTaskIds.add(taskId);
  }

  const assignments = [];
  const seenSessionIds = new Set();
  for (const entry of rawAssignments) {
    if (!entry || typeof entry !== 'object') continue;
    const sessionId = normalizeInlineText(entry.sessionId);
    const taskId = normalizeTaskId(entry.taskId || entry.id || entry.task);
    if (!sessionId || !taskId || seenSessionIds.has(sessionId)) continue;
    assignments.push({
      sessionId,
      taskId,
    });
    seenSessionIds.add(sessionId);
  }

  const placements = [];
  const seenPlacementTaskIds = new Set();
  for (const entry of rawPlacements) {
    if (!entry || typeof entry !== 'object') continue;
    const taskId = normalizeTaskId(entry.taskId || entry.id || entry.task);
    if (!taskId || seenPlacementTaskIds.has(taskId)) continue;

    const requestedColumnKey = normalizeBoardColumnKey(entry.columnKey || entry.columnLabel || entry.label || '');
    let columnKey = requestedColumnKey;
    if (!columnKey || !columnMeta.has(columnKey)) {
      columnKey = columns[0]?.key || DEFAULT_TASK_BOARD_COLUMN_KEY;
    }
    if (!columnMeta.has(columnKey)) {
      const fallbackColumn = {
        key: DEFAULT_TASK_BOARD_COLUMN_KEY,
        label: DEFAULT_TASK_BOARD_COLUMN_LABEL,
        order: 9999,
        description: DEFAULT_TASK_BOARD_COLUMN_DESCRIPTION,
      };
      columns.push(fallbackColumn);
      columnMeta.set(fallbackColumn.key, fallbackColumn);
    }
    const column = columnMeta.get(columnKey) || columnMeta.get(DEFAULT_TASK_BOARD_COLUMN_KEY);
    placements.push({
      taskId,
      columnKey: column.key,
      columnLabel: column.label,
      columnOrder: normalizeInteger(column.order, 9999),
      order: normalizeInteger(entry.order ?? entry.rank, placements.length * 10),
      priority: normalizeTaskPriority(entry.priority || ''),
      ...(normalizeTaskText(entry.reason || '', TASK_NEXT_ACTION_MAX_CHARS) ? { reason: normalizeTaskText(entry.reason || '', TASK_NEXT_ACTION_MAX_CHARS) } : {}),
    });
    seenPlacementTaskIds.add(taskId);
  }

  columns.sort((a, b) => (
    normalizeInteger(a.order, 9999) - normalizeInteger(b.order, 9999)
    || a.label.localeCompare(b.label)
  ));

  const normalized = {
    updatedAt: normalizeInlineText(state.updatedAt) || new Date().toISOString(),
    columns,
    tasks,
    assignments,
    placements,
  };

  const sourceSessionId = normalizeInlineText(state.sourceSessionId);
  if (sourceSessionId) {
    normalized.sourceSessionId = sourceSessionId;
  }

  return {
    state: normalized,
    changed: JSON.stringify(state) !== JSON.stringify(normalized),
  };
}

export function normalizeTaskBoardStateForSessions(state, sessions = []) {
  const result = normalizeStoredTaskBoardState(state || {});
  const normalized = result.state || {
    updatedAt: new Date().toISOString(),
    columns: [],
    tasks: [],
    assignments: [],
    placements: [],
  };

  const activeSessions = Array.isArray(sessions)
    ? sessions.filter((session) => session?.id)
    : [];
  const sessionIds = [...new Set(activeSessions.map((session) => normalizeInlineText(session.id)).filter(Boolean))];
  const sessionById = new Map(activeSessions.map((session) => [session.id, session]));

  normalized.assignments = normalized.assignments.filter((assignment) => sessionIds.includes(assignment.sessionId));

  const assignmentsBySessionId = new Map(normalized.assignments.map((assignment) => [assignment.sessionId, assignment]));
  const sessionsByTaskId = new Map();
  const taskMeta = new Map(normalized.tasks.map((task) => [task.id, task]));
  const seenTaskIds = new Set(normalized.tasks.map((task) => task.id));

  for (const assignment of normalized.assignments) {
    const session = sessionById.get(assignment.sessionId);
    if (!session) continue;
    const bucket = sessionsByTaskId.get(assignment.taskId) || [];
    bucket.push(session);
    sessionsByTaskId.set(assignment.taskId, bucket);
  }

  for (const sessionId of sessionIds) {
    if (assignmentsBySessionId.has(sessionId)) continue;
    const session = sessionById.get(sessionId);
    const fallbackTaskId = ensureFallbackTaskId(sessionId, seenTaskIds);
    seenTaskIds.add(fallbackTaskId);
    const fallbackTask = buildFallbackTaskFromSessions(fallbackTaskId, [session]);
    normalized.tasks.push(fallbackTask);
    taskMeta.set(fallbackTaskId, fallbackTask);
    normalized.assignments.push({ sessionId, taskId: fallbackTaskId });
    assignmentsBySessionId.set(sessionId, { sessionId, taskId: fallbackTaskId });
    sessionsByTaskId.set(fallbackTaskId, [session]);
  }

  for (const [taskId, groupedSessions] of sessionsByTaskId.entries()) {
    if (taskMeta.has(taskId)) continue;
    const fallbackTask = buildFallbackTaskFromSessions(taskId, groupedSessions);
    normalized.tasks.push(fallbackTask);
    taskMeta.set(taskId, fallbackTask);
    seenTaskIds.add(taskId);
  }

  const referencedTaskIds = new Set(normalized.assignments.map((assignment) => assignment.taskId));
  normalized.tasks = normalized.tasks
    .filter((task) => referencedTaskIds.has(task.id))
    .map((task) => {
      const groupedSessions = sessionsByTaskId.get(task.id) || [];
      const latestSession = [...groupedSessions].sort((a, b) => getSessionSortTime(b) - getSessionSortTime(a))[0] || null;
      return {
        ...task,
        priority: normalizeTaskPriority(task.priority || latestSession?.workflowPriority || '', latestSession?.workflowState || ''),
        updatedAt: normalizeInlineText(task.updatedAt || latestSession?.lastEventAt || latestSession?.updatedAt || latestSession?.created || ''),
      };
    });
  taskMeta.clear();
  for (const task of normalized.tasks) {
    taskMeta.set(task.id, task);
  }

  normalized.placements = normalized.placements.filter((placement) => referencedTaskIds.has(placement.taskId));
  const placementsByTaskId = new Map(normalized.placements.map((placement) => [placement.taskId, placement]));
  const missingTaskIds = normalized.tasks
    .map((task) => task.id)
    .filter((taskId) => !placementsByTaskId.has(taskId));
  let fallbackColumn = normalized.columns.find((column) => column.key === DEFAULT_TASK_BOARD_COLUMN_KEY) || null;
  if (missingTaskIds.length > 0 && !fallbackColumn) {
    fallbackColumn = {
      key: DEFAULT_TASK_BOARD_COLUMN_KEY,
      label: DEFAULT_TASK_BOARD_COLUMN_LABEL,
      order: normalized.columns.length > 0
        ? Math.max(...normalized.columns.map((column) => normalizeInteger(column.order, 0))) + 10
        : 0,
      description: DEFAULT_TASK_BOARD_COLUMN_DESCRIPTION,
    };
    normalized.columns.push(fallbackColumn);
  }

  for (const taskId of missingTaskIds) {
    const task = taskMeta.get(taskId);
    normalized.placements.push({
      taskId,
      columnKey: fallbackColumn.key,
      columnLabel: fallbackColumn.label,
      columnOrder: normalizeInteger(fallbackColumn.order, 9999),
      order: 9999,
      priority: normalizeTaskPriority(task?.priority || ''),
    });
  }

  normalized.columns.sort((a, b) => (
    normalizeInteger(a.order, 9999) - normalizeInteger(b.order, 9999)
    || a.label.localeCompare(b.label)
  ));
  normalized.placements.sort((a, b) => (
    normalizeInteger(a.columnOrder, 9999) - normalizeInteger(b.columnOrder, 9999)
    || normalizeInteger(a.order, 9999) - normalizeInteger(b.order, 9999)
    || a.taskId.localeCompare(b.taskId)
  ));
  normalized.assignments.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  return normalized;
}

async function saveTaskBoardUnlocked(state) {
  const dir = dirname(CHAT_TASK_BOARD_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(CHAT_TASK_BOARD_FILE, state);
  taskBoardCache = state;
  taskBoardCacheMtimeMs = (await statOrNull(CHAT_TASK_BOARD_FILE))?.mtimeMs ?? null;
}

export async function loadTaskBoardState() {
  const stats = await statOrNull(CHAT_TASK_BOARD_FILE);
  if (!stats) {
    taskBoardCache = {
      updatedAt: '',
      columns: [],
      tasks: [],
      assignments: [],
      placements: [],
    };
    taskBoardCacheMtimeMs = null;
    return clone(taskBoardCache);
  }

  const mtimeMs = stats.mtimeMs;
  if (taskBoardCache && taskBoardCacheMtimeMs === mtimeMs) {
    return clone(taskBoardCache);
  }

  const parsed = await readJson(CHAT_TASK_BOARD_FILE, {});
  const normalized = normalizeStoredTaskBoardState(parsed);
  taskBoardCache = normalized.state || {
    updatedAt: '',
    columns: [],
    tasks: [],
    assignments: [],
    placements: [],
  };
  if (normalized.changed) {
    await saveTaskBoardUnlocked(taskBoardCache);
  } else {
    taskBoardCacheMtimeMs = mtimeMs;
  }
  return clone(taskBoardCache);
}

export async function getTaskBoardStateForSessions(sessions = []) {
  return normalizeTaskBoardStateForSessions(await loadTaskBoardState(), sessions);
}

export async function replaceTaskBoardState(state, { sessions = [], sourceSessionId = '' } = {}) {
  return runTaskBoardMutation(async () => {
    const current = normalizeTaskBoardStateForSessions(await loadTaskBoardState(), sessions);
    const nextState = normalizeTaskBoardStateForSessions({
      ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}),
      sourceSessionId: normalizeInlineText(sourceSessionId) || normalizeInlineText(state?.sourceSessionId) || normalizeInlineText(current.sourceSessionId || ''),
      updatedAt: new Date().toISOString(),
    }, sessions);

    const changed = JSON.stringify(current) !== JSON.stringify(nextState);
    if (changed) {
      await saveTaskBoardUnlocked(nextState);
    }
    return { state: clone(nextState), changed };
  });
}

export function summarizeTaskBoardState(state) {
  return clone(state || {
    updatedAt: '',
    columns: [],
    tasks: [],
    assignments: [],
    placements: [],
  });
}

export function getTaskForSession(state, sessionId) {
  const normalizedSessionId = normalizeInlineText(sessionId);
  if (!normalizedSessionId || !state || typeof state !== 'object') return null;
  const assignments = Array.isArray(state.assignments) ? state.assignments : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const placements = Array.isArray(state.placements) ? state.placements : [];
  const assignment = assignments.find((entry) => entry.sessionId === normalizedSessionId);
  if (!assignment?.taskId) return null;
  const task = tasks.find((entry) => entry.id === assignment.taskId);
  if (!task) return null;
  const placement = placements.find((entry) => entry.taskId === task.id) || null;
  const sessionCount = assignments.filter((entry) => entry.taskId === task.id).length;
  return clone({
    ...task,
    ...(placement ? placement : {}),
    sessionCount,
  });
}
