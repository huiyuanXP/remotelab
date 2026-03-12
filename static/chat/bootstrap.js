"use strict";

const buildInfo = window.__REMOTELAB_BUILD__ || {};
const buildAssetVersion = buildInfo.assetVersion || "dev";

console.info("RemoteLab build", buildInfo.title || buildAssetVersion);

// ---- Elements ----
const menuBtn = document.getElementById("menuBtn");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const closeSidebar = document.getElementById("closeSidebar");
const collapseBtn = document.getElementById("collapseBtn");
const forkSessionBtn = document.getElementById("forkSessionBtn");
const captureViewBtn = document.getElementById("captureViewBtn");
const shareSnapshotBtn = document.getElementById("shareSnapshotBtn");
const sidebarFilters = document.getElementById("sidebarFilters");
const sessionList = document.getElementById("sessionList");
const sessionListFooter = document.getElementById("sessionListFooter");
const newSessionBtn = document.getElementById("newSessionBtn");
const messagesEl = document.getElementById("messages");
const messagesInner = document.getElementById("messagesInner");
const emptyState = document.getElementById("emptyState");
const queuedPanel = document.getElementById("queuedPanel");
const msgInput = document.getElementById("msgInput");
const sendBtn = document.getElementById("sendBtn");
const headerTitle = document.getElementById("headerTitle");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const imgBtn = document.getElementById("imgBtn");
const imgFileInput = document.getElementById("imgFileInput");
const imgPreviewStrip = document.getElementById("imgPreviewStrip");
const inlineToolSelect = document.getElementById("inlineToolSelect");
const inlineModelSelect = document.getElementById("inlineModelSelect");
const effortSelect = document.getElementById("effortSelect");
const thinkingToggle = document.getElementById("thinkingToggle");
const cancelBtn = document.getElementById("cancelBtn");
const contextTokens = document.getElementById("contextTokens");
const compactBtn = document.getElementById("compactBtn");
const dropToolsBtn = document.getElementById("dropToolsBtn");
const resumeBtn = document.getElementById("resumeBtn");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const sessionTemplateRow = document.getElementById("sessionTemplateRow");
const sessionTemplateSelect = document.getElementById("sessionTemplateSelect");
const sessionTemplateStatus = document.getElementById("sessionTemplateStatus");
const tabSessions = document.getElementById("tabSessions");
const tabSettings = document.getElementById("tabSettings");
const appFilterSelect = document.getElementById("appFilterSelect");
const settingsPanel = document.getElementById("settingsPanel");
const inputArea = document.getElementById("inputArea");
const inputResizeHandle = document.getElementById("inputResizeHandle");
const addToolModal = document.getElementById("addToolModal");
const closeAddToolModalBtn = document.getElementById("closeAddToolModal");
const closeAddToolModalFooterBtn = document.getElementById(
  "closeAddToolModalFooter",
);
const addToolNameInput = document.getElementById("addToolNameInput");
const addToolCommandInput = document.getElementById("addToolCommandInput");
const addToolRuntimeFamilySelect = document.getElementById(
  "addToolRuntimeFamilySelect",
);
const addToolModelsInput = document.getElementById("addToolModelsInput");
const addToolReasoningKindSelect = document.getElementById(
  "addToolReasoningKindSelect",
);
const addToolReasoningLevelsInput = document.getElementById(
  "addToolReasoningLevelsInput",
);
const addToolStatus = document.getElementById("addToolStatus");
const providerPromptCode = document.getElementById("providerPromptCode");
const saveToolConfigBtn = document.getElementById("saveToolConfigBtn");
const copyProviderPromptBtn = document.getElementById("copyProviderPromptBtn");

