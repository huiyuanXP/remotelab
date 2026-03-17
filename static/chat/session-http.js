function restoreOwnerSessionSelection() {
  if (visitorMode) return;

  const requestedTab = pendingNavigationState?.tab || activeTab;
  if (requestedTab !== activeTab) {
    switchTab(requestedTab, { syncState: false });
  }

  const targetSession = resolveRestoreTargetSession();
  if (!targetSession) {
    currentSessionId = null;
    hasAttachedSession = false;
    persistActiveSessionId(null);
    syncBrowserState({ sessionId: null, tab: activeTab });
    showEmpty();
    restoreDraft();
    updateStatus("connected");
    pendingNavigationState = null;
    return;
  }

  if (!hasAttachedSession || currentSessionId !== targetSession.id) {
    attachSession(targetSession.id, targetSession);
  } else {
    syncBrowserState();
  }
  pendingNavigationState = null;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "remotelab:open-session") return;
    applyNavigationState(event.data);
    window.focus();
  });
}

function notifyCompletion(session) {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  if (document.visibilityState === "visible") return;
  const folder = (session?.folder || "").split("/").pop() || "Session";
  const name = session?.name || folder;
  const n = new Notification("RemoteLab", {
    body: `${name} — task completed`,
    tag: "remotelab-done",
  });
  n.onclick = () => {
    window.focus();
    applyNavigationState({ sessionId: session?.id, tab: "sessions" });
    n.close();
  };
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++)
    outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function redirectToLogin() {
  if (window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

const LOCAL_EDITOR_ROOT_PATTERN = /^\/(Users|home|opt|private|var|tmp|etc|Volumes|mnt)\//;

function safeDecodeHref(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalizeLocalEditorHrefCandidate(href) {
  const decoded = safeDecodeHref(href);
  if (!decoded) return "";
  let candidate = decoded;
  const hashIndex = candidate.indexOf("#");
  if (hashIndex >= 0) {
    candidate = candidate.slice(0, hashIndex);
  }
  const colonMatch = candidate.match(/^(.*):\d+(?::\d+)?$/);
  if (colonMatch && LOCAL_EDITOR_ROOT_PATTERN.test(colonMatch[1])) {
    return colonMatch[1];
  }
  return candidate;
}

function isLikelyLocalEditorHref(href) {
  const candidate = normalizeLocalEditorHrefCandidate(href);
  return LOCAL_EDITOR_ROOT_PATTERN.test(candidate);
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLocalEditorTarget(href) {
  const decoded = safeDecodeHref(href);
  if (!decoded) return null;

  const hashMatch = decoded.match(/^(.*)#L(\d+)(?:C(\d+))?$/i);
  if (hashMatch && LOCAL_EDITOR_ROOT_PATTERN.test(hashMatch[1])) {
    return {
      path: hashMatch[1],
      line: parsePositiveInt(hashMatch[2]),
      column: parsePositiveInt(hashMatch[3]),
    };
  }

  const colonMatch = decoded.match(/^(.*):(\d+)(?::(\d+))?$/);
  if (colonMatch && LOCAL_EDITOR_ROOT_PATTERN.test(colonMatch[1])) {
    return {
      path: colonMatch[1],
      line: parsePositiveInt(colonMatch[2]),
      column: parsePositiveInt(colonMatch[3]),
    };
  }

  if (!LOCAL_EDITOR_ROOT_PATTERN.test(decoded)) return null;
  return { path: decoded, line: null, column: null };
}

function supportsDesktopEditorLinks() {
  if (typeof window.matchMedia !== "function") return true;
  return (
    window.matchMedia("(pointer: fine)").matches &&
    window.matchMedia("(hover: hover)").matches
  );
}

function buildVscodeEditorHref(href) {
  const target = parseLocalEditorTarget(href);
  if (!target) return "";
  const lineSuffix = target.line
    ? `:${target.line}${target.column ? `:${target.column}` : ""}`
    : "";
  return `vscode://file${encodeURI(target.path)}${lineSuffix}`;
}

function enhanceRenderedContentLinks(root) {
  if (!root) return;

  root.querySelectorAll("a[href]").forEach((link) => {
    const href = (
      link.dataset.localEditorSource ||
      link.getAttribute("href") ||
      ""
    ).trim();
    if (!href) return;

    if (isLikelyLocalEditorHref(href)) {
      link.dataset.localEditorSource = href;
      link.removeAttribute("target");
      link.removeAttribute("rel");

      if (visitorMode) {
        link.removeAttribute("href");
        link.title = "Local file links are unavailable in visitor mode";
        return;
      }

      if (!supportsDesktopEditorLinks()) {
        link.removeAttribute("href");
        link.title = "Open this link from a desktop browser";
        return;
      }

      const editorHref = buildVscodeEditorHref(href);
      if (!editorHref) {
        link.removeAttribute("href");
        link.title = "Unsupported local file link";
        return;
      }

      link.href = editorHref;
      link.title = "Open in VS Code";
      return;
    }

    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });
}

function buildJsonCacheKey(url) {
  try {
    const resolved = new URL(url, window.location.origin);
    return `${resolved.pathname}${resolved.search}`;
  } catch {
    return String(url);
  }
}

const SESSION_LIST_URL = "/api/sessions?includeVisitor=1";
const ARCHIVED_SESSION_LIST_URL = "/api/sessions/archived?includeVisitor=1";

function getSessionSidebarUrl(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}?view=sidebar`;
}

function resolveRequestUrl(url) {
  if (typeof withVisitorModeUrl === "function") {
    return withVisitorModeUrl(url);
  }
  return typeof url === "string" ? url : String(url || "");
}

async function fetchJsonOrRedirect(url, options = {}) {
  const requestOptions = { ...options };
  const revalidate = requestOptions.revalidate !== false;
  delete requestOptions.revalidate;
  const requestUrl = resolveRequestUrl(url);

  const method = String(requestOptions.method || "GET").toUpperCase();
  const isGet = method === "GET";
  const cacheKey = isGet && revalidate ? buildJsonCacheKey(requestUrl) : null;
  const cached = cacheKey ? jsonResponseCache.get(cacheKey) : null;
  const headers = new Headers(requestOptions.headers || {});
  if (cached?.etag) {
    headers.set("If-None-Match", cached.etag);
  }

  const res = await fetch(requestUrl, {
    ...requestOptions,
    method,
    headers,
  });
  const redirectedToLogin =
    res.redirected && new URL(res.url, window.location.href).pathname === "/login";

  if (res.status === 401 || redirectedToLogin) {
    redirectToLogin();
    throw new Error("Authentication required");
  }

  if (res.status === 304) {
    if (!cached) {
      throw new Error("Cache revalidation failed");
    }
    return cached.data;
  }

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json().catch(() => ({}))
    : null;

  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }

  if (!data) {
    throw new Error("Expected JSON response");
  }

  if (cacheKey) {
    const etag = res.headers.get("etag");
    if (etag) {
      jsonResponseCache.set(cacheKey, { etag, data });
    } else {
      jsonResponseCache.delete(cacheKey);
    }
  }

  return data;
}

function createRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function resetRenderedEventState(sessionId = null) {
  renderedEventState.sessionId = sessionId;
  renderedEventState.latestSeq = 0;
  renderedEventState.eventCount = 0;
  renderedEventState.eventKeys = [];
  renderedEventState.runState = "idle";
  renderedEventState.runningBlockExpanded = false;
}

function getEventBoundarySeq(event) {
  if (Number.isInteger(event?.blockEndSeq) && event.blockEndSeq > 0) {
    return event.blockEndSeq;
  }
  return Number.isInteger(event?.seq) ? event.seq : 0;
}

function getEventRenderKey(event) {
  const seq = Number.isInteger(event?.seq) ? event.seq : 0;
  const type = typeof event?.type === "string" ? event.type : "unknown";
  if (type === "collapsed_block" || type === "thinking_block") {
    const state = typeof event?.state === "string" ? event.state : "";
    const dynamicBoundary = type === "thinking_block" && renderedEventState.runningBlockExpanded === true
      ? `:${Number.isInteger(event?.blockEndSeq) ? event.blockEndSeq : 0}`
      : "";
    return `${seq}:${type}:${state}${dynamicBoundary}`;
  }
  return `${seq}:${type}`;
}

function eventKeyArraysEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function eventKeyPrefixMatches(prefix, full) {
  if (prefix.length > full.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== full[index]) return false;
  }
  return true;
}

function getLatestEventSeq(events) {
  let latestSeq = 0;
  for (const event of events || []) {
    const boundarySeq = getEventBoundarySeq(event);
    if (boundarySeq > latestSeq) {
      latestSeq = boundarySeq;
    }
  }
  return latestSeq;
}

function updateRenderedEventState(sessionId, events, { runState = "idle" } = {}) {
  renderedEventState.sessionId = sessionId;
  renderedEventState.latestSeq = getLatestEventSeq(events);
  renderedEventState.eventCount = Array.isArray(events) ? events.length : 0;
  renderedEventState.eventKeys = Array.isArray(events)
    ? events.map((event) => getEventRenderKey(event))
    : [];
  renderedEventState.runState = runState === "running" ? "running" : "idle";
  if (renderedEventState.runState !== "running") {
    renderedEventState.runningBlockExpanded = false;
  }
}

function getSessionRunState(session) {
  return session?.activity?.run?.state === "running" ? "running" : "idle";
}

function hasRenderedEventSnapshot(sessionId) {
  const sameSession = renderedEventState.sessionId === sessionId;
  return sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );
}

function shouldFetchSessionEventsForRefresh(sessionId, session) {
  const runState = getSessionRunState(session);
  if (runState !== "running") return true;
  if (!hasRenderedEventSnapshot(sessionId)) return true;
  if (renderedEventState.runState !== "running") return true;
  return renderedEventState.runningBlockExpanded === true;
}

function getEventRenderPlan(sessionId, events) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const latestSeq = getLatestEventSeq(normalizedEvents);
  const nextKeys = normalizedEvents.map((event) => getEventRenderKey(event));
  const sameSession = renderedEventState.sessionId === sessionId;
  const hasRenderedSnapshot = sameSession && (
    renderedEventState.eventCount > 0
    || emptyState.parentNode === messagesInner
  );

  if (!sameSession || !hasRenderedSnapshot) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (
    latestSeq < renderedEventState.latestSeq ||
    normalizedEvents.length < renderedEventState.eventCount
  ) {
    return { mode: "reset", events: normalizedEvents };
  }

  if (latestSeq === renderedEventState.latestSeq && eventKeyArraysEqual(nextKeys, renderedEventState.eventKeys || [])) {
    return { mode: "noop", events: [] };
  }

  if (eventKeyPrefixMatches(renderedEventState.eventKeys || [], nextKeys)) {
    const appendedEvents = normalizedEvents.slice((renderedEventState.eventKeys || []).length);
    if (appendedEvents.length > 0) {
      return { mode: "append", events: appendedEvents };
    }
  }

  return { mode: "reset", events: normalizedEvents };
}

function reconcilePendingMessageState(event) {
  if (typeof reconcileComposerPendingSendWithEvent === "function") {
    reconcileComposerPendingSendWithEvent(event);
  }
}

function normalizeSessionRecord(session, previous = null) {
  const queueCount = Number.isInteger(session?.activity?.queue?.count)
    ? session.activity.queue.count
    : 0;
  const normalized = {
    ...session,
    appId: getEffectiveSessionAppId(session),
  };
  if (!Object.prototype.hasOwnProperty.call(session || {}, "queuedMessages")) {
    if (queueCount > 0 && Array.isArray(previous?.queuedMessages)) {
      normalized.queuedMessages = previous.queuedMessages;
    } else {
      delete normalized.queuedMessages;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "model")) {
    if (typeof previous?.model === "string") {
      normalized.model = previous.model;
    } else {
      delete normalized.model;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "effort")) {
    if (typeof previous?.effort === "string") {
      normalized.effort = previous.effort;
    } else {
      delete normalized.effort;
    }
  }
  if (!Object.prototype.hasOwnProperty.call(session || {}, "thinking")) {
    if (previous?.thinking === true) {
      normalized.thinking = true;
    } else {
      delete normalized.thinking;
    }
  }
  return normalized;
}

function upsertSession(session) {
  if (!session?.id) return null;
  const previous = sessions.find((entry) => entry.id === session.id);
  const normalized = normalizeSessionRecord(session, previous);
  const index = sessions.findIndex((entry) => entry.id === session.id);
  if (index === -1) {
    sessions.push(normalized);
  } else {
    sessions[index] = normalized;
  }
  sortSessionsInPlace();
  refreshAppCatalog();
  return normalized;
}

function mergeUniqueSessions(entries = []) {
  const merged = [];
  const seenIds = new Set();
  for (const entry of entries) {
    if (!entry?.id || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function applySessionListState(nextSessions, {
  board = null,
  taskBoard = null,
  archivedCount: nextArchivedCount = archivedSessionCount,
} = {}) {
  sessionBoardLayout = board;
  taskBoardState = taskBoard;
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const activeSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const preservedArchived = sessions
    .filter((session) => session?.archived === true)
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const preservedCurrent = currentSessionId
    ? normalizeSessionRecord(previousMap.get(currentSessionId) || null, previousMap.get(currentSessionId) || null)
    : null;
  sessions = mergeUniqueSessions([
    ...activeSessions,
    ...preservedArchived,
    ...(preservedCurrent?.archived === true ? [preservedCurrent] : []),
  ]);
  hasLoadedSessions = true;
  if (Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0) {
    archivedSessionCount = nextArchivedCount;
  }
  refreshAppCatalog();
  renderSessionList();
  if (currentSessionId && !sessions.some((session) => session.id === currentSessionId)) {
    currentSessionId = null;
    hasAttachedSession = false;
    clearMessages();
    showEmpty();
    restoreDraft();
  }
  return sessions;
}

function applyArchivedSessionListState(nextSessions, {
  archivedCount: nextArchivedCount = null,
} = {}) {
  const previousMap = new Map(sessions.map((session) => [session.id, session]));
  const preservedActive = sessions
    .filter((session) => session?.archived !== true)
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  const archivedSessions = (Array.isArray(nextSessions) ? nextSessions : [])
    .map((session) => normalizeSessionRecord(session, previousMap.get(session?.id) || null))
    .filter(Boolean);
  sessions = mergeUniqueSessions([...preservedActive, ...archivedSessions]);
  archivedSessionsLoaded = true;
  archivedSessionsLoading = false;
  archivedSessionCount = Number.isInteger(nextArchivedCount) && nextArchivedCount >= 0
    ? nextArchivedCount
    : archivedSessions.length;
  refreshAppCatalog();
  renderSessionList();
  return archivedSessions;
}

async function fetchSessionSidebar(sessionId) {
  const url = getSessionSidebarUrl(sessionId);
  const data = await fetchJsonOrRedirect(url);
  return upsertSession(data.session);
}

async function fetchArchivedSessions() {
  if (visitorMode) return [];
  if (archivedSessionsRefreshPromise) {
    return archivedSessionsRefreshPromise;
  }
  if (!archivedSessionsLoaded && archivedSessionCount === 0) {
    archivedSessionsLoaded = true;
    archivedSessionsLoading = false;
    renderSessionList();
    return [];
  }

  archivedSessionsLoading = true;
  renderSessionList();
  const request = (async () => {
    try {
      const data = await fetchJsonOrRedirect(ARCHIVED_SESSION_LIST_URL);
      return applyArchivedSessionListState(data.sessions || [], {
        archivedCount: Number.isInteger(data.archivedCount)
          ? data.archivedCount
          : (Array.isArray(data.sessions) ? data.sessions.length : 0),
      });
    } catch (error) {
      archivedSessionsLoading = false;
      renderSessionList();
      throw error;
    } finally {
      archivedSessionsRefreshPromise = null;
    }
  })();
  archivedSessionsRefreshPromise = request;
  return request;
}

async function fetchAppsList() {
  if (visitorMode) return [];
  const data = await fetchJsonOrRedirect("/api/apps");
  availableApps = Array.isArray(data.apps) ? data.apps : [];
  refreshAppCatalog();
  if (typeof renderSettingsAppsPanel === "function") {
    renderSettingsAppsPanel();
  }
  if (typeof renderUserAppOptions === "function") {
    renderUserAppOptions();
  }
  if (typeof renderSettingsUsersPanel === "function") {
    renderSettingsUsersPanel();
  }
  return availableApps;
}

async function createAppRecord(payload = {}) {
  const data = await fetchJsonOrRedirect("/api/apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await fetchAppsList();
  return data.app || null;
}

async function updateAppRecord(appId, payload = {}) {
  const data = await fetchJsonOrRedirect(`/api/apps/${encodeURIComponent(appId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await fetchAppsList();
  return data.app || null;
}

async function deleteAppRecord(appId) {
  await fetchJsonOrRedirect(`/api/apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
  });
  await fetchAppsList();
}

async function createVisitorRecord(payload = {}) {
  const data = await fetchJsonOrRedirect("/api/visitors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return data.visitor || null;
}

async function updateVisitorRecord(visitorId, payload = {}) {
  const data = await fetchJsonOrRedirect(`/api/visitors/${encodeURIComponent(visitorId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return data.visitor || null;
}

async function fetchUsersList() {
  if (visitorMode) return [];
  const data = await fetchJsonOrRedirect("/api/users");
  availableUsers = Array.isArray(data.users) ? data.users : [];
  refreshAppCatalog();
  if (typeof renderSettingsUsersPanel === "function") {
    renderSettingsUsersPanel();
  }
  return availableUsers;
}

async function createUserRecord(payload = {}) {
  const data = await fetchJsonOrRedirect("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await fetchUsersList();
  if (data.session) {
    upsertSession(data.session);
  }
  return { user: data.user || null, session: data.session || null };
}

async function updateUserRecord(userId, payload = {}) {
  const data = await fetchJsonOrRedirect(`/api/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await fetchUsersList();
  return data.user || null;
}

async function deleteUserRecord(userId) {
  await fetchJsonOrRedirect(`/api/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  await fetchUsersList();
}

async function fetchSessionsList() {
  if (visitorMode) return [];
  const data = await fetchJsonOrRedirect(SESSION_LIST_URL);
  applySessionListState(data.sessions || [], {
    board: data.board || null,
    taskBoard: data.taskBoard || null,
    archivedCount: Number.isInteger(data.archivedCount) ? data.archivedCount : 0,
  });
  return sessions;
}

function applyAttachedSessionState(id, session) {
  currentSessionId = id;
  hasAttachedSession = true;
  currentTokens = 0;
  contextTokens.style.display = "none";
  compactBtn.style.display = "none";
  dropToolsBtn.style.display = "none";

  const displayName = getSessionDisplayName(session);
  headerTitle.textContent = displayName;
  if (typeof reconcileComposerPendingSendWithSession === "function") {
    reconcileComposerPendingSendWithSession(session);
  }
  updateStatus("connected", session);
  if (typeof renderQueuedMessagePanel === "function") {
    renderQueuedMessagePanel(session);
  }

  if (session?.tool && toolsList.some((tool) => tool.id === session.tool)) {
    inlineToolSelect.value = session.tool;
    selectedTool = session.tool;
    Promise.resolve(loadModelsForCurrentTool()).catch(() => {});
  }

  restoreDraft();
  renderSessionList();
  syncBrowserState();
  syncForkButton();
  syncShareButton();
}

async function fetchSessionState(sessionId) {
  const data = await fetchJsonOrRedirect(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const normalized = upsertSession(data.session);
  if (normalized && currentSessionId === sessionId) {
    applyAttachedSessionState(sessionId, normalized);
  }
  return normalized;
}

async function fetchSessionEvents(sessionId, { runState = "idle" } = {}) {
  const hadRenderedMessages =
    messagesInner.children.length > 0 && emptyState.parentNode !== messagesInner;
  const shouldStickToBottom =
    !hadRenderedMessages ||
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  const data = await fetchJsonOrRedirect(
    `/api/sessions/${encodeURIComponent(sessionId)}/events?filter=visible`,
  );
  const events = data.events || [];
  if (currentSessionId !== sessionId) return events;
  const renderPlan = getEventRenderPlan(sessionId, events);

  if (renderPlan.mode === "reset") {
    clearMessages();
    if (events.length === 0) {
      showEmpty();
    }
    for (const event of events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    if (messagesInner.children.length === 0) {
      showEmpty();
    }
    updateRenderedEventState(sessionId, events, { runState });
    const latestTurnStart = applyFinishedTurnCollapseState();
    if (shouldFocusLatestTurnStart(latestTurnStart)) {
      scrollNodeToTop(latestTurnStart);
    } else if (events.length > 0 && shouldStickToBottom) {
      scrollToBottom();
    }
    return events;
  }

  if (renderPlan.mode === "append") {
    for (const event of renderPlan.events) {
      reconcilePendingMessageState(event);
      renderEvent(event, false);
    }
    updateRenderedEventState(sessionId, events, { runState });
    const latestTurnStart = applyFinishedTurnCollapseState();
    if (shouldFocusLatestTurnStart(latestTurnStart)) {
      scrollNodeToTop(latestTurnStart);
    } else if (renderPlan.events.length > 0 && shouldStickToBottom) {
      scrollToBottom();
    }
    return renderPlan.events;
  }

  updateRenderedEventState(sessionId, events, { runState });
  const latestTurnStart = applyFinishedTurnCollapseState();
  if (shouldFocusLatestTurnStart(latestTurnStart)) {
    scrollNodeToTop(latestTurnStart);
  }
  return events;
}

async function runCurrentSessionRefresh(sessionId) {
  const session = await fetchSessionState(sessionId);
  if (currentSessionId !== sessionId) return session;
  const runState = getSessionRunState(session);
  if (shouldFetchSessionEventsForRefresh(sessionId, session)) {
    await fetchSessionEvents(sessionId, { runState });
    return session;
  }
  renderedEventState.sessionId = sessionId;
  renderedEventState.runState = runState;
  return session;
}

async function refreshCurrentSession() {
  const sessionId = currentSessionId;
  if (!sessionId) return null;
  if (currentSessionRefreshPromise) {
    pendingCurrentSessionRefresh = true;
    return currentSessionRefreshPromise;
  }
  currentSessionRefreshPromise = (async () => {
    try {
      return await runCurrentSessionRefresh(sessionId);
    } finally {
      currentSessionRefreshPromise = null;
      if (pendingCurrentSessionRefresh) {
        pendingCurrentSessionRefresh = false;
        refreshCurrentSession().catch(() => {});
      }
    }
  })();
  return currentSessionRefreshPromise;
}

async function refreshSidebarSession(sessionId) {
  if (!sessionId || visitorMode) return null;
  if (sessionId === currentSessionId) {
    return refreshCurrentSession();
  }
  if (sidebarSessionRefreshPromises.has(sessionId)) {
    pendingSidebarSessionRefreshes.add(sessionId);
    return sidebarSessionRefreshPromises.get(sessionId);
  }
  const request = (async () => {
    try {
      const session = await fetchSessionSidebar(sessionId);
      if (session) {
        renderSessionList();
      }
      return session;
    } catch (error) {
      if (error?.message === "Session not found") {
        const nextSessions = sessions.filter((session) => session.id !== sessionId);
        if (nextSessions.length !== sessions.length) {
          sessions = nextSessions;
          refreshAppCatalog();
          renderSessionList();
        }
        return null;
      }
      throw error;
    } finally {
      sidebarSessionRefreshPromises.delete(sessionId);
      if (pendingSidebarSessionRefreshes.delete(sessionId)) {
        refreshSidebarSession(sessionId).catch(() => {});
      }
    }
  })();
  sidebarSessionRefreshPromises.set(sessionId, request);
  return request;
}

async function refreshRealtimeViews() {
  if (visitorMode) {
    if (currentSessionId) {
      await refreshCurrentSession().catch(() => {});
    }
    return;
  }

  await fetchSessionsList().catch(() => {});
  if (archivedSessionsLoaded) {
    await fetchArchivedSessions().catch(() => {});
  }
  if (currentSessionId) {
    await refreshCurrentSession().catch(() => {});
  }
}

async function bootstrapViaHttp({ deferOwnerRestore = false } = {}) {
  if (visitorMode && visitorSessionId) {
    currentSessionId = visitorSessionId;
    attachSession(visitorSessionId, { id: visitorSessionId, name: "Session", status: "idle" });
    await refreshCurrentSession();
    return;
  }
  await fetchSessionsList();
  if (!deferOwnerRestore) {
    restoreOwnerSessionSelection();
  }
}

async function setupPushNotifications() {
  if (visitorMode) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const reg = await navigator.serviceWorker.register(
      `/sw.js?v=${encodeURIComponent(buildAssetVersion)}`,
      { updateViaCache: "none" },
    );
    await reg.update().catch(() => {});
    reg.installing?.postMessage({ type: "remotelab:clear-caches" });
    reg.waiting?.postMessage({ type: "remotelab:clear-caches" });
    reg.active?.postMessage({ type: "remotelab:clear-caches" });
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return; // already subscribed
    const res = await fetch("/api/push/vapid-public-key");
    if (!res.ok) return;
    const { publicKey } = await res.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    console.log("[push] Subscribed to web push");
  } catch (err) {
    console.warn("[push] Setup failed:", err.message);
  }
}
