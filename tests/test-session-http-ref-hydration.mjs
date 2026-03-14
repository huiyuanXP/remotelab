#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function makeElement() {
  return {
    style: {},
    disabled: false,
    textContent: '',
    innerHTML: '',
    children: [],
    className: '',
    value: '',
    parentNode: null,
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
    },
    remove() {
      this.parentNode = null;
    },
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
    querySelector() {
      return null;
    },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
  };
}

function createFetchResponse(body, { status = 200, etag = '"etag-default"', url = 'http://127.0.0.1/' } = {}) {
  const headers = new Map([
    ['content-type', 'application/json; charset=utf-8'],
    ['etag', etag],
  ]);
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url,
    headers: {
      get(name) {
        return headers.get(String(name).toLowerCase()) || null;
      },
    },
    async json() {
      return body;
    },
  };
}

function createContext() {
  const fetchCalls = [];
  const renderCalls = [];
  const context = {
    console,
    URL,
    Headers,
    Map,
    Set,
    Math,
    Date,
    JSON,
    fetchCalls,
    renderCalls,
    navigator: {},
    Notification: function Notification() {},
    atob(value) {
      return Buffer.from(String(value), 'base64').toString('binary');
    },
    window: {
      location: {
        origin: 'http://127.0.0.1',
        href: 'http://127.0.0.1/',
        pathname: '/',
      },
      focus() {},
      crypto: {
        randomUUID() {
          return 'req_test';
        },
      },
    },
    document: {
      visibilityState: 'visible',
      getElementById() {
        return null;
      },
      createElement() {
        return makeElement();
      },
    },
    pendingNavigationState: null,
    activeTab: 'sessions',
    visitorMode: false,
    visitorSessionId: null,
    currentSessionId: 'current-session',
    hasAttachedSession: true,
    hasLoadedSessions: true,
    sessions: [
      {
        id: 'current-session',
        name: 'Current session',
        status: 'idle',
        updatedAt: '2026-03-12T09:30:00.000Z',
        appId: 'chat',
        summaryEtag: '"etag-current"',
      },
      {
        id: 'changed-session',
        name: 'Old changed session',
        status: 'idle',
        updatedAt: '2026-03-12T08:30:00.000Z',
        appId: 'chat',
        summaryEtag: '"etag-changed-old"',
      },
      {
        id: 'unchanged-session',
        name: 'Stable session',
        status: 'idle',
        updatedAt: '2026-03-12T07:30:00.000Z',
        appId: 'chat',
        summaryEtag: '"etag-unchanged"',
      },
    ],
    sessionBoardLayout: null,
    taskBoardState: null,
    jsonResponseCache: new Map(),
    renderedEventState: {
      sessionId: null,
      latestSeq: 0,
      eventCount: 0,
    },
    emptyState: makeElement(),
    messagesInner: makeElement(),
    messagesEl: {
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
    },
    sidebarSessionRefreshPromises: new Map(),
    pendingSidebarSessionRefreshes: new Set(),
    pendingCurrentSessionRefresh: false,
    currentSessionRefreshPromise: null,
    contextTokens: makeElement(),
    compactBtn: makeElement(),
    dropToolsBtn: makeElement(),
    resumeBtn: makeElement(),
    headerTitle: makeElement(),
    inlineToolSelect: makeElement(),
    toolsList: [],
    selectedTool: '',
    loadModelsForCurrentTool() {},
    restoreDraft() {},
    updateStatus() {},
    renderQueuedMessagePanel() {},
    updateResumeButton() {},
    syncBrowserState() {},
    syncForkButton() {},
    syncShareButton() {},
    finishedUnread: new Set(),
    getSessionDisplayName(session) {
      return session?.name || '';
    },
    getEffectiveSessionAppId(session) {
      return session?.appId || 'chat';
    },
    normalizeSessionStatus(status) {
      return status || 'idle';
    },
    sortSessionsInPlace() {
      context.sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    },
    refreshAppCatalog() {},
    renderSessionList() {
      renderCalls.push(context.sessions.map((session) => session.id));
    },
    clearMessages() {},
    showEmpty() {},
    scrollToBottom() {},
    applyFinishedTurnCollapseState() {
      return null;
    },
    shouldFocusLatestTurnStart() {
      return false;
    },
    scrollNodeToTop() {},
    checkPendingMessage() {},
    getPendingMessage() {
      return null;
    },
    clearPendingMessage() {},
    attachSession() {},
    persistActiveSessionId() {},
    resolveRestoreTargetSession() {
      return null;
    },
    switchTab() {},
    applyNavigationState() {},
    fetch: async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === '/api/sessions?includeVisitor=1&view=refs') {
        return createFetchResponse({
          sessionRefs: [
            { id: 'current-session', summaryEtag: '"etag-current"' },
            { id: 'changed-session', summaryEtag: '"etag-changed-new"' },
            { id: 'unchanged-session', summaryEtag: '"etag-unchanged"' },
          ],
          board: null,
          taskBoard: null,
        }, {
          etag: '"etag-refs"',
          url: 'http://127.0.0.1/api/sessions?includeVisitor=1&view=refs',
        });
      }
      if (String(url) === '/api/sessions/changed-session?view=summary') {
        return createFetchResponse({
          session: {
            id: 'changed-session',
            name: 'Fresh changed session',
            status: 'running',
            updatedAt: '2026-03-12T10:00:00.000Z',
            appId: 'chat',
          },
        }, {
          etag: '"etag-changed-new"',
          url: 'http://127.0.0.1/api/sessions/changed-session?view=summary',
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };

  context.globalThis = context;
  context.self = context;
  return context;
}

const context = createContext();
vm.runInNewContext(sessionHttpSource, context, { filename: 'static/chat/session-http.js' });

await context.fetchSessionsList();

assert.deepEqual(
  context.fetchCalls,
  [
    '/api/sessions?includeVisitor=1&view=refs',
    '/api/sessions/changed-session?view=summary',
  ],
  'incremental session refresh should fetch refs plus only changed summaries',
);
assert.equal(context.sessions[0].id, 'changed-session', 'changed session should resort to the top after hydration');
assert.equal(context.sessions[0].name, 'Fresh changed session', 'changed summary hydration should replace stale metadata');
assert.equal(context.sessions[0].summaryEtag, '"etag-changed-new"', 'changed summary hydration should store the fresh summary tag');
assert.equal(
  context.sessions.find((session) => session.id === 'unchanged-session')?.name,
  'Stable session',
  'unchanged sessions should be reused from memory without a summary refetch',
);

console.log('test-session-http-ref-hydration: ok');