let ws = null;
let pendingImages = [];
const ACTIVE_SESSION_STORAGE_KEY = "activeSessionId";
const ACTIVE_SIDEBAR_TAB_STORAGE_KEY = "activeSidebarTab";
const ACTIVE_APP_FILTER_STORAGE_KEY = "activeAppFilter";
const LEGACY_SESSION_SEEN_VERSIONS_STORAGE_KEY = "sessionSeenVersions";
const SESSION_UNREAD_VERSIONS_STORAGE_KEY = "sessionUnreadVersions";
const SESSION_SEND_FAILURES_STORAGE_KEY = "sessionSendFailures";
const PENDING_MESSAGE_STALE_MS = 15000;
const APP_FILTER_ALL_VALUE = "__all__";
const DEFAULT_APP_ID = "chat";
const DEFAULT_APP_NAME = "Chat";
let pendingNavigationState = readNavigationStateFromLocation();
let currentSessionId =
  pendingNavigationState.sessionId ||
  localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) ||
  null;
let hasAttachedSession = false;
let sessionStatus = "idle";
let reconnectTimer = null;
let sessions = [];
let appCatalog = [];
let availableApps = [];
let visitorMode = false;
let visitorSessionId = null;
let sessionUnreadVersions = readStoredJsonValue(
  SESSION_UNREAD_VERSIONS_STORAGE_KEY,
  {},
);
let failedSendSessionIds = new Set(
  readStoredJsonValue(SESSION_SEND_FAILURES_STORAGE_KEY, []),
);
const sendingSessionIds = new Set();
let currentSessionRefreshPromise = null;
let pendingCurrentSessionRefresh = false;
let hasSeenWsOpen = false;
const sidebarSessionRefreshPromises = new Map();
const pendingSidebarSessionRefreshes = new Set();
const jsonResponseCache = new Map();
const eventBodyCache = new Map();
const eventBodyRequests = new Map();
const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const renderedEventState = {
  sessionId: null,
  latestSeq: 0,
  eventCount: 0,
};

let currentTokens = 0;

let preferredTool =
  localStorage.getItem("preferredTool") ||
  localStorage.getItem("selectedTool") ||
  null;
let selectedTool = preferredTool;
// Default thinking to enabled; only disable if explicitly set to 'false'
let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
// Model/effort are stored per-tool: "selectedModel_claude", "selectedModel_codex"
let selectedModel = null;
let selectedEffort = null;
let currentToolModels = []; // model list for current tool
let currentToolEffortLevels = null; // null = binary toggle, string[] = effort dropdown
let currentToolReasoningKind = "toggle";
let currentToolReasoningLabel = "Thinking";
let currentToolReasoningDefault = null;
let sidebarCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
let toolsList = [];
let isDesktop = window.matchMedia("(min-width: 768px)").matches;
const ADD_MORE_TOOL_VALUE = "__add_more__";
const COLLAPSED_GROUPS_STORAGE_KEY = "collapsedSessionGroups";
let isSavingToolConfig = false;
let collapsedFolders = JSON.parse(
  localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ||
    localStorage.getItem("collapsedFolders") ||
    "{}",
);

