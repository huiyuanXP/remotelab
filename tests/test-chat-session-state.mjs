#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const bootstrapSource = readFileSync(join(repoRoot, 'static/chat/bootstrap.js'), 'utf8');
const composeSource = readFileSync(join(repoRoot, 'static/chat/compose.js'), 'utf8');
const realtimeSource = readFileSync(join(repoRoot, 'static/chat/realtime.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function sliceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start === -1) {
    throw new Error(`Missing start token: ${startToken}`);
  }
  const end = source.indexOf(endToken, start);
  if (end === -1) {
    throw new Error(`Missing end token: ${endToken}`);
  }
  return source.slice(start, end);
}

class StorageMock {
  constructor() {
    this.store = new Map();
  }

  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  setItem(key, value) {
    this.store.set(key, String(value));
  }

  removeItem(key) {
    this.store.delete(key);
  }
}

function createDomElement() {
  return {
    className: '',
    id: '',
    innerHTML: '',
    textContent: '',
    style: {},
    appendChild() {},
    remove() {},
  };
}

function createBaseContext() {
  const context = {
    console,
    Date,
    JSON,
    Set,
    Map,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Math,
    Promise,
    sessionUnreadVersions: {},
    failedSendSessionIds: new Set(),
    sendingSessionIds: new Set(),
    currentSessionId: null,
    currentSessionRefreshPromise: null,
    pendingCurrentSessionRefresh: false,
    visitorMode: false,
    sessions: [],
    localStorage: new StorageMock(),
    document: {
      visibilityState: 'visible',
      getElementById() {
        return null;
      },
      createElement() {
        return createDomElement();
      },
    },
    PENDING_MESSAGE_STALE_MS: 15000,
    SESSION_UNREAD_VERSIONS_STORAGE_KEY: 'sessionUnreadVersions',
    SESSION_SEND_FAILURES_STORAGE_KEY: 'sessionSendFailures',
    getEffectiveSessionAppId(session) {
      return session?.appId || 'chat';
    },
    renderSessionList() {},
    updateStatus() {},
    getCurrentSession() {
      return this.sessions.find((session) => session.id === this.currentSessionId) || null;
    },
    getPendingMessage() {
      return null;
    },
    fetchSessionsList: async () => [],
    refreshCurrentSession: async () => ({}),
    fetchJsonOrRedirect: async () => ({}),
    upsertSession(value) {
      return value;
    },
    renderSessionList() {},
    attachSession() {},
    applyAttachedSessionState() {},
    refreshSidebarSession: async () => null,
    createRequestId() {
      return 'req-test';
    },
    clearOptimisticMessage() {},
    refreshSessionAttentionUi() {},
    msgInput: { value: '' },
    emptyState: { parentNode: null, remove() {} },
    messagesInner: { appendChild() {}, children: [] },
    appendMessageTimestamp() {},
    scrollToBottom() {},
    autoResizeInput() {},
    sendMessage() {},
  };
  context.writeStoredJsonValue = (key, value) => {
    context.localStorage.setItem(key, JSON.stringify(value));
  };
  context.globalThis = context;
  return context;
}

const normalizeSessionStatusSnippet = sliceBetween(
  realtimeSource,
  'function normalizeSessionStatus',
  'function updateResumeButton',
);

const sessionAttentionSnippet = sliceBetween(
  bootstrapSource,
  'function persistSessionUnreadVersions',
  '// Thinking block state',
);

const normalizeSessionRecordSnippet = sliceBetween(
  sessionHttpSource,
  'function normalizeSessionRecord',
  'function upsertSession',
);

const dispatchActionSnippet = sliceBetween(
  realtimeSource,
  'async function dispatchAction',
  'function getCurrentSession',
);

const pendingMessageSnippet = sliceBetween(
  composeSource,
  'function savePendingMessage',
  '// ---- Sidebar tabs ----',
);

const stateContext = createBaseContext();
vm.runInNewContext(
  `${normalizeSessionStatusSnippet}\n${sessionAttentionSnippet}\n${normalizeSessionRecordSnippet}`,
  stateContext,
  { filename: 'chat-session-state-runtime.js' },
);

const restored = stateContext.normalizeSessionRecord(
  {
    id: 'session-restore',
    status: 'idle',
    lastEventAt: '2026-03-12T12:00:00.000Z',
  },
  {
    id: 'session-restore',
    status: 'idle',
    archived: true,
    archivedAt: '2026-03-12T11:59:00.000Z',
  },
);
assert.equal(restored.archived, undefined, 'restoring should clear stale archived flags from the client cache');
assert.equal(restored.archivedAt, undefined, 'restoring should clear stale archived timestamps from the client cache');
assert.equal(restored.status, 'idle', 'finished sessions should normalize back to idle');

