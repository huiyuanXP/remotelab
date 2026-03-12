// ---- Send message ----
function sendMessage(existingRequestId) {
  const text = msgInput.value.trim();
  const currentSession = getCurrentSession();
  if ((!text && pendingImages.length === 0) || !currentSessionId || currentSession?.archived) return;

  const requestId = existingRequestId || createRequestId();
  const sessionId = currentSessionId;

  // Protect the message: save to localStorage before anything else
  const pendingTimestamp = savePendingMessage(text, requestId);

  // Render optimistic bubble BEFORE revoking image URLs
  renderOptimisticMessage(text, pendingImages, pendingTimestamp);

  const msg = { action: "send", text: text || "(image)" };
  msg.requestId = requestId;
  if (!visitorMode) {
    if (selectedTool) msg.tool = selectedTool;
    if (selectedModel) msg.model = selectedModel;
    if (currentToolReasoningKind === "enum") {
      if (selectedEffort) msg.effort = selectedEffort;
    } else if (currentToolReasoningKind === "toggle") {
      msg.thinking = thinkingEnabled;
    }
  }
  if (pendingImages.length > 0) {
    msg.images = pendingImages.map((img) => ({
      data: img.data,
      mimeType: img.mimeType,
    }));
    pendingImages.forEach((img) => URL.revokeObjectURL(img.objectUrl));
    pendingImages = [];
    renderImagePreviews();
  }
  if (sessionTemplateRow) {
    sessionTemplateRow.hidden = true;
  }
  markSessionSendInFlight(sessionId);
  void dispatchAction(msg).then((ok) => {
    const changed = finishSessionSendAttempt(sessionId, ok);
    if (!ok && sessionId === currentSessionId) {
      clearOptimisticMessage();
      const pending = getPendingMessage(sessionId);
      if (pending) {
        renderPendingRecovery(pending);
      }
    }
    if (changed || !ok) {
      refreshSessionAttentionUi(sessionId);
    }
  });
  msgInput.value = "";
  clearDraft();
  autoResizeInput();
}

let templateStatusTimer = null;

function setSessionTemplateStatus(text, { persistent = false } = {}) {
  if (!sessionTemplateStatus) return;
  sessionTemplateStatus.textContent = text || "";
  sessionTemplateStatus.dataset.persistent = persistent ? "true" : "false";
  if (templateStatusTimer) {
    window.clearTimeout(templateStatusTimer);
    templateStatusTimer = null;
  }
  if (text && !persistent) {
    templateStatusTimer = window.setTimeout(() => {
      if (sessionTemplateStatus.dataset.persistent !== "true") {
        sessionTemplateStatus.textContent = "";
      }
    }, 1800);
  }
}

function updateSaveTemplateButtonLabel(label, { reset = true } = {}) {
  if (!saveTemplateBtn) return;
  const original = saveTemplateBtn.dataset.originalLabel || saveTemplateBtn.textContent;
  saveTemplateBtn.dataset.originalLabel = original;
  saveTemplateBtn.textContent = label;
  window.clearTimeout(saveTemplateBtn._resetTimer);
  if (!reset) return;
  saveTemplateBtn._resetTimer = window.setTimeout(() => {
    saveTemplateBtn.textContent = saveTemplateBtn.dataset.originalLabel || original;
    syncSessionTemplateControls();
  }, 1600);
}

