import { dirname } from 'path';
import { CHAT_BOARD_LAYOUT_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import { normalizeSessionWorkflowPriority } from './session-workflow-state.mjs';

const DEFAULT_BOARD_COLUMN_KEY = 'unassigned';
const DEFAULT_BOARD_COLUMN_LABEL = 'Unassigned';
const DEFAULT_BOARD_COLUMN_DESCRIPTION = 'Sessions that are not yet arranged on the board.';

let boardLayoutCache = null;
let boardLayoutCacheMtimeMs = null;
const runBoardLayoutMutation = createSerialTaskQueue();

function normalizeInlineText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
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

function normalizeStoredBoardLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return { layout: null, changed: true };
  }

  const columns = [];
  const columnMeta = new Map();
  const seenColumnKeys = new Set();
  const derivedColumns = [];
  const rawColumns = Array.isArray(layout.columns) ? layout.columns : [];
  const rawPlacements = Array.isArray(layout.placements) ? layout.placements : [];

  for (const entry of rawColumns) {
    if (!entry || typeof entry !== 'object') continue;
    const key = normalizeBoardColumnKey(entry.key || entry.label);
    const label = normalizeInlineText(entry.label || entry.key || '');
    if (!key || !label || seenColumnKeys.has(key)) continue;
    const column = {
      key,
      label,
      order: normalizeInteger(entry.order, columns.length * 10),
    };
    const description = normalizeInlineText(entry.description || entry.title || '');
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
    const label = normalizeInlineText(entry.columnLabel || entry.label || entry.columnKey || '');
    if (!key || !label || seenColumnKeys.has(key)) continue;
    derivedColumns.push({
      key,
      label,
      order: normalizeInteger(entry.columnOrder, (columns.length + derivedColumns.length) * 10),
    });
    seenColumnKeys.add(key);
  }

  for (const column of derivedColumns) {
    columns.push(column);
    columnMeta.set(column.key, column);
  }

  const placements = [];
  const seenSessionIds = new Set();

  for (const entry of rawPlacements) {
    if (!entry || typeof entry !== 'object') continue;
    const sessionId = normalizeInlineText(entry.sessionId);
    if (!sessionId || seenSessionIds.has(sessionId)) continue;

    const requestedColumnKey = normalizeBoardColumnKey(entry.columnKey || entry.columnLabel || entry.label || '');
    let columnKey = requestedColumnKey;
    if (!columnKey || !columnMeta.has(columnKey)) {
      columnKey = columns[0]?.key || DEFAULT_BOARD_COLUMN_KEY;
    }

    if (!columnMeta.has(columnKey)) {
      const fallbackColumn = {
        key: DEFAULT_BOARD_COLUMN_KEY,
        label: DEFAULT_BOARD_COLUMN_LABEL,
        order: 9999,
        description: DEFAULT_BOARD_COLUMN_DESCRIPTION,
      };
      columns.push(fallbackColumn);
      columnMeta.set(fallbackColumn.key, fallbackColumn);
    }

    const column = columnMeta.get(columnKey) || columnMeta.get(DEFAULT_BOARD_COLUMN_KEY);
    placements.push({
      sessionId,
      columnKey: column.key,
      columnLabel: column.label,
      columnOrder: normalizeInteger(column.order, 9999),
      order: normalizeInteger(entry.order ?? entry.rank, placements.length * 10),
      priority: normalizeSessionWorkflowPriority(entry.priority || ''),
      ...(normalizeInlineText(entry.reason) ? { reason: normalizeInlineText(entry.reason) } : {}),
    });
    seenSessionIds.add(sessionId);
  }

  columns.sort((a, b) => (
    normalizeInteger(a.order, 9999) - normalizeInteger(b.order, 9999)
    || a.label.localeCompare(b.label)
  ));

  const normalized = {
    updatedAt: normalizeInlineText(layout.updatedAt) || new Date().toISOString(),
    columns,
    placements,
  };

  const sourceSessionId = normalizeInlineText(layout.sourceSessionId);
  if (sourceSessionId) {
    normalized.sourceSessionId = sourceSessionId;
  }

  return {
    layout: normalized,
    changed: JSON.stringify(layout) !== JSON.stringify(normalized),
  };
}