stateContext.document.visibilityState = 'hidden';
const unreadSession = stateContext.normalizeSessionRecord(
  {
    id: 'session-unread',
    status: 'idle',
    lastEventAt: '2026-03-12T12:05:00.000Z',
    appId: 'chat',
  },
  {
    id: 'session-unread',
    status: 'running',
    lastEventAt: '2026-03-12T12:04:00.000Z',
    appId: 'chat',
  },
);
assert.equal(stateContext.isSessionUnread(unreadSession), true, 'a session that finishes off-screen should become unread');
assert.equal(
  stateContext.getSessionVisualStatus(unreadSession).key,
  'unread',
  'finished unread sessions should show the unread hint instead of a done/read state',
);

stateContext.currentSessionId = 'session-unread';
stateContext.document.visibilityState = 'visible';
const seenSession = stateContext.normalizeSessionRecord(
  {
    id: 'session-unread',
    status: 'idle',
    lastEventAt: '2026-03-12T12:05:00.000Z',
    appId: 'chat',
  },
  unreadSession,
);
assert.equal(stateContext.isSessionUnread(seenSession), false, 'opening the current session should clear its unread hint');
assert.equal(
  stateContext.getSessionVisualStatus(seenSession).key,
  'idle',
  'once seen, finished sessions should fall back to idle',
);

stateContext.failedSendSessionIds.add('session-running');
assert.equal(
  stateContext.getSessionVisualStatus({ id: 'session-running', status: 'running' }).key,
  'running',
  'active runs should keep the running state even if there is stale send-failure metadata',
);
assert.equal(
  stateContext.getSessionVisualStatus({ id: 'session-running', status: 'idle' }).key,
  'send-failed',
  'idle sessions can still surface send failures for retry',
);

const dispatchContext = createBaseContext();
let savedPending = null;
let clearedPending = false;
let clearedOptimistic = false;
let attentionRefreshes = 0;
let refreshCalls = 0;
dispatchContext.currentSessionId = 'session-send';
dispatchContext.getPendingMessage = () => null;
dispatchContext.savePendingMessage = (text, requestId) => {
  savedPending = { text, requestId };
  return Date.now();
};
dispatchContext.fetchJsonOrRedirect = async () => ({ queued: false });
dispatchContext.clearPendingMessage = () => {
  clearedPending = true;
  return true;
};
dispatchContext.clearOptimisticMessage = () => {
  clearedOptimistic = true;
};
dispatchContext.refreshSessionAttentionUi = () => {
  attentionRefreshes += 1;
};
dispatchContext.refreshCurrentSession = async () => {
  refreshCalls += 1;
  if (refreshCalls === 1) {
    throw new Error('temporary refresh failure');
  }
  return {};
};
vm.runInNewContext(dispatchActionSnippet, dispatchContext, {
  filename: 'chat-dispatch-action-runtime.js',
});

const sendAccepted = await dispatchContext.dispatchAction({ action: 'send', text: 'hello world' });
assert.equal(sendAccepted, true, 'send should still resolve successfully after the server accepted the message');
assert.deepEqual(savedPending, { text: 'hello world', requestId: 'req-test' });
assert.equal(clearedPending, true, 'accepted sends should clear pending-send recovery state immediately');
assert.equal(clearedOptimistic, true, 'accepted sends should clear the optimistic bubble before the refresh finishes');
assert.equal(attentionRefreshes, 1, 'accepted sends should refresh sidebar attention state when pending recovery is cleared');
assert.equal(refreshCalls, 2, 'accepted sends should retry the session refresh asynchronously after a transient failure');

const pendingContext = createBaseContext();
let markedFailures = 0;
let pendingRefreshes = 0;
let recoveryRenders = 0;
pendingContext.currentSessionId = 'session-pending';
pendingContext.clearSessionSendFailed = () => false;
pendingContext.markSessionSendFailed = () => {
  markedFailures += 1;
  return true;
};
pendingContext.refreshSessionAttentionUi = () => {
  pendingRefreshes += 1;
};
vm.runInNewContext(pendingMessageSnippet, pendingContext, {
  filename: 'chat-pending-message-runtime.js',
});
pendingContext.renderPendingRecovery = () => {
  recoveryRenders += 1;
};

pendingContext.savePendingMessage('still sending', 'req-fresh');
pendingContext.checkPendingMessage([]);
assert.equal(markedFailures, 0, 'fresh pending messages should not be marked as failed immediately after a reload');
assert.equal(recoveryRenders, 0, 'fresh pending messages should not render recovery UI yet');

pendingContext.localStorage.setItem(
  'pending_msg_session-pending',
  JSON.stringify({
    text: 'stale pending',
    requestId: 'req-stale',
    timestamp: Date.now() - pendingContext.PENDING_MESSAGE_STALE_MS - 1,
  }),
);
pendingContext.checkPendingMessage([]);
assert.equal(markedFailures, 1, 'stale pending messages should still fall back to recovery');
assert.equal(recoveryRenders, 1, 'stale pending messages should render recovery UI');
assert.equal(pendingRefreshes, 1, 'stale pending messages should refresh sidebar attention state once');

console.log('test-chat-session-state: ok');