function syncSessionTemplateControls() {
  const session = getCurrentSession();
  const hasSession = !!session && !!currentSessionId;
  const templateApps = typeof getTemplateApps === "function" ? getTemplateApps() : [];
  const canSaveTemplate = !visitorMode && hasSession && !session.archived && session.status !== "running";

  if (saveTemplateBtn) {
    saveTemplateBtn.style.display = !visitorMode && hasSession ? "" : "none";
    saveTemplateBtn.disabled = !canSaveTemplate;
  }

  if (!sessionTemplateRow || !sessionTemplateSelect) return;

  const showTemplatePicker = !visitorMode
    && hasSession
    && !session.archived
    && (session.messageCount || 0) === 0
    && templateApps.length > 0;

  sessionTemplateRow.hidden = !showTemplatePicker;
  if (!showTemplatePicker) {
    sessionTemplateSelect.disabled = true;
    setSessionTemplateStatus("");
    return;
  }

  const previousValue = sessionTemplateSelect.value;
  const appliedTemplateId = normalizeAppId(session?.templateAppId || "");
  const selectedValue = templateApps.some((app) => app.id === appliedTemplateId)
    ? appliedTemplateId
    : templateApps.some((app) => app.id === previousValue)
      ? previousValue
      : "";

  sessionTemplateSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = appliedTemplateId ? "Template applied" : "Apply a saved template…";
  sessionTemplateSelect.appendChild(placeholder);

  for (const app of templateApps) {
    const option = document.createElement("option");
    option.value = app.id;
    option.textContent = app.name || app.id;
    sessionTemplateSelect.appendChild(option);
  }

  sessionTemplateSelect.value = selectedValue;
  sessionTemplateSelect.disabled = !!appliedTemplateId || session.status === "running";

  if (appliedTemplateId) {
    const appliedName = session?.templateAppName || templateApps.find((app) => app.id === appliedTemplateId)?.name || "template";
    setSessionTemplateStatus(`Applied: ${appliedName}`, { persistent: true });
  } else {
    setSessionTemplateStatus("");
  }
}

if (sessionTemplateSelect) {
  sessionTemplateSelect.addEventListener("change", async () => {
    const appId = normalizeAppId(sessionTemplateSelect.value || "");
    if (!appId || !currentSessionId) return;
    sessionTemplateSelect.disabled = true;
    setSessionTemplateStatus("Applying…");
    const ok = await dispatchAction({ action: "apply_template", sessionId: currentSessionId, appId });
    if (!ok) {
      setSessionTemplateStatus("Apply failed");
      sessionTemplateSelect.disabled = false;
      return;
    }
    setSessionTemplateStatus("Applied", { persistent: true });
  });
}

if (saveTemplateBtn) {
  saveTemplateBtn.addEventListener("click", async () => {
    const session = getCurrentSession();
    if (!session?.id || visitorMode || session.archived || session.status === "running") return;
    const defaultName = session.name || "Untitled template";
    const name = window.prompt("Template name", defaultName);
    if (name === null) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;

    saveTemplateBtn.disabled = true;
    updateSaveTemplateButtonLabel("Saving…", { reset: false });
    const ok = await dispatchAction({ action: "save_template", sessionId: session.id, name: trimmedName });
    if (ok) {
      updateSaveTemplateButtonLabel("Saved");
    } else {
      updateSaveTemplateButtonLabel("Failed");
    }
    syncSessionTemplateControls();
  });
}

cancelBtn.addEventListener("click", () => dispatchAction({ action: "cancel" }));
resumeBtn.addEventListener("click", () => dispatchAction({ action: "resume_interrupted" }));

compactBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "compact" });
});

dropToolsBtn.addEventListener("click", () => {
  if (!currentSessionId) return;
  dispatchAction({ action: "drop_tools" });
});

sendBtn.addEventListener("click", sendMessage);
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});

// ---- Composer height ----
const INPUT_MIN_LINES = 3;
const INPUT_AUTO_MAX_LINES = 10;
const INPUT_MANUAL_MIN_H = 100;
const INPUT_MAX_VIEWPORT_RATIO = 0.72;
const INPUT_HEIGHT_STORAGE_KEY = "msgInputHeight";
const LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY = "inputAreaHeight";

let isResizingInput = false;
let resizeStartY = 0;
let resizeStartInputH = 0;

function getInputLineHeight() {
  return parseFloat(getComputedStyle(msgInput).lineHeight) || 24;
}

function getAutoInputMinH() {
  return getInputLineHeight() * INPUT_MIN_LINES;
}

function getAutoInputMaxH() {
  return getInputLineHeight() * INPUT_AUTO_MAX_LINES;
}