function normalizeBoardLayoutForSessions(layout, sessionIds = []) {
  const result = normalizeStoredBoardLayout(layout || {});
  const normalized = result.layout || {
    updatedAt: new Date().toISOString(),
    columns: [],
    placements: [],
  };

  const activeSessionIds = Array.isArray(sessionIds)
    ? [...new Set(sessionIds.map((value) => normalizeInlineText(value)).filter(Boolean))]
    : [];
  const placementsBySessionId = new Map(
    (Array.isArray(normalized.placements) ? normalized.placements : [])
      .map((placement) => [placement.sessionId, placement])
  );

  if (activeSessionIds.length > 0) {
    const missingSessionIds = activeSessionIds.filter((sessionId) => !placementsBySessionId.has(sessionId));
    let fallbackColumn = normalized.columns.find((column) => column.key === DEFAULT_BOARD_COLUMN_KEY) || null;
    if (missingSessionIds.length > 0 && !fallbackColumn) {
      fallbackColumn = {
        key: DEFAULT_BOARD_COLUMN_KEY,
        label: DEFAULT_BOARD_COLUMN_LABEL,
        order: normalized.columns.length > 0
          ? Math.max(...normalized.columns.map((column) => normalizeInteger(column.order, 0))) + 10
          : 0,
        description: DEFAULT_BOARD_COLUMN_DESCRIPTION,
      };
      normalized.columns.push(fallbackColumn);
    }

    for (const sessionId of missingSessionIds) {
      normalized.placements.push({
        sessionId,
        columnKey: fallbackColumn.key,
        columnLabel: fallbackColumn.label,
        columnOrder: normalizeInteger(fallbackColumn.order, 9999),
        order: 9999,
        priority: '',
      });
    }

    normalized.placements = normalized.placements.filter((placement) => activeSessionIds.includes(placement.sessionId));
  }

  normalized.columns.sort((a, b) => (
    normalizeInteger(a.order, 9999) - normalizeInteger(b.order, 9999)
    || a.label.localeCompare(b.label)
  ));
  normalized.placements.sort((a, b) => (
    normalizeInteger(a.columnOrder, 9999) - normalizeInteger(b.columnOrder, 9999)
    || normalizeInteger(a.order, 9999) - normalizeInteger(b.order, 9999)
    || a.sessionId.localeCompare(b.sessionId)
  ));

  return normalized;
}

async function saveBoardLayoutUnlocked(layout) {
  const dir = dirname(CHAT_BOARD_LAYOUT_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(CHAT_BOARD_LAYOUT_FILE, layout);
  boardLayoutCache = layout;
  boardLayoutCacheMtimeMs = (await statOrNull(CHAT_BOARD_LAYOUT_FILE))?.mtimeMs ?? null;
}

export async function loadBoardLayout() {
  const stats = await statOrNull(CHAT_BOARD_LAYOUT_FILE);
  if (!stats) {
    boardLayoutCache = { updatedAt: '', columns: [], placements: [] };
    boardLayoutCacheMtimeMs = null;
    return clone(boardLayoutCache);
  }

  const mtimeMs = stats.mtimeMs;
  if (boardLayoutCache && boardLayoutCacheMtimeMs === mtimeMs) {
    return clone(boardLayoutCache);
  }

  const parsed = await readJson(CHAT_BOARD_LAYOUT_FILE, {});
  const normalized = normalizeStoredBoardLayout(parsed);
  boardLayoutCache = normalized.layout || { updatedAt: '', columns: [], placements: [] };
  if (normalized.changed) {
    await saveBoardLayoutUnlocked(boardLayoutCache);
  } else {
    boardLayoutCacheMtimeMs = mtimeMs;
  }
  return clone(boardLayoutCache);
}

export async function getBoardPlacement(sessionId) {
  const normalizedSessionId = normalizeInlineText(sessionId);
  if (!normalizedSessionId) return null;
  const layout = await loadBoardLayout();
  return clone(layout.placements.find((placement) => placement.sessionId === normalizedSessionId) || null);
}

export async function replaceBoardLayout(layout, { sessionIds = [], sourceSessionId = '' } = {}) {
  return runBoardLayoutMutation(async () => {
    const current = await loadBoardLayout();
    const nextLayout = normalizeBoardLayoutForSessions({
      ...(layout && typeof layout === 'object' && !Array.isArray(layout) ? layout : {}),
      sourceSessionId: normalizeInlineText(sourceSessionId) || normalizeInlineText(layout?.sourceSessionId) || current.sourceSessionId || '',
      updatedAt: new Date().toISOString(),
    }, sessionIds);

    const changed = JSON.stringify(current) !== JSON.stringify(nextLayout);
    if (changed) {
      await saveBoardLayoutUnlocked(nextLayout);
    }
    return { layout: clone(nextLayout), changed };
  });
}

export function summarizeBoardLayout(layout) {
  const normalized = normalizeBoardLayoutForSessions(layout, []);
  return {
    updatedAt: normalized.updatedAt || '',
    sourceSessionId: normalizeInlineText(normalized.sourceSessionId || ''),
    columns: normalized.columns.map((column) => ({ ...column })),
  };
}