function readStoredJsonValue(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJsonValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

try {
  localStorage.removeItem(LEGACY_SESSION_SEEN_VERSIONS_STORAGE_KEY);
} catch {}

function persistSessionUnreadVersions() {
  writeStoredJsonValue(
    SESSION_UNREAD_VERSIONS_STORAGE_KEY,
    sessionUnreadVersions,
  );
}

function persistFailedSendSessionIds() {
  writeStoredJsonValue(
    SESSION_SEND_FAILURES_STORAGE_KEY,
    [...failedSendSessionIds],
  );
}

function getSessionAttentionVersion(session) {
  const stamp = session?.lastEventAt || "";
  return typeof stamp === "string" ? stamp : String(stamp || "");
}

function isSessionUnread(session) {
  if (!session?.id) return false;
  const version = getSessionAttentionVersion(session);
  if (!version) return false;
  return sessionUnreadVersions[session.id] === version;
}

function clearSessionUnread(sessionId, version) {
  if (!sessionId) return false;
  if (
    version
    && sessionUnreadVersions[sessionId]
    && sessionUnreadVersions[sessionId] !== version
  ) {
    return false;
  }
  if (!sessionUnreadVersions[sessionId]) return false;
  delete sessionUnreadVersions[sessionId];
  persistSessionUnreadVersions();
  return true;
}

function markSessionUnread(session) {
  if (!session?.id) return false;
  const version = getSessionAttentionVersion(session);
  if (!version || sessionUnreadVersions[session.id] === version) return false;
  sessionUnreadVersions = { ...sessionUnreadVersions, [session.id]: version };
  persistSessionUnreadVersions();
  return true;
}

function markSessionSeen(session) {
  if (!session?.id || document.visibilityState !== "visible") return false;
  return clearSessionUnread(session.id, getSessionAttentionVersion(session));
}

function maybeUpdateSessionUnreadState(session, previous = null) {
  if (!session?.id) return false;
  if (
    document.visibilityState === "visible"
    && currentSessionId
    && session.id === currentSessionId
  ) {
    return markSessionSeen(session);
  }

  const currentVersion = getSessionAttentionVersion(session);
  if (!currentVersion || !previous?.id) return false;

  const previousVersion = getSessionAttentionVersion(previous);
  const previousStatus = normalizeSessionStatus(previous.status);
  const currentStatus = normalizeSessionStatus(session.status);
  const justCompleted =
    previousStatus === "running"
    && currentStatus === "idle"
    && currentVersion !== previousVersion;

  if (!justCompleted) return false;
  return markSessionUnread(session);
}

function pruneStoredSessionAttentionState(sessionIds) {
  const knownIds = new Set(
    Array.isArray(sessionIds) ? sessionIds.filter(Boolean) : [],
  );
  let unreadChanged = false;
  for (const sessionId of Object.keys(sessionUnreadVersions)) {
    if (!knownIds.has(sessionId)) {
      delete sessionUnreadVersions[sessionId];
      unreadChanged = true;
    }
  }
  if (unreadChanged) {
    persistSessionUnreadVersions();
  }

  let failedChanged = false;
  for (const sessionId of [...failedSendSessionIds]) {
    const hasPending =
      typeof getPendingMessage === "function" && !!getPendingMessage(sessionId);
    if (!knownIds.has(sessionId) && !hasPending) {
      failedSendSessionIds.delete(sessionId);
      failedChanged = true;
    }
  }
  if (failedChanged) {
    persistFailedSendSessionIds();
  }
}

function markSessionSendInFlight(sessionId) {
  if (!sessionId) return;
  sendingSessionIds.add(sessionId);
}

function clearSessionSendInFlight(sessionId) {
  if (!sessionId) return;
  sendingSessionIds.delete(sessionId);
}

function markSessionSendFailed(sessionId) {
  if (!sessionId) return false;
  clearSessionSendInFlight(sessionId);
  if (failedSendSessionIds.has(sessionId)) return false;
  failedSendSessionIds.add(sessionId);
  persistFailedSendSessionIds();
  return true;
}

function clearSessionSendFailed(sessionId) {
  if (!sessionId) return false;
  clearSessionSendInFlight(sessionId);
  if (!failedSendSessionIds.delete(sessionId)) return false;
  persistFailedSendSessionIds();
  return true;
}

function finishSessionSendAttempt(sessionId, ok) {
  if (!sessionId) return false;
  clearSessionSendInFlight(sessionId);
  return ok ? clearSessionSendFailed(sessionId) : markSessionSendFailed(sessionId);
}

function isPendingMessageStale(sessionId) {
  if (!sessionId || typeof getPendingMessage !== "function") return false;
  const pending = getPendingMessage(sessionId);
  if (!pending || sendingSessionIds.has(sessionId)) return false;
  const timestamp = Number(pending.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
  return Date.now() - timestamp >= PENDING_MESSAGE_STALE_MS;
}

function hasSessionSendFailure(sessionId) {
  if (!sessionId) return false;
  return failedSendSessionIds.has(sessionId) || isPendingMessageStale(sessionId);
}

function getQueuedStatusLabel(count) {
  const total = Number.isInteger(count) ? count : Number(count) || 0;
  return total === 1 ? "1 queued" : `${total} queued`;
}

function getSessionVisualStatus(session, { includeToolFallback = false } = {}) {
  if (!session) {
    return {
      key: "idle",
      label: "",
      className: "",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  const queuedCount = Number.isInteger(session.queuedMessageCount)
    ? session.queuedMessageCount
    : 0;
  const renameError =
    typeof session.renameError === "string" ? session.renameError.trim() : "";

  if (queuedCount > 0) {
    return {
      key: "queued",
      label: getQueuedStatusLabel(queuedCount),
      className: "status-queued",
      dotClass: "queued",
      itemClass: "",
      title: "Queued follow-up messages waiting for the next turn",
    };
  }

  if (session.status === "running") {
    return {
      key: "running",
      label: "running",
      className: "status-running",
      dotClass: "running",
      itemClass: "",
      title: "",
    };
  }

  if (hasSessionSendFailure(session.id)) {
    return {
      key: "send-failed",
      label: "send failed",
      className: "status-send-failed",
      dotClass: "send-failed",
      itemClass: "",
      title: "The last outgoing message still needs retry or recovery",
    };
  }

  if (isSessionUnread(session)) {
    return {
      key: "unread",
      label: "unread",
      className: "status-done-unread",
      dotClass: "done-unread",
      itemClass: "",
      title: "Finished while you were away",
    };
  }

  if (session.renameState === "pending") {
    return {
      key: "renaming",
      label: "renaming",
      className: "status-renaming",
      dotClass: "renaming",
      itemClass: "",
      title: "",
    };
  }

  if (session.renameState === "failed") {
    return {
      key: "rename-failed",
      label: "rename issue",
      className: "status-rename-failed",
      dotClass: "rename-failed",
      itemClass: "",
      title: renameError || "Rename suggestion could not be applied",
    };
  }

  if (session.status === "interrupted") {
    return {
      key: "interrupted",
      label: "interrupted",
      className: "status-interrupted",
      dotClass: "interrupted",
      itemClass: "",
      title: "",
    };
  }

  if (session.archived === true) {
    return {
      key: "archived",
      label: "archived",
      className: "status-archived",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  if (includeToolFallback && session.tool && session.name) {
    return {
      key: "tool",
      label: session.tool,
      className: "",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  return {
    key: "idle",
    label: "",
    className: "",
    dotClass: "",
    itemClass: "",
    title: "",
  };
}

function refreshSessionAttentionUi(sessionId = currentSessionId) {
  if (typeof renderSessionList === "function") {
    renderSessionList();
  }
  if (
    sessionId
    && sessionId === currentSessionId
    && typeof updateStatus === "function"
    && typeof getCurrentSession === "function"
  ) {
    const session = getCurrentSession();
    updateStatus(
      "connected",
      session?.status || "idle",
      session?.renameState,
      session?.archived === true,
    );
  }
}

// Thinking block state
let currentThinkingBlock = null; // { el, body, tools: Set }
let inThinkingBlock = false;

let activeAppFilter = normalizeAppFilter(
  localStorage.getItem(ACTIVE_APP_FILTER_STORAGE_KEY) || APP_FILTER_ALL_VALUE,
);

function registerHiddenMarkdownExtensions() {
  const hiddenTagStart = /<(private|hide)\b/i;
  const hiddenBlockPattern = /^(?: {0,3})<(private|hide)\b[^>]*>[\s\S]*?<\/\1>(?:\n+|$)/i;
  const hiddenInlinePattern = /^<(private|hide)\b[^>]*>[\s\S]*?<\/\1>/i;
  marked.use({
    extensions: [
      {
        name: "hiddenUiBlock",
        level: "block",
        start(src) {
          const match = src.match(hiddenTagStart);
          return match ? match.index : undefined;
        },
        tokenizer(src) {
          const match = src.match(hiddenBlockPattern);
          if (!match) return undefined;
          return { type: "hiddenUiBlock", raw: match[0] };
        },
        renderer() {
          return "";
        },
      },
      {
        name: "hiddenUiInline",
        level: "inline",
        start(src) {
          const match = src.match(hiddenTagStart);
          return match ? match.index : undefined;
        },
        tokenizer(src) {
          const match = src.match(hiddenInlinePattern);
          if (!match) return undefined;
          return { type: "hiddenUiInline", raw: match[0] };
        },
        renderer() {
          return "";
        },
      },
    ],
  });
}

function initializePushNotifications() {
  if (visitorMode || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted" && !visitorMode) setupPushNotifications();
    });
  } else if (Notification.permission === "granted") {
    setupPushNotifications();
  }
}

registerHiddenMarkdownExtensions();

function normalizeSidebarTab(tab) {
  return tab === "settings" || tab === "progress" ? "settings" : "sessions";
}

function normalizeNavigationState(raw) {
  let sessionId = null;
  let tab = null;

  if (raw && typeof raw === "object") {
    if (typeof raw.sessionId === "string") sessionId = raw.sessionId;
    if (typeof raw.tab === "string") tab = raw.tab;
    if (raw.url) {
      try {
        const url = new URL(raw.url, window.location.origin);
        if (!sessionId) sessionId = url.searchParams.get("session") || null;
        if (!tab) tab = url.searchParams.get("tab") || null;
      } catch {}
    }
  }

  return {
    sessionId:
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : null,
    tab: tab ? normalizeSidebarTab(tab) : null,
  };
}

function readNavigationStateFromLocation() {
  return normalizeNavigationState({
    sessionId: new URLSearchParams(window.location.search).get("session"),
    tab: new URLSearchParams(window.location.search).get("tab"),
  });
}

function persistActiveSessionId(sessionId) {
  if (visitorMode) return;
  if (sessionId) {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
  } else {
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  }
}

function persistActiveSidebarTab(tab) {
  if (visitorMode) return;
  localStorage.setItem(
    ACTIVE_SIDEBAR_TAB_STORAGE_KEY,
    normalizeSidebarTab(tab),
  );
}

function buildNavigationUrl(state = {}) {
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined ? activeTab : state.tab,
  );
  const url = new URL(window.location.href);
  url.searchParams.delete("visitor");
  url.searchParams.delete("source");
  if (nextSessionId) url.searchParams.set("session", nextSessionId);
  else url.searchParams.delete("session");
  if (nextTab === "settings") url.searchParams.set("tab", nextTab);
  else url.searchParams.delete("tab");
  return `${url.pathname}${url.search}`;
}

function syncBrowserState(state = {}) {
  if (visitorMode) return;
  const nextSessionId =
    state.sessionId === undefined ? currentSessionId : state.sessionId;
  const nextTab = normalizeSidebarTab(
    state.tab === undefined ? activeTab : state.tab,
  );
  persistActiveSessionId(nextSessionId);
  persistActiveSidebarTab(nextTab);
  const nextUrl = buildNavigationUrl({
    sessionId: nextSessionId,
    tab: nextTab,
  });
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl !== currentUrl) {
    history.replaceState(null, "", nextUrl);
  }
}

function normalizeAppId(appId, { fallbackDefault = false } = {}) {
  const trimmed = typeof appId === "string" ? appId.trim() : "";
  if (!trimmed) {
    return fallbackDefault ? DEFAULT_APP_ID : "";
  }
  const normalizedDefault = trimmed.toLowerCase();
  if (normalizedDefault === DEFAULT_APP_ID) return DEFAULT_APP_ID;
  return trimmed;
}

function normalizeAppFilter(appId) {
  const normalized = normalizeAppId(appId);
  return normalized || APP_FILTER_ALL_VALUE;
}

function persistActiveAppFilter(appId) {
  if (visitorMode) return;
  localStorage.setItem(ACTIVE_APP_FILTER_STORAGE_KEY, normalizeAppFilter(appId));
}

function formatAppNameFromId(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return DEFAULT_APP_NAME;
  if (normalized === DEFAULT_APP_ID) return DEFAULT_APP_NAME;
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function createAppCatalogEntry(app) {
  const id = normalizeAppId(app?.id);
  if (!id) return null;
  const name =
    typeof app?.appName === "string" && app.appName.trim()
      ? app.appName.trim()
      : typeof app?.name === "string" && app.name.trim()
        ? app.name.trim()
      : formatAppNameFromId(id);
  return {
    ...app,
    id,
    name,
  };
}

function sortAppCatalogEntries(a, b) {
  if (a.id === DEFAULT_APP_ID && b.id !== DEFAULT_APP_ID) return -1;
  if (b.id === DEFAULT_APP_ID && a.id !== DEFAULT_APP_ID) return 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function refreshAppCatalog(apps = availableApps) {
  const next = new Map();
  const sessionAppIds = new Set(
    sessions
      .map((session) => normalizeAppId(session?.appId))
      .filter(Boolean),
  );

  next.set(DEFAULT_APP_ID, createAppCatalogEntry({ id: DEFAULT_APP_ID, name: DEFAULT_APP_NAME }));

  for (const app of apps) {
    if (app?.showInSidebarWhenEmpty === false && !sessionAppIds.has(normalizeAppId(app?.id))) {
      continue;
    }
    const entry = createAppCatalogEntry(app);
    if (!entry) continue;
    next.set(entry.id, entry);
  }

  for (const session of sessions) {
    const entry = createAppCatalogEntry({ id: session?.appId, appName: session?.appName });
    if (!entry) continue;
    if (!next.has(entry.id)) {
      next.set(entry.id, entry);
    }
  }

  appCatalog = [...next.values()].filter(Boolean).sort(sortAppCatalogEntries);
  if (activeAppFilter !== APP_FILTER_ALL_VALUE && !appCatalog.some((app) => app.id === activeAppFilter)) {
    activeAppFilter = APP_FILTER_ALL_VALUE;
    persistActiveAppFilter(activeAppFilter);
  }
  if (!appCatalog.some((app) => app.id !== DEFAULT_APP_ID) && activeAppFilter !== APP_FILTER_ALL_VALUE) {
    activeAppFilter = APP_FILTER_ALL_VALUE;
    persistActiveAppFilter(activeAppFilter);
  }
  renderAppFilterOptions();
}

function getAppCatalogEntry(appId) {
  const normalized = normalizeAppId(appId, { fallbackDefault: true });
  return (
    appCatalog.find((entry) => entry.id === normalized)
    || createAppCatalogEntry({ id: normalized })
  );
}

function getTemplateApps() {
  return availableApps.filter((app) => (
    normalizeAppId(app?.id, { fallbackDefault: true }) !== DEFAULT_APP_ID
    && app?.templateSelectable !== false
  ));
}

function getEffectiveSessionAppId(session) {
  return normalizeAppId(session?.appId, { fallbackDefault: true });
}

function matchesCurrentAppFilter(session) {
  return (
    activeAppFilter === APP_FILTER_ALL_VALUE
    || getEffectiveSessionAppId(session) === activeAppFilter
  );
}

function getVisibleActiveSessions() {
  return getActiveSessions().filter((session) => !session.pinned && matchesCurrentAppFilter(session));
}

function getVisiblePinnedSessions() {
  return getActiveSessions().filter((session) => session.pinned === true && matchesCurrentAppFilter(session));
}

function getVisibleArchivedSessions() {
  return getArchivedSessions().filter((session) => matchesCurrentAppFilter(session));
}

function getSessionCountForApp(appId) {
  const activeSessions = getActiveSessions();
  if (appId === APP_FILTER_ALL_VALUE) return activeSessions.length;
  return activeSessions.filter((session) => getEffectiveSessionAppId(session) === appId).length;
}

function shouldShowAppFilter() {
  return !visitorMode && appCatalog.some((app) => app.id !== DEFAULT_APP_ID);
}

function syncSidebarFiltersVisibility(showingSessions = true) {
  if (!sidebarFilters) return;
  sidebarFilters.classList.toggle("hidden", !showingSessions || !shouldShowAppFilter());
}

function renderAppFilterOptions() {
  if (!appFilterSelect || visitorMode) {
    syncSidebarFiltersVisibility();
    return;
  }

  if (!shouldShowAppFilter()) {
    appFilterSelect.innerHTML = "";
    appFilterSelect.value = APP_FILTER_ALL_VALUE;
    syncSidebarFiltersVisibility();
    return;
  }

  const previousValue = normalizeAppFilter(appFilterSelect.value || activeAppFilter);
  const selectedValue = appCatalog.some((app) => app.id === previousValue)
    ? previousValue
    : activeAppFilter;

  appFilterSelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = APP_FILTER_ALL_VALUE;
  allOption.textContent = `All Apps (${getSessionCountForApp(APP_FILTER_ALL_VALUE)})`;
  appFilterSelect.appendChild(allOption);

  for (const app of appCatalog) {
    const option = document.createElement("option");
    option.value = app.id;
    option.textContent = `${app.name} (${getSessionCountForApp(app.id)})`;
    appFilterSelect.appendChild(option);
  }

  appFilterSelect.value = normalizeAppFilter(selectedValue);
  syncSidebarFiltersVisibility();
}

if (appFilterSelect) {
  appFilterSelect.addEventListener("change", () => {
    activeAppFilter = normalizeAppFilter(appFilterSelect.value);
    persistActiveAppFilter(activeAppFilter);
    renderAppFilterOptions();
    renderSessionList();
  });
}

refreshAppCatalog();

function getSessionSortTime(session) {
  const stamp = session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getSessionPinSortRank(session) {
  return session?.pinned === true ? 1 : 0;
}

function sortSessionsInPlace() {
  sessions.sort((a, b) => (
    getSessionPinSortRank(b) - getSessionPinSortRank(a)
    || getSessionSortTime(b) - getSessionSortTime(a)
  ));
}

function getArchivedSessionSortTime(session) {
  const stamp = session?.archivedAt || session?.updatedAt || session?.created || "";
  const time = new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function getActiveSessions() {
  return sessions.filter((session) => !session.archived);
}

function getArchivedSessions() {
  return sessions
    .filter((session) => session.archived)
    .slice()
    .sort((a, b) => getArchivedSessionSortTime(b) - getArchivedSessionSortTime(a));
}

function getLatestSession() {
  return sessions[0] || null;
}

function getLatestActiveSession() {
  return sessions.find((session) => !session.archived) || null;
}

function resolveRestoreTargetSession() {
  if (pendingNavigationState?.sessionId) {
    const requested = sessions.find(
      (session) => session.id === pendingNavigationState.sessionId,
    );
    if (requested) return requested;
  }
  if (currentSessionId) {
    const current = sessions.find((session) => session.id === currentSessionId);
    if (current) return current;
  }
  return getLatestActiveSession() || getLatestSession();
}

function applyNavigationState(rawState) {
  const next = normalizeNavigationState(rawState);
  if (next.tab) {
    switchTab(next.tab, { syncState: false });
  }
  pendingNavigationState = next.sessionId ? next : null;
  if (next.sessionId) {
    const target = sessions.find((session) => session.id === next.sessionId);
    if (target) {
      attachSession(target.id, target);
      pendingNavigationState = null;
    } else {
      dispatchAction({ action: "list" });
    }
    syncBrowserState({
      sessionId: next.sessionId,
      tab: next.tab || activeTab,
    });
    return;
  }
  syncBrowserState({ tab: next.tab || activeTab });
}