function getInputChromeH() {
  if (!inputArea?.getBoundingClientRect || !msgInput?.getBoundingClientRect) {
    return 0;
  }
  const areaH = inputArea.getBoundingClientRect().height || 0;
  const inputH = msgInput.getBoundingClientRect().height || 0;
  return Math.max(0, areaH - inputH);
}

function getViewportHeight() {
  const visualHeight = window.visualViewport?.height;
  if (Number.isFinite(visualHeight) && visualHeight > 0) {
    return visualHeight;
  }
  return window.innerHeight || 0;
}

function getManualInputMaxH() {
  const viewportMax = Math.floor(getViewportHeight() * INPUT_MAX_VIEWPORT_RATIO);
  return Math.max(INPUT_MANUAL_MIN_H, viewportMax - getInputChromeH());
}

function clampInputHeight(height, { manual = false } = {}) {
  const minH = getAutoInputMinH();
  const maxH = manual
    ? Math.max(minH, getManualInputMaxH())
    : Math.max(minH, getAutoInputMaxH());
  return Math.min(Math.max(height, minH), maxH);
}

function isManualInputHeightActive() {
  return inputArea.classList.contains("is-resized");
}

function setManualInputHeight(height, { persist = true } = {}) {
  const newH = clampInputHeight(height, { manual: true });
  msgInput.style.height = newH + "px";
  inputArea.classList.add("is-resized");
  if (persist) {
    localStorage.setItem(INPUT_HEIGHT_STORAGE_KEY, String(newH));
    localStorage.removeItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  }
  return newH;
}

function autoResizeInput() {
  if (isManualInputHeightActive()) return;
  msgInput.style.height = "auto";
  const newH = clampInputHeight(msgInput.scrollHeight);
  msgInput.style.height = newH + "px";
}

function restoreSavedInputHeight() {
  const savedInputH = localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY);
  if (savedInputH) {
    const height = parseInt(savedInputH, 10);
    if (Number.isFinite(height) && height > 0) {
      setManualInputHeight(height, { persist: false });
      return;
    }
    localStorage.removeItem(INPUT_HEIGHT_STORAGE_KEY);
  }

  const legacyInputAreaH = localStorage.getItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  if (legacyInputAreaH) {
    const legacyHeight = parseInt(legacyInputAreaH, 10);
    if (Number.isFinite(legacyHeight) && legacyHeight > 0) {
      const migratedHeight = Math.max(
        getAutoInputMinH(),
        legacyHeight - getInputChromeH(),
      );
      setManualInputHeight(migratedHeight);
      return;
    }
    localStorage.removeItem(LEGACY_INPUT_AREA_HEIGHT_STORAGE_KEY);
  }

  autoResizeInput();
}

function syncInputHeightForLayout() {
  if (!isManualInputHeightActive()) {
    autoResizeInput();
    return;
  }

  const currentHeight = parseFloat(msgInput.style.height);
  if (Number.isFinite(currentHeight) && currentHeight > 0) {
    setManualInputHeight(currentHeight, { persist: false });
    return;
  }

  const savedInputH = parseInt(
    localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY) || "",
    10,
  );
  if (Number.isFinite(savedInputH) && savedInputH > 0) {
    setManualInputHeight(savedInputH, { persist: false });
    return;
  }

  inputArea.classList.remove("is-resized");
  autoResizeInput();
}

function onInputResizeStart(e) {
  isResizingInput = true;
  resizeStartY = e.touches ? e.touches[0].clientY : e.clientY;
  resizeStartInputH = msgInput.getBoundingClientRect().height || getAutoInputMinH();
  document.addEventListener("mousemove", onInputResizeMove);
  document.addEventListener("touchmove", onInputResizeMove, { passive: false });
  document.addEventListener("mouseup", onInputResizeEnd);
  document.addEventListener("touchend", onInputResizeEnd);
  e.preventDefault();
}

