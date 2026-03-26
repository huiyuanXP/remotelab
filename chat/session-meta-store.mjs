import { dirname } from 'path';
import { CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import {
  createSerialTaskQueue,
  ensureDir,
  readJson,
  statOrNull,
  writeJsonAtomic,
} from './fs-utils.mjs';
import {
  normalizeSessionWorkflowPriority,
  normalizeSessionWorkflowState,
} from './session-workflow-state.mjs';
import { normalizeSessionAgreements } from './session-agreements.mjs';
import { normalizeSessionEntryMode } from './session-entry-mode.mjs';
import { normalizeSessionTaskCard } from './session-task-card.mjs';
import { DEFAULT_APP_ID, getBuiltinApp, normalizeAppId } from './apps.mjs';

let sessionsMetaCache = null;
let sessionsMetaCacheMtimeMs = null;
const runSessionsMetaMutation = createSerialTaskQueue();

function normalizeStoredTimestamp(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function normalizeStoredSidebarOrder(value) {
  const parsed = typeof value === 'number'
    ? value
    : parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeStoredSessionSourceName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function isTemplateAppScopeId(appId) {
  const normalized = normalizeAppId(appId);
  return /^app[_-]/i.test(normalized);
}

function formatStoredSourceNameFromId(sourceId) {
  const normalized = typeof sourceId === 'string' ? sourceId.trim() : '';
  if (!normalized) return 'Chat';
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeStoredSessionSourceFields(normalized) {
  let changed = false;

  const explicitSourceId = normalizeAppId(normalized.sourceId);
  const legacyAppId = normalizeAppId(normalized.appId);
  const nextSourceId = explicitSourceId
    || (legacyAppId && !isTemplateAppScopeId(legacyAppId) ? legacyAppId : DEFAULT_APP_ID);

  if (normalized.sourceId !== nextSourceId) {
    normalized.sourceId = nextSourceId;
    changed = true;
  }

  const explicitSourceName = normalizeStoredSessionSourceName(normalized.sourceName);
  const legacyAppName = normalizeStoredSessionSourceName(normalized.appName);
  let nextSourceName = explicitSourceName;
  if (!nextSourceName && legacyAppName && legacyAppId && !isTemplateAppScopeId(legacyAppId) && legacyAppId === nextSourceId) {
    nextSourceName = legacyAppName;
  }
  if (!nextSourceName && nextSourceId !== DEFAULT_APP_ID) {
    const builtinSource = getBuiltinApp(nextSourceId);
    nextSourceName = builtinSource?.name || formatStoredSourceNameFromId(nextSourceId);
  }

  if (nextSourceName) {
    if (normalized.sourceName !== nextSourceName) {
      normalized.sourceName = nextSourceName;
      changed = true;
    }
  } else if (Object.prototype.hasOwnProperty.call(normalized, 'sourceName')) {
    delete normalized.sourceName;
    changed = true;
  }

  return changed;
}

function normalizeStoredSessionMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return { meta: null, changed: true };
  }

  const normalized = { ...meta };
  let changed = false;

  for (const legacyField of ['activeRun', 'status', 'queuedMessageCount', 'pendingCompact', 'renameState', 'renameError', 'recoverable']) {
    if (Object.prototype.hasOwnProperty.call(normalized, legacyField)) {
      delete normalized[legacyField];
      changed = true;
    }
  }

  changed = normalizeStoredSessionSourceFields(normalized) || changed;

  if (Object.prototype.hasOwnProperty.call(normalized, 'workflowState')) {
    const nextWorkflowState = normalizeSessionWorkflowState(normalized.workflowState || '');
    if (nextWorkflowState) {
      if (normalized.workflowState !== nextWorkflowState) {
        normalized.workflowState = nextWorkflowState;
        changed = true;
      }
    } else {
      delete normalized.workflowState;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'workflowPriority')) {
    const nextWorkflowPriority = normalizeSessionWorkflowPriority(normalized.workflowPriority || '');
    if (nextWorkflowPriority) {
      if (normalized.workflowPriority !== nextWorkflowPriority) {
        normalized.workflowPriority = nextWorkflowPriority;
        changed = true;
      }
    } else {
      delete normalized.workflowPriority;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'lastReviewedAt')) {
    const nextLastReviewedAt = normalizeStoredTimestamp(normalized.lastReviewedAt);
    if (nextLastReviewedAt) {
      if (normalized.lastReviewedAt !== nextLastReviewedAt) {
        normalized.lastReviewedAt = nextLastReviewedAt;
        changed = true;
      }
    } else {
      delete normalized.lastReviewedAt;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'sidebarOrder')) {
    const nextSidebarOrder = normalizeStoredSidebarOrder(normalized.sidebarOrder);
    if (nextSidebarOrder) {
      if (normalized.sidebarOrder !== nextSidebarOrder) {
        normalized.sidebarOrder = nextSidebarOrder;
        changed = true;
      }
    } else {
      delete normalized.sidebarOrder;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'entryMode')) {
    const nextEntryMode = normalizeSessionEntryMode(normalized.entryMode);
    if (nextEntryMode) {
      if (normalized.entryMode !== nextEntryMode) {
        normalized.entryMode = nextEntryMode;
        changed = true;
      }
    } else {
      delete normalized.entryMode;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'activeAgreements')) {
    const nextActiveAgreements = normalizeSessionAgreements(normalized.activeAgreements);
    if (nextActiveAgreements.length > 0) {
      if (JSON.stringify(normalized.activeAgreements) !== JSON.stringify(nextActiveAgreements)) {
        normalized.activeAgreements = nextActiveAgreements;
        changed = true;
      }
    } else {
      delete normalized.activeAgreements;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'taskCard')) {
    const nextTaskCard = normalizeSessionTaskCard(normalized.taskCard);
    if (nextTaskCard) {
      if (JSON.stringify(normalized.taskCard) !== JSON.stringify(nextTaskCard)) {
        normalized.taskCard = nextTaskCard;
        changed = true;
      }
    } else {
      delete normalized.taskCard;
      changed = true;
    }
  }

  return { meta: normalized, changed };
}

function normalizeStoredSessionsMeta(list) {
  let changed = false;
  const normalized = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const result = normalizeStoredSessionMeta(entry);
    if (!result.meta) {
      changed = true;
      continue;
    }
    normalized.push(result.meta);
    changed = changed || result.changed;
  }
  return { list: normalized, changed };
}

async function saveSessionsMetaUnlocked(list) {
  const dir = dirname(CHAT_SESSIONS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(CHAT_SESSIONS_FILE, list);
  sessionsMetaCache = list;
  sessionsMetaCacheMtimeMs = (await statOrNull(CHAT_SESSIONS_FILE))?.mtimeMs ?? null;
}

export async function loadSessionsMeta() {
  const stats = await statOrNull(CHAT_SESSIONS_FILE);
  if (!stats) {
    sessionsMetaCache = [];
    sessionsMetaCacheMtimeMs = null;
    return sessionsMetaCache;
  }

  const mtimeMs = stats.mtimeMs;
  if (sessionsMetaCache && sessionsMetaCacheMtimeMs === mtimeMs) {
    return sessionsMetaCache;
  }

  const parsed = await readJson(CHAT_SESSIONS_FILE, []);
  const normalized = normalizeStoredSessionsMeta(parsed);
  sessionsMetaCache = normalized.list;
  if (normalized.changed) {
    await saveSessionsMetaUnlocked(sessionsMetaCache);
  } else {
    sessionsMetaCacheMtimeMs = mtimeMs;
  }
  return sessionsMetaCache;
}

export function findSessionMetaCached(sessionId) {
  if (!Array.isArray(sessionsMetaCache)) return null;
  return sessionsMetaCache.find((meta) => meta.id === sessionId) || null;
}

export async function findSessionMeta(sessionId) {
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.id === sessionId) || null;
}

export async function findSessionByExternalTriggerId(externalTriggerId) {
  const normalized = typeof externalTriggerId === 'string' ? externalTriggerId.trim() : '';
  if (!normalized) return null;
  const metas = await loadSessionsMeta();
  return metas.find((meta) => meta.externalTriggerId === normalized && !meta.archived) || null;
}

export async function withSessionsMetaMutation(mutator) {
  return runSessionsMetaMutation(async () => {
    const metas = await loadSessionsMeta();
    return mutator(metas, saveSessionsMetaUnlocked);
  });
}

export async function mutateSessionMeta(sessionId, mutator) {
  return withSessionsMetaMutation(async (metas, saveSessionsMeta) => {
    const index = metas.findIndex((meta) => meta.id === sessionId);
    if (index === -1) return { meta: null, changed: false };

    const current = metas[index];
    const draft = { ...current };
    const changed = mutator(draft, current) === true;
    if (!changed) {
      return { meta: current, changed: false };
    }

    metas[index] = draft;
    await saveSessionsMeta(metas);
    return { meta: draft, changed: true };
  });
}