function onInputResizeMove(e) {
  if (!isResizingInput) return;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const dy = resizeStartY - clientY;
  setManualInputHeight(resizeStartInputH + dy);
  e.preventDefault();
}

function onInputResizeEnd() {
  isResizingInput = false;
  document.removeEventListener("mousemove", onInputResizeMove);
  document.removeEventListener("touchmove", onInputResizeMove);
  document.removeEventListener("mouseup", onInputResizeEnd);
  document.removeEventListener("touchend", onInputResizeEnd);
}

if (inputResizeHandle) {
  inputResizeHandle.addEventListener("mousedown", onInputResizeStart);
  inputResizeHandle.addEventListener("touchstart", onInputResizeStart, { passive: false });
}

window.addEventListener("resize", syncInputHeightForLayout);
window.visualViewport?.addEventListener("resize", syncInputHeightForLayout);

// ---- Draft persistence ----
function saveDraft() {
  if (!currentSessionId) return;
  if (msgInput.value) {
    localStorage.setItem(`draft_${currentSessionId}`, msgInput.value);
    return;
  }
  localStorage.removeItem(`draft_${currentSessionId}`);
}
function restoreDraft() {
  const draft = currentSessionId
    ? localStorage.getItem(`draft_${currentSessionId}`)
    : "";
  msgInput.value = draft ?? "";
  autoResizeInput();
}
function clearDraft() {
  if (!currentSessionId) return;
  localStorage.removeItem(`draft_${currentSessionId}`);
}

msgInput.addEventListener("input", () => {
  autoResizeInput();
  saveDraft();
});
// Set initial height
requestAnimationFrame(() => restoreSavedInputHeight());

// ---- Pending message protection ----
// Saves sent message to localStorage until server confirms receipt.
// Prevents message loss on refresh, network failure, or server crash.
function savePendingMessage(text, requestId) {
  if (!currentSessionId) return;
  clearSessionSendFailed(currentSessionId);
  const timestamp = Date.now();
  localStorage.setItem(
    `pending_msg_${currentSessionId}`,
    JSON.stringify({ text, requestId, timestamp }),
  );
  return timestamp;
}
function clearPendingMessage(sessionId) {
  const targetId = sessionId || currentSessionId;
  if (!targetId) return false;
  localStorage.removeItem(`pending_msg_${targetId}`);
  return clearSessionSendFailed(targetId);
}
function getPendingMessage(sessionId) {
  const raw = localStorage.getItem(
    `pending_msg_${sessionId || currentSessionId}`,
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function renderOptimisticMessage(text, images, timestamp = Date.now()) {
  if (emptyState.parentNode === messagesInner) emptyState.remove();
  // Remove any previous optimistic message
  clearOptimisticMessage();

  const wrap = document.createElement("div");
  wrap.className = "msg-user";
  wrap.id = "optimistic-msg";
  const bubble = document.createElement("div");
  bubble.className = "msg-user-bubble msg-pending";

  if (images && images.length > 0) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "msg-images";
    for (const img of images) {
      const imgEl = document.createElement("img");
      imgEl.src = `data:${img.mimeType};base64,${img.data}`;
      imgEl.alt = "attached image";
      imgWrap.appendChild(imgEl);
    }
    bubble.appendChild(imgWrap);
  }

  if (text) {
    const span = document.createElement("span");
    span.textContent = text;
    bubble.appendChild(span);
  }

  appendMessageTimestamp(bubble, timestamp, "msg-user-time");

  wrap.appendChild(bubble);
  messagesInner.appendChild(wrap);
  scrollToBottom();
}

function clearOptimisticMessage() {
  const prev = document.getElementById("optimistic-msg");
  if (prev) prev.remove();
}

function renderPendingRecovery(pending) {
  document.getElementById("pending-msg-recovery")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "msg-user";
  wrap.id = "pending-msg-recovery";
  const bubble = document.createElement("div");
  bubble.className = "msg-user-bubble msg-failed";

  if (pending.text) {
    const span = document.createElement("span");
    span.textContent = pending.text;
    bubble.appendChild(span);
  }

  appendMessageTimestamp(bubble, pending.timestamp, "msg-user-time");

  const actions = document.createElement("div");
  actions.className = "msg-failed-actions";

  const retryBtn = document.createElement("button");
  retryBtn.textContent = "Resend";
  retryBtn.className = "msg-retry-btn";
  retryBtn.onclick = () => {
    wrap.remove();
    const changed = clearPendingMessage();
    if (changed) {
      refreshSessionAttentionUi();
    }
    msgInput.value = pending.text;
    sendMessage(pending.requestId);
  };

  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.className = "msg-edit-btn";
  editBtn.onclick = () => {
    msgInput.value = pending.text;
    autoResizeInput();
    wrap.remove();
    const changed = clearPendingMessage();
    if (changed) {
      refreshSessionAttentionUi();
    }
    msgInput.focus();
  };

  const discardBtn = document.createElement("button");
  discardBtn.textContent = "Discard";
  discardBtn.className = "msg-discard-btn";
  discardBtn.onclick = () => {
    wrap.remove();
    const changed = clearPendingMessage();
    if (changed) {
      refreshSessionAttentionUi();
    }
  };

  actions.appendChild(retryBtn);
  actions.appendChild(editBtn);
  actions.appendChild(discardBtn);
  bubble.appendChild(actions);

  wrap.appendChild(bubble);
  messagesInner.appendChild(wrap);
  scrollToBottom();
}

function isPendingMessageEntryStale(pending) {
  if (!pending) return false;
  const timestamp = Number(pending.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
  return Date.now() - timestamp >= PENDING_MESSAGE_STALE_MS;
}

function checkPendingMessage(historyEvents) {
  const pending = getPendingMessage();
  if (!pending) return;

  // Check if the pending message already exists in history
  // (server received it but client didn't get confirmation before refresh)
  const lastUserMsg = [...historyEvents]
    .reverse()
    .find((e) => e.type === "message" && e.role === "user");
  if (
    lastUserMsg &&
    ((pending.requestId && lastUserMsg.requestId === pending.requestId) ||
      (lastUserMsg.content === pending.text &&
        lastUserMsg.timestamp >= pending.timestamp - 5000))
  ) {
    const changed = clearPendingMessage();
    if (changed) {
      refreshSessionAttentionUi();
    }
    return;
  }

  if (!isPendingMessageEntryStale(pending)) {
    const changed = clearSessionSendFailed(currentSessionId);
    if (changed) {
      refreshSessionAttentionUi();
    }
    return;
  }

  markSessionSendFailed(currentSessionId);
  refreshSessionAttentionUi();

  // Show the pending message with recovery actions
  renderPendingRecovery(pending);
}

// ---- Sidebar tabs ----
let activeTab = normalizeSidebarTab(
  pendingNavigationState.tab ||
    localStorage.getItem(ACTIVE_SIDEBAR_TAB_STORAGE_KEY) ||
    "sessions",
); // "sessions" | "settings"

function switchTab(tab, { syncState = true } = {}) {
  activeTab = normalizeSidebarTab(tab);
  const showingSessions = activeTab === "sessions";
  tabSessions.classList.toggle("active", activeTab === "sessions");
  tabSettings.classList.toggle("active", activeTab === "settings");
  if (typeof syncSidebarFiltersVisibility === "function") {
    syncSidebarFiltersVisibility(showingSessions);
  } else if (sidebarFilters) {
    sidebarFilters.classList.toggle("hidden", !showingSessions);
  }
  sessionList.style.display = showingSessions ? "" : "none";
  settingsPanel.classList.toggle("visible", activeTab === "settings");
  sessionListFooter.classList.toggle("hidden", !showingSessions);
  newSessionBtn.classList.toggle("hidden", !showingSessions);
  if (syncState) {
    syncBrowserState();
  }
}

tabSessions.addEventListener("click", () => switchTab("sessions"));
tabSettings.addEventListener("click", () => switchTab("settings"));
switchTab(activeTab, { syncState: false });
