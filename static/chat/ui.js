function renderUiIcon(name, className = "") {
  return window.RemoteLabIcons?.render(name, { className }) || "";
}

function renderMarkdownIntoNode(node, markdown) {
  const source = typeof markdown === "string" ? markdown : "";
  const rendered = marked.parse(source);
  if (rendered.trim()) {
    node.innerHTML = rendered;
    enhanceCodeBlocks(node);
    enhanceRenderedContentLinks(node);
    return true;
  }
  node.textContent = formatDecodedDisplayText(source);
  return !!source.trim();
}

function markLazyEventBodyNode(node, evt, { preview = "", renderMode = "text" } = {}) {
  if (!node || !evt?.bodyAvailable || evt.bodyLoaded) return false;
  if (!Number.isInteger(evt.seq) || evt.seq < 1) return false;
  node.dataset.eventSeq = String(evt.seq);
  node.dataset.bodyPending = "true";
  node.dataset.bodyRender = renderMode;
  const resolvedPreview = typeof preview === "string" && preview
    ? preview
    : (evt.bodyPreview || "");
  if (resolvedPreview) {
    node.dataset.preview = resolvedPreview;
  } else {
    delete node.dataset.preview;
  }
  return true;
}

function getAttachmentDisplayName(attachment) {
  const originalName = typeof attachment?.originalName === "string"
    ? attachment.originalName.trim()
    : "";
  if (originalName) return originalName;
  const filename = typeof attachment?.filename === "string"
    ? attachment.filename.trim()
    : "";
  return filename || "attachment";
}

function getAttachmentKind(attachment) {
  const mimeType = typeof attachment?.mimeType === "string"
    ? attachment.mimeType
    : "";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  return "file";
}

function getAttachmentSource(attachment) {
  if (typeof attachment?.objectUrl === "string" && attachment.objectUrl) {
    return attachment.objectUrl;
  }
  if (typeof attachment?.filename === "string" && attachment.filename) {
    return `/api/media/${encodeURIComponent(attachment.filename)}`;
  }
  return "";
}

function createMessageAttachmentNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const kind = getAttachmentKind(attachment);
  const label = getAttachmentDisplayName(attachment);

  if (kind === "image") {
    const imgEl = document.createElement("img");
    imgEl.src = source;
    imgEl.alt = label;
    imgEl.loading = "lazy";
    imgEl.onclick = () => window.open(source, "_blank");
    return imgEl;
  }

  if (kind === "video") {
    const videoEl = document.createElement("video");
    videoEl.src = source;
    videoEl.controls = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    return videoEl;
  }

  const link = document.createElement("a");
  link.href = source;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "attachment-link";
  link.textContent = label;
  return link;
}

function createComposerAttachmentPreviewNode(attachment) {
  const source = getAttachmentSource(attachment);
  if (!source) return null;
  const kind = getAttachmentKind(attachment);
  if (kind === "image") {
    const imgEl = document.createElement("img");
    imgEl.src = source;
    imgEl.alt = getAttachmentDisplayName(attachment);
    return imgEl;
  }
  if (kind === "video") {
    const videoEl = document.createElement("video");
    videoEl.src = source;
    videoEl.muted = true;
    videoEl.preload = "metadata";
    videoEl.playsInline = true;
    return videoEl;
  }

  const fileEl = document.createElement("div");
  fileEl.className = "attachment-file";
  fileEl.textContent = getAttachmentDisplayName(attachment);
  return fileEl;
}

// ---- Render functions ----
function renderMessage(evt) {
  const role = evt.role || "assistant";

  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }

  if (role === "user") {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "msg-user-bubble";
    if (evt.images && evt.images.length > 0) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "msg-images";
      for (const img of evt.images) {
        const attachmentNode = createMessageAttachmentNode(img);
        if (!attachmentNode) continue;
        imgWrap.appendChild(attachmentNode);
      }
      bubble.appendChild(imgWrap);
    }
    if (evt.content || evt.bodyAvailable) {
      const span = document.createElement("span");
      const preview = evt.content || evt.bodyPreview || "Load message…";
      span.textContent = formatDecodedDisplayText(preview);
      bubble.appendChild(span);
      if (markLazyEventBodyNode(span, evt, {
        preview: evt.bodyPreview || evt.content || "",
        renderMode: "text",
      })) {
        if (typeof queueHydrateLazyNodes === "function") {
          queueHydrateLazyNodes(wrap);
        }
      }
    }
    appendMessageTimestamp(bubble, evt.timestamp, "msg-user-time");
    wrap.appendChild(bubble);
    messagesInner.appendChild(wrap);
  } else {
    const div = document.createElement("div");
    div.className = "msg-assistant md-content";
    const content = document.createElement("div");
    content.className = "msg-assistant-body";
    if (evt.content) {
      const didRender = renderMarkdownIntoNode(content, evt.content);
      if (!didRender) return;
    } else if (evt.bodyAvailable) {
      content.textContent = "Load message…";
    } else {
      return;
    }
    div.appendChild(content);
    if (markLazyEventBodyNode(content, evt, {
      preview: evt.bodyPreview || "",
      renderMode: "markdown",
    })) {
      if (typeof queueHydrateLazyNodes === "function") {
        queueHydrateLazyNodes(div);
      }
    }
    appendMessageTimestamp(div, evt.timestamp, "msg-assistant-time");
    messagesInner.appendChild(div);
  }
}

function renderToolUse(evt) {
  const container = getThinkingBody();
  if (currentThinkingBlock && evt.toolName) {
    currentThinkingBlock.tools.add(evt.toolName);
  }

  const card = document.createElement("div");
  card.className = "tool-card";

  const header = document.createElement("div");
  header.className = "tool-header";
  header.innerHTML = `<span class="tool-name">${esc(evt.toolName || "tool")}</span>
    <span class="tool-toggle">${renderUiIcon("chevron-right")}</span>`;

  const body = document.createElement("div");
  body.className = "tool-body";
  body.id = "tool_" + evt.id;
  const pre = document.createElement("pre");
  pre.textContent = evt.toolInput || (evt.bodyAvailable ? "Load command…" : "");
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    pre.dataset.eventSeq = String(evt.seq || "");
    pre.dataset.bodyPending = "true";
    pre.dataset.preview = evt.toolInput || "";
  }
  body.appendChild(pre);

  header.addEventListener("click", async () => {
    header.classList.toggle("expanded");
    body.classList.toggle("expanded");
    if (body.classList.contains("expanded")) {
      await hydrateLazyNodes(body);
    }
  });

  card.appendChild(header);
  card.appendChild(body);
  card.dataset.toolId = evt.id;
  container.appendChild(card);
}

function renderToolResult(evt) {
  // Search in current thinking block body, or fall back to messagesInner
  const searchRoot =
    inThinkingBlock && currentThinkingBlock
      ? currentThinkingBlock.body
      : messagesInner;

  const cards = searchRoot.querySelectorAll(".tool-card");
  let targetCard = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    if (!cards[i].querySelector(".tool-result")) {
      targetCard = cards[i];
      break;
    }
  }

  if (targetCard) {
    const body = targetCard.querySelector(".tool-body");
    const label = document.createElement("div");
    label.className = "tool-result-label";
    label.innerHTML =
      "Result" +
      (evt.exitCode !== undefined
        ? `<span class="exit-code ${evt.exitCode === 0 ? "ok" : "fail"}">${evt.exitCode === 0 ? "exit 0" : "exit " + evt.exitCode}</span>`
        : "");
    const pre = document.createElement("pre");
    pre.className = "tool-result";
    pre.textContent = evt.output || (evt.bodyAvailable ? "Load result…" : "");
    if (evt.bodyAvailable && !evt.bodyLoaded) {
      pre.dataset.eventSeq = String(evt.seq || "");
      pre.dataset.bodyPending = "true";
      pre.dataset.preview = evt.output || "";
    }
    body.appendChild(label);
    body.appendChild(pre);
  }
}

function renderFileChange(evt) {
  const container = getThinkingBody();
  const div = document.createElement("div");
  div.className = "file-card";
  const kind = evt.changeType || "edit";
  const filePath = evt.filePath || "";
  const pathMarkup = filePath && isLikelyLocalEditorHref(filePath)
    ? `<a class="file-path" href="${esc(filePath)}">${esc(filePath)}</a>`
    : `<span class="file-path">${esc(filePath)}</span>`;
  div.innerHTML = `${pathMarkup}
    <span class="change-type ${kind}">${kind}</span>`;
  enhanceRenderedContentLinks(div);
  container.appendChild(div);
}

function renderReasoning(evt) {
  const container = getThinkingBody();
  const div = document.createElement("div");
  div.className = "reasoning";
  div.textContent = evt.content || (evt.bodyAvailable ? "Load thinking…" : "");
  if (evt.bodyAvailable && !evt.bodyLoaded) {
    div.dataset.eventSeq = String(evt.seq || "");
    div.dataset.bodyPending = "true";
    div.dataset.preview = evt.content || "";
  }
  container.appendChild(div);
}

function renderStatusMsg(evt) {
  // Finalize thinking block when the AI turn ends (completed/error)
  if (inThinkingBlock && evt.content !== "thinking") {
    finalizeThinkingBlock();
  }
  if (
    !evt.content ||
    evt.content === "completed" ||
    evt.content === "thinking"
  )
    return;
  const div = document.createElement("div");
  div.className = "msg-system";
  div.textContent = evt.content;
  messagesInner.appendChild(div);
}

function renderContextBarrier(evt) {
  if (inThinkingBlock) {
    finalizeThinkingBlock();
  }
  const div = document.createElement("div");
  div.className = "context-barrier";
  div.textContent = evt.content || "Older messages above this marker are no longer in live context.";
  messagesInner.appendChild(div);
}

function formatCompactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  return `${Math.round(n / 1000)}K`;
}

function getContextTokens(evt) {
  if (Number.isFinite(evt?.contextTokens)) return evt.contextTokens;
  return 0;
}

function getContextWindowTokens(evt) {
  if (Number.isFinite(evt?.contextWindowTokens)) return evt.contextWindowTokens;
  return 0;
}

function getContextPercent(contextSize, contextWindowSize) {
  if (!(contextSize > 0) || !(contextWindowSize > 0)) return null;
  return (contextSize / contextWindowSize) * 100;
}

function formatContextPercent(percent, { precise = false } = {}) {
  if (!Number.isFinite(percent)) return "";
  if (precise) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function updateContextDisplay(contextSize, contextWindowSize) {
  currentTokens = contextSize;
  if (contextSize > 0 && currentSessionId) {
    const percent = getContextPercent(contextSize, contextWindowSize);
    contextTokens.textContent = percent !== null
      ? `${formatCompactTokens(contextSize)} live · ${formatContextPercent(percent)}`
      : `${formatCompactTokens(contextSize)} live`;
    contextTokens.title = percent !== null
      ? `Live context: ${contextSize.toLocaleString()} / ${contextWindowSize.toLocaleString()} (${formatContextPercent(percent, { precise: true })})`
      : `Live context: ${contextSize.toLocaleString()}`;
    contextTokens.style.display = "";
    compactBtn.style.display = "";
    dropToolsBtn.style.display = "";
  }
}

function renderUsage(evt) {
  const contextSize = getContextTokens(evt);
  if (!(contextSize > 0)) return;
  const contextWindowSize = getContextWindowTokens(evt);
  const percent = getContextPercent(contextSize, contextWindowSize);
  const output = evt.outputTokens || 0;
  const div = document.createElement("div");
  div.className = "usage-info";
  const parts = [`${formatCompactTokens(contextSize)} live context`];
  if (percent !== null) parts.push(`${formatContextPercent(percent, { precise: true })} window`);
  if (output > 0) parts.push(`${formatCompactTokens(output)} out`);
  div.textContent = parts.join(" · ");
  const hover = [`Live context: ${contextSize.toLocaleString()}`];
  if (contextWindowSize > 0) hover.push(`Context window: ${contextWindowSize.toLocaleString()}`);
  if (Number.isFinite(evt?.inputTokens) && evt.inputTokens !== contextSize) {
    hover.push(`Raw turn input: ${evt.inputTokens.toLocaleString()}`);
  }
  if (output > 0) hover.push(`Turn output: ${output.toLocaleString()}`);
  div.title = hover.join("\n");
  messagesInner.appendChild(div);
  updateContextDisplay(contextSize, contextWindowSize);
}

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}

function getShortFolder(folder) {
  return (folder || "").replace(/^\/Users\/[^/]+/, "~");
}

function getFolderLabel(folder) {
  const shortFolder = getShortFolder(folder);
  return shortFolder.split("/").pop() || shortFolder || "Session";
}

function getSessionDisplayName(session) {
  return session?.name || getFolderLabel(session?.folder) || "Session";
}

function formatQueuedMessageTimestamp(stamp) {
  if (!stamp) return "Queued";
  const parsed = new Date(stamp).getTime();
  if (!Number.isFinite(parsed)) return "Queued";
  return `Queued ${messageTimeFormatter.format(parsed)}`;
}

function renderQueuedMessagePanel(session) {
  if (!queuedPanel) return;
  const items = Array.isArray(session?.queuedMessages) ? session.queuedMessages : [];
  if (!session?.id || session.id !== currentSessionId || items.length === 0) {
    queuedPanel.innerHTML = "";
    queuedPanel.classList.remove("visible");
    return;
  }

  queuedPanel.innerHTML = "";
  queuedPanel.classList.add("visible");

  const header = document.createElement("div");
  header.className = "queued-panel-header";

  const title = document.createElement("div");
  title.className = "queued-panel-title";
  title.textContent = items.length === 1 ? "1 follow-up queued" : `${items.length} follow-ups queued`;

  const note = document.createElement("div");
  note.className = "queued-panel-note";
  const activity = getSessionActivity(session);
  note.textContent = activity.run.state === "running" || activity.compact.state === "pending"
    ? "Will send automatically after the current run"
    : "Preparing the next turn";

  header.appendChild(title);
  header.appendChild(note);
  queuedPanel.appendChild(header);

  const list = document.createElement("div");
  list.className = "queued-list";
  const visibleItems = items.slice(-5);
  for (const item of visibleItems) {
    const row = document.createElement("div");
    row.className = "queued-item";

    const meta = document.createElement("div");
    meta.className = "queued-item-meta";
    meta.textContent = formatQueuedMessageTimestamp(item.queuedAt);

    const text = document.createElement("div");
    text.className = "queued-item-text";
    text.textContent = item.text || "(attachment)";

    row.appendChild(meta);
    row.appendChild(text);

    const imageNames = (item.images || []).map((image) => getAttachmentDisplayName(image)).filter(Boolean);
    if (imageNames.length > 0) {
      const imageLine = document.createElement("div");
      imageLine.className = "queued-item-images";
      imageLine.textContent = `Attachments: ${imageNames.join(", ")}`;
      row.appendChild(imageLine);
    }

    list.appendChild(row);
  }

  queuedPanel.appendChild(list);

  if (items.length > visibleItems.length) {
    const more = document.createElement("div");
    more.className = "queued-panel-more";
    more.textContent = `${items.length - visibleItems.length} older queued follow-up${items.length - visibleItems.length === 1 ? "" : "s"} hidden`;
    queuedPanel.appendChild(more);
  }
}

function renderSessionMessageCount(session) {
  const count = Number.isInteger(session?.messageCount)
    ? session.messageCount
    : (Number.isInteger(session?.activeMessageCount) ? session.activeMessageCount : 0);
  if (count <= 0) return "";
  const label = `${count} msg${count === 1 ? "" : "s"}`;
  return `<span class="session-item-count" title="Messages in this session">${label}</span>`;
}

function getWorkflowStatusInfo(value) {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
  if (["waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input"].includes(normalized)) {
    return {
      key: "waiting_user",
      label: "waiting",
      className: "status-waiting-user",
      dotClass: "",
      itemClass: "",
      title: "Waiting on user input",
    };
  }
  if (["done", "complete", "completed", "finished"].includes(normalized)) {
    return {
      key: "done",
      label: "done",
      className: "status-done",
      dotClass: "",
      itemClass: "",
      title: "Current task complete",
    };
  }
  if (["parked", "paused", "pause", "backlog", "todo"].includes(normalized)) {
    return {
      key: "parked",
      label: "parked",
      className: "status-parked",
      dotClass: "",
      itemClass: "",
      title: "Parked for later",
    };
  }
  return null;
}

function getSessionMetaStatusInfo(session) {
  const liveStatus = getSessionStatusSummary(session).primary;
  if (liveStatus?.key && liveStatus.key !== "idle") {
    return liveStatus;
  }
  return getWorkflowStatusInfo(session?.workflowState) || liveStatus;
}

function buildSessionMetaParts(session) {
  const parts = [];
  const countHtml = renderSessionMessageCount(session);
  if (countHtml) parts.push(countHtml);
  const liveStatus = getSessionStatusSummary(session).primary;
  const statusHtml = liveStatus?.key && liveStatus.key !== "idle"
    ? renderSessionStatusHtml(liveStatus)
    : "";
  if (statusHtml) parts.push(statusHtml);
  return parts;
}

function buildBoardCardMetaParts(session) {
  const parts = [];
  parts.push(...renderSessionScopeContext(session));
  const statusHtml = renderSessionStatusHtml(getSessionMetaStatusInfo(session));
  if (statusHtml) parts.push(statusHtml);
  return parts;
}

function renderSessionScopeContext(session) {
  const parts = [];
  const sourceName = typeof getEffectiveSessionSourceName === "function"
    ? getEffectiveSessionSourceName(session)
    : "";
  if (sourceName) {
    parts.push(`<span title="Session source">${esc(sourceName)}</span>`);
  }

  const templateAppId = typeof getEffectiveSessionTemplateAppId === "function"
    ? getEffectiveSessionTemplateAppId(session)
    : "";
  if (templateAppId) {
    const appEntry = typeof getSessionAppCatalogEntry === "function"
      ? getSessionAppCatalogEntry(templateAppId)
      : null;
    const appName = appEntry?.name || session?.appName || "App";
    parts.push(`<span title="Session app">App: ${esc(appName)}</span>`);
  }

  if (session?.visitorId) {
    const visitorLabel = typeof session?.visitorName === "string" && session.visitorName.trim()
      ? `Visitor: ${session.visitorName.trim()}`
      : (session?.visitorId ? "Visitor" : "Owner");
    parts.push(`<span title="Session owner scope">${esc(visitorLabel)}</span>`);
  }

  return parts;
}

function getFilteredSessionEmptyText({ archived = false } = {}) {
  if (archived) return "No archived sessions";
  if (
    activeSourceFilter !== FILTER_ALL_VALUE
    || activeSessionAppFilter !== FILTER_ALL_VALUE
    || activeUserFilter !== ADMIN_USER_FILTER_VALUE
  ) {
    return "No sessions match the current filters";
  }
  return "No sessions yet";
}

function getSessionGroupInfo(session) {
  const group = typeof session?.group === "string" ? session.group.trim() : "";
  if (group) {
    return {
      key: `group:${group}`,
      label: group,
      title: group,
    };
  }

  const folder = session?.folder || "?";
  const shortFolder = getShortFolder(folder);
  return {
    key: `folder:${folder}`,
    label: getFolderLabel(folder),
    title: shortFolder,
  };
}

function renderSessionStatusHtml(statusInfo) {
  if (!statusInfo?.label) return "";
  const title = statusInfo.title ? ` title="${esc(statusInfo.title)}"` : "";
  if (!statusInfo.className) {
    return `<span${title}>${esc(statusInfo.label)}</span>`;
  }
  return `<span class="${statusInfo.className}"${title}>● ${esc(statusInfo.label)}</span>`;
}

const TASK_NOTE_STORAGE_KEY_PREFIX = "remotelab.taskBoardNote.";

function formatBoardTimestampValue(stamp) {
  const parsed = new Date(stamp || "").getTime();
  if (!Number.isFinite(parsed)) return "";
  return messageTimeFormatter.format(parsed);
}

function formatBoardSessionTimestamp(session) {
  const stamp = session?.lastEventAt || session?.updatedAt || session?.created || "";
  return formatBoardTimestampValue(stamp);
}

function formatBoardTaskTimestamp(taskEntry) {
  return formatBoardTimestampValue(taskEntry?.updatedAt || taskEntry?.lastEventAt || "");
}

function renderBoardPriorityPill(priorityInfo) {
  if (!priorityInfo?.label) return "";
  const title = priorityInfo.title ? ` title="${esc(priorityInfo.title)}"` : "";
  const className = priorityInfo.className ? ` ${priorityInfo.className}` : "";
  return `<span class="board-priority-pill${className}"${title}>${esc(priorityInfo.label)}</span>`;
}

function getTaskBoardNoteStorageKey(taskId) {
  return `${TASK_NOTE_STORAGE_KEY_PREFIX}${taskId || ""}`;
}

function loadTaskBoardNote(taskId) {
  try {
    return localStorage.getItem(getTaskBoardNoteStorageKey(taskId)) || "";
  } catch {
    return "";
  }
}

function saveTaskBoardNote(taskId, value) {
  try {
    localStorage.setItem(getTaskBoardNoteStorageKey(taskId), value || "");
  } catch {}
}

function normalizeBoardTaskColumnKey(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : "";
}

function inferFallbackTaskNextActionForUi(session) {
  const activity = getSessionActivity(session);
  if (activity.run.state === "running") {
    return "Let the current run finish, then review the newest output.";
  }
  if (activity.queue.state === "queued") {
    return activity.queue.count === 1
      ? "Wait for the queued follow-up, then review the newest output."
      : "Wait for the queued follow-ups, then review the newest output.";
  }
  const workflow = getWorkflowStatusInfo(session?.workflowState);
  if (workflow?.key === "waiting_user") {
    return "Provide the requested input or approval in the linked session.";
  }
  if (workflow?.key === "done") {
    return "Review only if another iteration is needed.";
  }
  return "Open the linked session and decide the next concrete step.";
}

function buildFallbackTaskMetaFromSession(session) {
  const groupInfo = getSessionGroupInfo(session);
  const description = typeof session?.description === "string"
    ? session.description.trim()
    : "";
  return {
    id: `session_${session.id}`,
    title: getSessionDisplayName(session),
    projectLabel: groupInfo?.label || "",
    boardSummary: description,
    workingSummary: description,
    nextAction: inferFallbackTaskNextActionForUi(session),
    priority: session?.workflowPriority || "medium",
    columnKey: "unassigned_tasks",
    columnLabel: "Unassigned tasks",
    columnOrder: 9999,
    order: 9999,
    updatedAt: session?.lastEventAt || session?.updatedAt || session?.created || "",
  };
}

function getTaskPriorityInfo(taskEntry) {
  return getSessionBoardPriority({
    board: { priority: taskEntry?.priority || "medium" },
  });
}

function getTaskEntryStatusInfo(taskEntry) {
  const sessions = Array.isArray(taskEntry?.sessions) ? taskEntry.sessions : [];
  for (const session of sessions) {
    const live = getSessionStatusSummary(session).primary;
    if (live?.key && live.key !== "idle") {
      return live;
    }
  }
  for (const session of sessions) {
    const workflow = getWorkflowStatusInfo(session?.workflowState);
    if (workflow?.key) return workflow;
  }
  return null;
}

function buildVisibleTaskBoardView() {
  const visibleSessions = getActiveSessions().filter((session) => matchesCurrentFilters(session));
  const entries = new Map();

  for (const session of visibleSessions) {
    const rawTask = session?.task && session.task.id
      ? session.task
      : buildFallbackTaskMetaFromSession(session);
    const taskId = rawTask.id || `session_${session.id}`;
    let entry = entries.get(taskId);
    if (!entry) {
      entry = {
        ...rawTask,
        priority: rawTask.priority || session?.workflowPriority || "medium",
        updatedAt: rawTask.updatedAt || session?.lastEventAt || session?.updatedAt || session?.created || "",
        sessions: [],
      };
      entries.set(taskId, entry);
    }

    entry.sessions.push(session);

    const sessionUpdatedAt = session?.lastEventAt || session?.updatedAt || session?.created || "";
    if (
      sessionUpdatedAt
      && (
        !entry.updatedAt
        || new Date(sessionUpdatedAt).getTime() > new Date(entry.updatedAt).getTime()
      )
    ) {
      entry.updatedAt = sessionUpdatedAt;
    }

    if (!entry.projectLabel && session?.group) {
      entry.projectLabel = session.group.trim();
    }
    if (!entry.boardSummary && session?.description) {
      entry.boardSummary = session.description.trim();
    }
    if (!entry.workingSummary && session?.description) {
      entry.workingSummary = session.description.trim();
    }
    if (!entry.nextAction) {
      entry.nextAction = inferFallbackTaskNextActionForUi(session);
    }
    if (!entry.priority && session?.workflowPriority) {
      entry.priority = session.workflowPriority;
    }
    if (!entry.columnKey && rawTask.columnKey) {
      entry.columnKey = rawTask.columnKey;
      entry.columnLabel = rawTask.columnLabel;
      entry.columnOrder = rawTask.columnOrder;
    }
  }

  const tasks = [...entries.values()].map((entry) => {
    entry.sessions.sort(compareBoardSessions);
    entry.sessionCount = entry.sessions.length;
    entry.priority = entry.priority || "medium";
    if (!entry.title) {
      entry.title = entry.sessions[0] ? getSessionDisplayName(entry.sessions[0]) : "Untitled task";
    }
    if (!entry.nextAction && entry.sessions[0]) {
      entry.nextAction = inferFallbackTaskNextActionForUi(entry.sessions[0]);
    }
    return entry;
  });

  const columns = [];
  const seenColumnKeys = new Set();
  const stateColumns = Array.isArray(taskBoardState?.columns) ? taskBoardState.columns : [];
  for (const column of stateColumns) {
    const key = normalizeBoardTaskColumnKey(column?.key || column?.label);
    const label = typeof column?.label === "string" ? column.label.trim() : "";
    if (!key || !label || seenColumnKeys.has(key)) continue;
    columns.push({
      key,
      label,
      title: typeof column?.description === "string" ? column.description.trim() : "",
      emptyText: `No tasks in ${label}`,
      order: Number.isInteger(column?.order) ? column.order : columns.length * 10,
    });
    seenColumnKeys.add(key);
  }

  for (const taskEntry of tasks) {
    const key = normalizeBoardTaskColumnKey(taskEntry?.columnKey || taskEntry?.columnLabel);
    const label = typeof taskEntry?.columnLabel === "string" ? taskEntry.columnLabel.trim() : "";
    if (!key || !label || seenColumnKeys.has(key)) continue;
    columns.push({
      key,
      label,
      title: "",
      emptyText: `No tasks in ${label}`,
      order: Number.isInteger(taskEntry?.columnOrder) ? taskEntry.columnOrder : columns.length * 10,
    });
    seenColumnKeys.add(key);
  }

  if (columns.length === 0) {
    columns.push({
      key: "unassigned_tasks",
      label: "Unassigned tasks",
      title: "Tasks that are not yet arranged by the task board model.",
      emptyText: "No tasks yet",
      order: 0,
    });
  }

  columns.sort((a, b) => (
    (Number.isInteger(a.order) ? a.order : 9999) - (Number.isInteger(b.order) ? b.order : 9999)
    || a.label.localeCompare(b.label)
  ));

  return { columns, tasks };
}

function compareBoardTasks(a, b) {
  const orderDiff = (Number.isInteger(a?.order) ? a.order : 9999) - (Number.isInteger(b?.order) ? b.order : 9999);
  if (orderDiff) return orderDiff;

  const priorityDiff = (getTaskPriorityInfo(b)?.rank || 0) - (getTaskPriorityInfo(a)?.rank || 0);
  if (priorityDiff) return priorityDiff;

  const currentDiff = (b?.sessions || []).some((session) => session.id === currentSessionId)
    ? 1
    : 0;
  const currentOtherDiff = (a?.sessions || []).some((session) => session.id === currentSessionId)
    ? 1
    : 0;
  if (currentDiff !== currentOtherDiff) return currentDiff - currentOtherDiff;

  return new Date(b?.updatedAt || 0).getTime() - new Date(a?.updatedAt || 0).getTime();
}

function createBoardTaskCard(taskEntry) {
  const priorityInfo = getTaskPriorityInfo(taskEntry);
  const taskStatus = getTaskEntryStatusInfo(taskEntry);
  const card = document.createElement("div");
  card.className = "board-card board-task-card"
    + (priorityInfo?.className ? ` ${priorityInfo.className}` : "")
    + (taskEntry.id === selectedBoardTaskId ? " active" : "");

  const timestamp = formatBoardTaskTimestamp(taskEntry);
  const summary = typeof taskEntry?.boardSummary === "string" ? taskEntry.boardSummary.trim() : "";
  const nextAction = typeof taskEntry?.nextAction === "string" ? taskEntry.nextAction.trim() : "";
  const metaParts = [`${taskEntry.sessionCount || taskEntry.sessions?.length || 0} session${(taskEntry.sessionCount || taskEntry.sessions?.length || 0) === 1 ? "" : "s"}`];
  const statusHtml = renderSessionStatusHtml(taskStatus);
  if (statusHtml) metaParts.push(statusHtml);

  card.innerHTML = `
    <div class="board-card-topline">
      ${renderBoardPriorityPill(priorityInfo)}
      ${timestamp ? `<div class="board-card-time">Updated ${esc(timestamp)}</div>` : ""}
    </div>
    ${taskEntry.projectLabel ? `<div class="board-task-project">${esc(taskEntry.projectLabel)}</div>` : ""}
    <div class="board-card-title">${esc(taskEntry.title || "Untitled task")}</div>
    ${summary ? `<div class="board-card-description">${esc(summary)}</div>` : ""}
    ${nextAction ? `<div class="board-card-next">Next: ${esc(nextAction)}</div>` : ""}
    ${metaParts.length > 0 ? `<div class="board-card-meta">${metaParts.join(" · ")}</div>` : ""}`;

  card.addEventListener("click", () => {
    selectedBoardTaskId = taskEntry.id;
    renderSessionBoard();
  });

  return card;
}

function createBoardSessionCard(session) {
  const priorityInfo = getSessionBoardPriority(session);
  const card = document.createElement("div");
  card.className = "board-card"
    + (priorityInfo?.className ? ` ${priorityInfo.className}` : "")
    + (session.id === currentSessionId ? " active" : "");

  const displayName = getSessionDisplayName(session);
  const metaParts = buildBoardCardMetaParts(session);

  const description = typeof session?.description === "string"
    ? session.description.trim()
    : "";
  const timestamp = formatBoardSessionTimestamp(session);

  card.innerHTML = `
    <div class="board-card-topline">
      ${renderBoardPriorityPill(priorityInfo)}
      ${timestamp ? `<div class="board-card-time">Updated ${esc(timestamp)}</div>` : ""}
    </div>
    <div class="board-card-title">${session.pinned ? `<span class="session-pin-badge" title="Pinned">${renderUiIcon("pinned")}</span>` : ""}${esc(displayName)}</div>
    ${metaParts.length > 0 ? `<div class="board-card-meta">${metaParts.join(" · ")}</div>` : ""}
    ${description ? `<div class="board-card-description">${esc(description)}</div>` : ""}`;

  card.addEventListener("click", () => {
    attachSession(session.id, session);
    if (!isDesktop) closeSidebarFn();
  });

  return card;
}

function createSessionBoardScroller(sessionList) {
  const scroller = document.createElement("div");
  scroller.className = "board-scroller";

  const columns = getSessionBoardColumns();
  const grouped = new Map(columns.map((column) => [column.key, {
    column,
    sessions: [],
  }]));
  const visibleSessions = Array.isArray(sessionList) ? sessionList : [];

  for (const session of visibleSessions) {
    const boardColumn = getSessionBoardColumn(session);
    const target = grouped.get(boardColumn.key) || grouped.get(columns[0]?.key);
    target?.sessions.push(session);
  }

  for (const { column, sessions: columnSessions } of grouped.values()) {
    columnSessions.sort(compareBoardSessions);
    const highPriorityCount = columnSessions.filter((session) => getSessionBoardPriority(session)?.key === "high").length;
    const columnEl = document.createElement("div");
    columnEl.className = "board-column";
    columnEl.dataset.column = column.key;

    const header = document.createElement("div");
    header.className = "board-column-header";
    header.innerHTML = `
      <span class="board-column-dot"></span>
      <span class="board-column-title" title="${esc(column.title || column.label)}">${esc(column.label)}</span>
      ${highPriorityCount > 0 ? `<span class="board-column-attention">${highPriorityCount} high</span>` : ""}
      <span class="board-column-count">${columnSessions.length}</span>`;

    const body = document.createElement("div");
    body.className = "board-column-body";
    if (columnSessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "board-card-empty";
      empty.textContent = column.emptyText || "No sessions";
      body.appendChild(empty);
    } else {
      for (const session of columnSessions) {
        body.appendChild(createBoardSessionCard(session));
      }
    }

    columnEl.appendChild(header);
    columnEl.appendChild(body);
    scroller.appendChild(columnEl);
  }

  return scroller;
}

function renderTaskBoardOverview() {
  const { columns, tasks } = buildVisibleTaskBoardView();
  const grouped = new Map(columns.map((column) => [column.key, {
    column,
    tasks: [],
  }]));

  for (const taskEntry of tasks) {
    const key = normalizeBoardTaskColumnKey(taskEntry?.columnKey || taskEntry?.columnLabel) || columns[0]?.key;
    const target = grouped.get(key) || grouped.get(columns[0]?.key);
    target?.tasks.push(taskEntry);
  }

  const scroller = document.createElement("div");
  scroller.className = "board-scroller";

  for (const { column, tasks: columnTasks } of grouped.values()) {
    columnTasks.sort(compareBoardTasks);
    const highPriorityCount = columnTasks.filter((taskEntry) => getTaskPriorityInfo(taskEntry)?.key === "high").length;
    const columnEl = document.createElement("div");
    columnEl.className = "board-column";
    columnEl.dataset.column = column.key;

    const header = document.createElement("div");
    header.className = "board-column-header";
    header.innerHTML = `
      <span class="board-column-dot"></span>
      <span class="board-column-title" title="${esc(column.title || column.label)}">${esc(column.label)}</span>
      ${highPriorityCount > 0 ? `<span class="board-column-attention">${highPriorityCount} high</span>` : ""}
      <span class="board-column-count">${columnTasks.length}</span>`;

    const body = document.createElement("div");
    body.className = "board-column-body";
    if (columnTasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "board-card-empty";
      empty.textContent = column.emptyText || "No tasks";
      body.appendChild(empty);
    } else {
      for (const taskEntry of columnTasks) {
        body.appendChild(createBoardTaskCard(taskEntry));
      }
    }

    columnEl.appendChild(header);
    columnEl.appendChild(body);
    scroller.appendChild(columnEl);
  }

  boardPanel.appendChild(scroller);
}

function renderTaskBoardDetail(taskEntry) {
  const wrap = document.createElement("div");
  wrap.className = "task-board-detail";

  const header = document.createElement("div");
  header.className = "task-board-detail-header";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "task-board-back-btn";
  backBtn.textContent = "← All tasks";
  backBtn.addEventListener("click", () => {
    selectedBoardTaskId = null;
    renderSessionBoard();
  });

  const titleWrap = document.createElement("div");
  titleWrap.className = "task-board-detail-title-wrap";
  titleWrap.innerHTML = `
    ${taskEntry.projectLabel ? `<div class="task-board-detail-project">${esc(taskEntry.projectLabel)}</div>` : ""}
    <div class="task-board-detail-title">${esc(taskEntry.title || "Untitled task")}</div>
    ${taskEntry.boardSummary ? `<div class="task-board-detail-summary">${esc(taskEntry.boardSummary)}</div>` : ""}`;

  header.appendChild(backBtn);
  header.appendChild(titleWrap);
  wrap.appendChild(header);

  const cards = document.createElement("div");
  cards.className = "task-board-detail-cards";

  const aiCard = document.createElement("section");
  aiCard.className = "task-board-detail-card";
  aiCard.innerHTML = `
    <div class="task-board-detail-card-title">AI Brief</div>
    ${taskEntry.workingSummary ? `<div class="task-board-detail-body">${esc(taskEntry.workingSummary)}</div>` : `<div class="task-board-detail-muted">No AI working summary yet.</div>`}
    ${taskEntry.nextAction ? `<div class="task-board-detail-next">Next: ${esc(taskEntry.nextAction)}</div>` : ""}
    <div class="task-board-detail-meta">${esc(`${taskEntry.sessionCount || taskEntry.sessions?.length || 0} linked session${(taskEntry.sessionCount || taskEntry.sessions?.length || 0) === 1 ? "" : "s"}`)}</div>`;

  const noteCard = document.createElement("section");
  noteCard.className = "task-board-detail-card";
  const noteTitle = document.createElement("div");
  noteTitle.className = "task-board-detail-card-title";
  noteTitle.textContent = "My Note";
  const noteHint = document.createElement("div");
  noteHint.className = "task-board-detail-muted";
  noteHint.textContent = "Local-only scratchpad. Not sent to the model automatically.";
  const noteInput = document.createElement("textarea");
  noteInput.className = "task-board-note-input";
  noteInput.placeholder = "Capture what is in your head, what to watch, or what you still need to do...";
  noteInput.value = loadTaskBoardNote(taskEntry.id);
  noteInput.addEventListener("input", () => {
    saveTaskBoardNote(taskEntry.id, noteInput.value);
  });
  noteCard.appendChild(noteTitle);
  noteCard.appendChild(noteHint);
  noteCard.appendChild(noteInput);

  cards.appendChild(aiCard);
  cards.appendChild(noteCard);
  wrap.appendChild(cards);

  const sessionsSection = document.createElement("div");
  sessionsSection.className = "task-board-detail-sessions";
  sessionsSection.innerHTML = `<div class="task-board-detail-section-title">Sessions in this task</div>`;
  sessionsSection.appendChild(createSessionBoardScroller(taskEntry.sessions || []));
  wrap.appendChild(sessionsSection);

  boardPanel.appendChild(wrap);
}

function renderSessionBoard() {
  if (!boardPanel) return;
  boardPanel.innerHTML = "";

  const { tasks } = buildVisibleTaskBoardView();
  const selectedTask = tasks.find((taskEntry) => taskEntry.id === selectedBoardTaskId) || null;
  if (selectedBoardTaskId && !selectedTask) {
    selectedBoardTaskId = null;
  }

  if (selectedTask) {
    renderTaskBoardDetail(selectedTask);
    return;
  }

  renderTaskBoardOverview();
}

function createActiveSessionItem(session) {
  const statusInfo = getSessionMetaStatusInfo(session);
  const div = document.createElement("div");
  div.className =
    "session-item"
    + (session.pinned ? " pinned" : "")
    + (session.id === currentSessionId ? " active" : "")
    + (statusInfo.itemClass ? ` ${statusInfo.itemClass}` : "");

  const displayName = getSessionDisplayName(session);
  const metaParts = buildSessionMetaParts(session);
  const metaHtml = metaParts.join(" · ");
  const pinTitle = session.pinned ? "Unpin" : "Pin";

  div.innerHTML = `
    <div class="session-item-info">
      <div class="session-item-name">${session.pinned ? `<span class="session-pin-badge" title="Pinned">${renderUiIcon("pinned")}</span>` : ""}${esc(displayName)}</div>
      ${metaHtml ? `<div class="session-item-meta">${metaHtml}</div>` : ""}
    </div>
    <div class="session-item-actions">
      <button class="session-action-btn pin${session.pinned ? " pinned" : ""}" type="button" title="${pinTitle}" aria-label="${pinTitle}" data-id="${session.id}">${renderUiIcon(session.pinned ? "pinned" : "pin")}</button>
      <button class="session-action-btn rename" type="button" title="Rename" aria-label="Rename" data-id="${session.id}">${renderUiIcon("edit")}</button>
      <button class="session-action-btn archive" type="button" title="Archive" aria-label="Archive" data-id="${session.id}">${renderUiIcon("archive")}</button>
    </div>`;

  div.addEventListener("click", (e) => {
    if (e.target.closest(".session-action-btn")) {
      return;
    }
    attachSession(session.id, session);
    if (!isDesktop) closeSidebarFn();
  });

  div.querySelector(".pin").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchAction({ action: session.pinned ? "unpin" : "pin", sessionId: session.id });
  });

  div.querySelector(".rename").addEventListener("click", (e) => {
    e.stopPropagation();
    startRename(div, session);
  });

  div.querySelector(".archive").addEventListener("click", (e) => {
    e.stopPropagation();
    dispatchAction({ action: "archive", sessionId: session.id });
  });

  return div;
}

// ---- Session list ----
function renderSessionList() {
  renderSessionBoard();
  sessionList.innerHTML = "";
  const pinnedSessions = getVisiblePinnedSessions();
  const visibleSessions = getVisibleActiveSessions();

  if (pinnedSessions.length > 0) {
    const section = document.createElement("div");
    section.className = "pinned-section";

    const header = document.createElement("div");
    header.className = "pinned-section-header";
    header.innerHTML = `<span class="pinned-label">Pinned</span><span class="folder-count">${pinnedSessions.length}</span>`;

    const items = document.createElement("div");
    items.className = "pinned-items";
    for (const session of pinnedSessions) {
      items.appendChild(createActiveSessionItem(session));
    }

    section.appendChild(header);
    section.appendChild(items);
    sessionList.appendChild(section);
  }

  const groups = new Map();
  for (const s of visibleSessions) {
    const groupInfo = getSessionGroupInfo(s);
    if (!groups.has(groupInfo.key)) {
      groups.set(groupInfo.key, { ...groupInfo, sessions: [] });
    }
    groups.get(groupInfo.key).sessions.push(s);
  }

  for (const [groupKey, groupEntry] of groups) {
    const folderSessions = groupEntry.sessions;
    const group = document.createElement("div");
    group.className = "folder-group";

    const header = document.createElement("div");
    header.className =
      "folder-group-header" +
      (collapsedFolders[groupKey] ? " collapsed" : "");
    header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span>
      <span class="folder-name" title="${esc(groupEntry.title)}">${esc(groupEntry.label)}</span>
      <span class="folder-count">${folderSessions.length}</span>`;
    header.addEventListener("click", (e) => {
      header.classList.toggle("collapsed");
      collapsedFolders[groupKey] = header.classList.contains("collapsed");
      localStorage.setItem(
        COLLAPSED_GROUPS_STORAGE_KEY,
        JSON.stringify(collapsedFolders),
      );
    });

    const items = document.createElement("div");
    items.className = "folder-group-items";

    for (const s of folderSessions) {
      items.appendChild(createActiveSessionItem(s));
    }

    group.appendChild(header);
    group.appendChild(items);
    sessionList.appendChild(group);
  }

  if (pinnedSessions.length === 0 && visibleSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-filter-empty";
    empty.textContent = getFilteredSessionEmptyText();
    sessionList.appendChild(empty);
  }

  renderArchivedSection();
}

function renderArchivedSection() {
  const archivedSessions = getVisibleArchivedSessions();
  const existing = document.getElementById("archivedSection");
  if (existing) existing.remove();

  const section = document.createElement("div");
  section.id = "archivedSection";
  section.className = "archived-section";

  const header = document.createElement("div");
  header.className = "archived-section-header";
  const isCollapsed = localStorage.getItem("archivedCollapsed") !== "false";
  if (isCollapsed) header.classList.add("collapsed");
  header.innerHTML = `<span class="folder-chevron">${renderUiIcon("chevron-down")}</span><span class="archived-label">Archive</span><span class="folder-count">${archivedSessions.length}</span>`;
  header.addEventListener("click", () => {
    header.classList.toggle("collapsed");
    localStorage.setItem("archivedCollapsed", header.classList.contains("collapsed") ? "true" : "false");
  });

  const items = document.createElement("div");
  items.className = "archived-items";

  if (archivedSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "archived-empty";
    empty.textContent = getFilteredSessionEmptyText({ archived: true });
    items.appendChild(empty);
  } else {
    for (const s of archivedSessions) {
      const div = document.createElement("div");
      div.className =
        "session-item archived-item" + (s.id === currentSessionId ? " active" : "");
      const displayName = getSessionDisplayName(s);
      const groupInfo = getSessionGroupInfo(s);
      const shortFolder = getShortFolder(s.folder || "");
      const date = s.archivedAt ? new Date(s.archivedAt).toLocaleDateString() : "";
      div.innerHTML = `
        <div class="session-item-info">
          <div class="session-item-name">${esc(displayName)}</div>
          <div class="session-item-meta"><span title="${esc(shortFolder || groupInfo.title)}">${esc(groupInfo.label)}</span>${date ? ` · ${date}` : ""}</div>
        </div>
        <div class="session-item-actions">
          <button class="session-action-btn restore" type="button" title="Restore" aria-label="Restore" data-id="${s.id}">${renderUiIcon("unarchive")}</button>
        </div>`;
      div.addEventListener("click", (e) => {
        if (e.target.closest(".session-action-btn")) return;
        attachSession(s.id, s);
        if (!isDesktop) closeSidebarFn();
      });
      div.querySelector(".restore").addEventListener("click", (e) => {
        e.stopPropagation();
        dispatchAction({ action: "unarchive", sessionId: s.id });
      });
      items.appendChild(div);
    }
  }

  section.appendChild(header);
  section.appendChild(items);
  sessionList.appendChild(section);
}

function startRename(itemEl, session) {
  const nameEl = itemEl.querySelector(".session-item-name");
  const current = session.name || session.tool || "";
  const input = document.createElement("input");
  input.className = "session-rename-input";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim();
    if (newName && newName !== current) {
      dispatchAction({ action: "rename", sessionId: session.id, name: newName });
    } else {
      renderSessionList(); // revert
    }
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
    if (e.key === "Escape") {
      input.removeEventListener("blur", commit);
      renderSessionList();
    }
  });
}

function attachSession(id, session) {
  const shouldReattach = !hasAttachedSession || currentSessionId !== id;
  if (shouldReattach) {
    clearMessages();
    dispatchAction({ action: "attach", sessionId: id });
  }
  applyAttachedSessionState(id, session);
  if (typeof focusComposer === "function") {
    focusComposer({ preventScroll: true });
  } else {
    msgInput.focus();
  }
}

// ---- Sidebar ----
function openSidebar() {
  sidebarOverlay.classList.add("open");
}
function closeSidebarFn() {
  sidebarOverlay.classList.remove("open");
}

function openSessionsSidebar() {
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  openSidebar();
  return true;
}

const CREATE_APP_TEMPLATE_APP_ID = "app_create_app";
const BASIC_CHAT_TEMPLATE_APP_ID = "app_basic_chat";

function getOrderedSettingsApps() {
  const apps = Array.isArray(availableApps)
    ? availableApps.filter((app) => isTemplateAppScopeId(app?.id))
    : [];
  return apps.sort((a, b) => {
    const rank = (app) => {
      if (app?.id === BASIC_CHAT_TEMPLATE_APP_ID) return 0;
      if (app?.id === CREATE_APP_TEMPLATE_APP_ID) return 1;
      if (app?.id === "app_video_cut") return 2;
      return 3;
    };
    return rank(a) - rank(b) || String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base" });
  });
}

function buildAppShareUrl(app) {
  const shareToken = typeof app?.shareToken === "string" ? app.shareToken.trim() : "";
  if (!shareToken || app?.shareEnabled === false) return "";
  return `${window.location.origin}/app/${encodeURIComponent(shareToken)}`;
}

function summarizeAppDescription(app) {
  if (app?.id === BASIC_CHAT_TEMPLATE_APP_ID) {
    return "Default normal conversation app for everyday RemoteLab sessions.";
  }
  const welcome = typeof app?.welcomeMessage === "string" ? app.welcomeMessage.trim() : "";
  if (welcome) {
    return welcome.split(/\n+/)[0].trim();
  }
  const systemPrompt = typeof app?.systemPrompt === "string" ? app.systemPrompt.trim() : "";
  if (systemPrompt) {
    return `${systemPrompt.slice(0, 120)}${systemPrompt.length > 120 ? "…" : ""}`;
  }
  return app?.shareEnabled === false
    ? "Internal starter app. Opens owner sessions only."
    : "Shareable app.";
}

function getAppKindLabel(app) {
  const labels = [];
  labels.push(app?.builtin ? "Built-in" : "Custom");
  labels.push(app?.shareEnabled === false ? "Internal" : "Shareable");
  return labels.join(" · ");
}

function setTemporaryButtonText(button, nextText, durationMs = 1400) {
  if (!button) return;
  if (!button.dataset.originalLabel) {
    button.dataset.originalLabel = button.textContent || "";
  }
  button.textContent = nextText;
  window.clearTimeout(button._resetLabelTimer);
  button._resetLabelTimer = window.setTimeout(() => {
    button.textContent = button.dataset.originalLabel || button.textContent;
  }, durationMs);
}

function setUserFormStatus(message) {
  if (!userFormStatus) return;
  userFormStatus.textContent = message || "";
}

function setAppFormStatus(message) {
  if (!appFormStatus) return;
  appFormStatus.textContent = message || "";
}

function getAdminSessionPrincipal() {
  return {
    kind: "owner",
    id: ADMIN_USER_FILTER_VALUE,
    name: "Admin",
    appIds: [],
    defaultAppId: BASIC_CHAT_TEMPLATE_APP_ID,
  };
}

function getManagedUserById(userId) {
  return Array.isArray(availableUsers)
    ? availableUsers.find((user) => user.id === userId) || null
    : null;
}

function getPrincipalForUser(user) {
  if (!user?.id) return getAdminSessionPrincipal();
  return {
    kind: "user",
    id: user.id,
    name: user.name || "User",
    appIds: Array.isArray(user.appIds) ? user.appIds.filter(Boolean) : [],
    defaultAppId: typeof user.defaultAppId === "string" ? user.defaultAppId.trim() : "",
  };
}

function resolveSelectedSessionPrincipal() {
  if (activeUserFilter === USER_FILTER_ALL_VALUE) {
    return getAdminSessionPrincipal();
  }
  if (activeUserFilter === ADMIN_USER_FILTER_VALUE) {
    return getAdminSessionPrincipal();
  }
  return getPrincipalForUser(getManagedUserById(activeUserFilter));
}

function buildSessionPrincipalPayload(principal) {
  if (principal?.kind !== "user") return {};
  return {
    userId: principal.id,
    userName: principal.name,
  };
}

function resolveAppIdForPrincipal(principal, requestedAppId = "") {
  const normalizedRequested = normalizeSessionAppFilter(requestedAppId);
  if (principal?.kind !== "user") {
    return normalizedRequested !== FILTER_ALL_VALUE
      ? normalizedRequested
      : BASIC_CHAT_TEMPLATE_APP_ID;
  }
  const allowedAppIds = Array.isArray(principal.appIds) ? principal.appIds.filter(Boolean) : [];
  if (allowedAppIds.length === 0) {
    return BASIC_CHAT_TEMPLATE_APP_ID;
  }
  if (normalizedRequested !== FILTER_ALL_VALUE && allowedAppIds.includes(normalizedRequested)) {
    return normalizedRequested;
  }
  if (principal.defaultAppId && allowedAppIds.includes(principal.defaultAppId)) {
    return principal.defaultAppId;
  }
  return allowedAppIds[0];
}

function getAppRecordById(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return null;
  return getOrderedSettingsApps().find((app) => app.id === normalized) || null;
}

function createSessionForApp(app, { closeSidebar = true, principal = getAdminSessionPrincipal() } = {}) {
  if (!app?.id) return false;
  if (closeSidebar && !isDesktop) closeSidebarFn();
  const tool =
    (typeof app?.tool === "string" && app.tool.trim())
    || preferredTool
    || selectedTool
    || toolsList[0]?.id;
  if (!tool) return false;
  if (typeof switchTab === "function") {
    switchTab("sessions");
  }
  return dispatchAction({
    action: "create",
    folder: "~",
    tool,
    sourceId: DEFAULT_APP_ID,
    sourceName: DEFAULT_APP_NAME,
    appId: app.id,
    ...buildSessionPrincipalPayload(principal),
  });
}

function renderAppToolSelectOptions(selectEl, selectedValue = "") {
  if (!selectEl) return;
  const toolOptions = Array.isArray(toolsList) ? toolsList : [];
  const preferredValue = selectedValue || preferredTool || selectedTool || toolOptions[0]?.id || "";
  selectEl.innerHTML = "";
  if (toolOptions.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No tools available";
    selectEl.appendChild(option);
    selectEl.disabled = true;
    return;
  }
  for (const tool of toolOptions) {
    const option = document.createElement("option");
    option.value = tool.id;
    option.textContent = tool.name || tool.id;
    selectEl.appendChild(option);
  }
  selectEl.disabled = false;
  selectEl.value = toolOptions.some((tool) => tool.id === preferredValue)
    ? preferredValue
    : toolOptions[0].id;
}

function getSelectedNewUserAppIds() {
  if (!newUserAppsPicker) return [];
  return [...newUserAppsPicker.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value)
    .filter(Boolean);
}

function syncNewUserDefaultAppOptions(selectedAppIds = getSelectedNewUserAppIds()) {
  if (!newUserDefaultAppSelect) return;
  const selectedApps = getOrderedSettingsApps().filter((app) => selectedAppIds.includes(app.id));
  newUserDefaultAppSelect.innerHTML = "";
  if (selectedApps.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Choose at least one app";
    newUserDefaultAppSelect.appendChild(option);
    newUserDefaultAppSelect.disabled = true;
    if (createUserBtn) createUserBtn.disabled = true;
    return;
  }

  const currentValue = typeof newUserDefaultAppSelect.value === "string" ? newUserDefaultAppSelect.value : "";
  for (const app of selectedApps) {
    const option = document.createElement("option");
    option.value = app.id;
    option.textContent = app.name || app.id;
    newUserDefaultAppSelect.appendChild(option);
  }
  newUserDefaultAppSelect.disabled = false;
  if (createUserBtn) createUserBtn.disabled = false;
  const preferredApp = selectedApps.find((app) => app.id === currentValue)
    || selectedApps.find((app) => app.id === BASIC_CHAT_TEMPLATE_APP_ID)
    || selectedApps[0];
  newUserDefaultAppSelect.value = preferredApp?.id || "";
}

function renderUserAppOptions() {
  if (!newUserAppsPicker) return;
  const apps = getOrderedSettingsApps();
  newUserAppsPicker.innerHTML = "";
  if (apps.length === 0) {
    newUserAppsPicker.innerHTML = '<div class="settings-app-empty">Create an app first.</div>';
    syncNewUserDefaultAppOptions([]);
    setUserFormStatus("Create at least one app before adding a user.");
    return;
  }

  const title = document.createElement("div");
  title.className = "settings-app-kind";
  title.textContent = "Allowed apps";
  newUserAppsPicker.appendChild(title);

  const grid = document.createElement("div");
  grid.className = "settings-app-picker-grid";
  const selectedIds = getSelectedNewUserAppIds();
  const activeIds = selectedIds.length > 0
    ? selectedIds
    : [BASIC_CHAT_TEMPLATE_APP_ID];

  for (const app of apps) {
    const chip = document.createElement("label");
    chip.className = "settings-app-chip";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = app.id;
    checkbox.checked = activeIds.includes(app.id);
    checkbox.addEventListener("change", () => {
      syncNewUserDefaultAppOptions();
    });

    const text = document.createElement("span");
    text.textContent = app.name || app.id;

    chip.appendChild(checkbox);
    chip.appendChild(text);
    grid.appendChild(chip);
  }

  newUserAppsPicker.appendChild(grid);
  syncNewUserDefaultAppOptions(activeIds);
  setUserFormStatus("Admin stays the default view. New users get a starter session automatically.");
}

function focusNewUserComposer() {
  if (typeof switchTab === "function") {
    switchTab("settings");
  }
  openSidebar();
  if (typeof fetchAppsList === "function") {
    void fetchAppsList().catch(() => {});
  }
  if (typeof fetchUsersList === "function") {
    void fetchUsersList().catch(() => {});
  }
  window.setTimeout(() => {
    newUserNameInput?.focus();
    newUserNameInput?.select?.();
  }, 0);
  return true;
}

async function handleCreateUser() {
  if (!newUserDefaultAppSelect || newUserDefaultAppSelect.disabled) return false;
  const appIds = getSelectedNewUserAppIds();
  if (appIds.length === 0) {
    setUserFormStatus("Choose at least one app.");
    return false;
  }
  const defaultAppId = newUserDefaultAppSelect.value || appIds[0];
  const tool = preferredTool || selectedTool || toolsList[0]?.id || "";
  if (!tool) {
    setUserFormStatus("Choose a tool first.");
    return false;
  }
  const name = typeof newUserNameInput?.value === "string" ? newUserNameInput.value.trim() : "";
  if (createUserBtn) createUserBtn.disabled = true;
  setUserFormStatus("Creating user…");
  try {
    const result = await createUserRecord({
      name: name || "New user",
      appIds,
      defaultAppId,
      folder: "~",
      tool,
    });
    if (newUserNameInput) {
      newUserNameInput.value = "";
      newUserNameInput.focus();
    }
    renderUserAppOptions();
    const user = result?.user;
    refreshAppCatalog();
    renderSessionList();
    setUserFormStatus(`Created ${user?.name || "user"}. Copy a share link below when you are ready.`);
    return true;
  } catch (error) {
    setUserFormStatus(error?.message || "Failed to create user.");
    return false;
  } finally {
    if (createUserBtn) createUserBtn.disabled = false;
  }
}

function copyShareUrl(shareUrl, button) {
  return (async () => {
    try {
      if (typeof copyText === "function") {
        await copyText(shareUrl);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareUrl);
      } else {
        throw new Error("clipboard unavailable");
      }
      setTemporaryButtonText(button, "Copied");
    } catch {
      setTemporaryButtonText(button, "Copy failed");
    }
  })();
}

function buildVisitorShareUrl(visitor) {
  const shareToken = typeof visitor?.shareToken === "string" ? visitor.shareToken.trim() : "";
  if (!shareToken) return "";
  return `${window.location.origin}/visitor/${encodeURIComponent(shareToken)}`;
}

async function ensureUserShareUrl(user) {
  if (!user?.id) {
    throw new Error("User not found.");
  }
  const appId = user.defaultAppId || user.appIds?.[0] || "";
  const app = getAppRecordById(appId);
  if (!app || app.shareEnabled === false) {
    throw new Error("Choose a shareable default app first.");
  }

  const visitorPayload = {
    name: user.name || "New user",
    appId: app.id,
  };
  const existingVisitorId = typeof user.shareVisitorId === "string" ? user.shareVisitorId.trim() : "";
  let visitor = null;

  if (existingVisitorId) {
    try {
      visitor = await updateVisitorRecord(existingVisitorId, visitorPayload);
    } catch (error) {
      if (!/Visitor not found/i.test(error?.message || "")) {
        throw error;
      }
    }
  }

  if (!visitor) {
    visitor = await createVisitorRecord(visitorPayload);
    if (visitor?.id) {
      await updateUserRecord(user.id, { shareVisitorId: visitor.id });
    }
  }

  const shareUrl = buildVisitorShareUrl(visitor);
  if (!shareUrl) {
    throw new Error("Failed to build share link.");
  }
  return shareUrl;
}

async function patchManagedUser(user, updates, {
  statusEl = null,
  pendingText = "Saving…",
  successText = "Saved.",
  onSuccess = null,
} = {}) {
  if (!user?.id) return null;
  if (statusEl) {
    statusEl.textContent = pendingText;
  }
  try {
    const updated = await updateUserRecord(user.id, updates);
    if (statusEl) {
      statusEl.textContent = successText;
    }
    if (typeof onSuccess === "function") {
      onSuccess(updated);
    }
    return updated;
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = error?.message || "Failed to save user.";
    }
    return null;
  }
}

async function handleCreateApp() {
  const name = typeof newAppNameInput?.value === "string" ? newAppNameInput.value.trim() : "";
  const tool = typeof newAppToolSelect?.value === "string" ? newAppToolSelect.value.trim() : "";
  if (!name) {
    setAppFormStatus("Name is required.");
    return false;
  }
  if (!tool) {
    setAppFormStatus("Choose a tool first.");
    return false;
  }
  if (createAppConfigBtn) createAppConfigBtn.disabled = true;
  setAppFormStatus("Creating app…");
  try {
    const app = await createAppRecord({
      name,
      tool,
      welcomeMessage: typeof newAppWelcomeInput?.value === "string" ? newAppWelcomeInput.value : "",
      systemPrompt: typeof newAppSystemPromptInput?.value === "string" ? newAppSystemPromptInput.value : "",
    });
    if (newAppNameInput) newAppNameInput.value = "";
    if (newAppWelcomeInput) newAppWelcomeInput.value = "";
    if (newAppSystemPromptInput) newAppSystemPromptInput.value = "";
    renderAppToolSelectOptions(newAppToolSelect);
    refreshAppCatalog();
    const shareUrl = buildAppShareUrl(app);
    setAppFormStatus(
      shareUrl
        ? `Created ${app?.name || "app"}. Use Copy Link below to share it.`
        : `Created ${app?.name || "app"}.`,
    );
    return true;
  } catch (error) {
    setAppFormStatus(error?.message || "Failed to create app.");
    return false;
  } finally {
    if (createAppConfigBtn) createAppConfigBtn.disabled = false;
  }
}

function focusNewAppComposer() {
  if (typeof switchTab === "function") {
    switchTab("settings");
  }
  openSidebar();
  if (typeof fetchAppsList === "function") {
    void fetchAppsList().catch(() => {});
  }
  window.setTimeout(() => {
    newAppNameInput?.focus();
    newAppNameInput?.select?.();
  }, 0);
  return true;
}

function renderSettingsAppsPanel() {
  if (!settingsAppsList) return;
  if (visitorMode) {
    settingsAppsList.innerHTML = '<div class="settings-app-empty">Apps are only available to the owner.</div>';
    return;
  }

  renderAppToolSelectOptions(newAppToolSelect);
  const apps = getOrderedSettingsApps();
  settingsAppsList.innerHTML = "";
  if (apps.length === 0) {
    settingsAppsList.innerHTML = '<div class="settings-app-empty">No apps yet.</div>';
    return;
  }

  for (const app of apps) {
    const card = document.createElement("div");
    card.className = "settings-app-card";

    const header = document.createElement("div");
    header.className = "settings-app-card-header";
    const name = document.createElement("div");
    name.className = "settings-app-name";
    name.textContent = app.name || "Untitled App";
    const kind = document.createElement("div");
    kind.className = "settings-app-kind";
    kind.textContent = getAppKindLabel(app);
    header.appendChild(name);
    header.appendChild(kind);
    card.appendChild(header);

    const description = document.createElement("div");
    description.className = "settings-app-description";
    description.textContent = summarizeAppDescription(app);
    card.appendChild(description);

    const meta = document.createElement("div");
    meta.className = "settings-app-meta";
    meta.textContent = `Default tool · ${(app.tool || preferredTool || selectedTool || "not set")}`;
    card.appendChild(meta);

    const shareUrl = buildAppShareUrl(app);
    if (shareUrl) {
      const link = document.createElement("div");
      link.className = "settings-app-link";
      link.textContent = shareUrl;
      card.appendChild(link);
    }

    if (!app.builtin) {
      const editor = document.createElement("div");
      editor.className = "settings-app-editor";

      const nameInput = document.createElement("input");
      nameInput.className = "settings-inline-input";
      nameInput.type = "text";
      nameInput.value = app.name || "";
      editor.appendChild(nameInput);

      const toolSelect = document.createElement("select");
      toolSelect.className = "settings-inline-select";
      renderAppToolSelectOptions(toolSelect, app.tool || "");
      editor.appendChild(toolSelect);

      const welcomeInput = document.createElement("textarea");
      welcomeInput.className = "settings-inline-textarea";
      welcomeInput.value = typeof app.welcomeMessage === "string" ? app.welcomeMessage : "";
      welcomeInput.placeholder = "Optional first assistant message";
      editor.appendChild(welcomeInput);

      const systemPromptInput = document.createElement("textarea");
      systemPromptInput.className = "settings-inline-textarea";
      systemPromptInput.value = typeof app.systemPrompt === "string" ? app.systemPrompt : "";
      systemPromptInput.placeholder = "Optional system prompt";
      editor.appendChild(systemPromptInput);

      const inlineStatus = document.createElement("div");
      inlineStatus.className = "settings-app-empty inline-status";
      inlineStatus.textContent = "Custom apps are editable here.";
      editor.appendChild(inlineStatus);
      card.appendChild(editor);

      const actions = document.createElement("div");
      actions.className = "settings-app-actions";

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "settings-app-btn";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        inlineStatus.textContent = "Saving…";
        try {
          const updated = await updateAppRecord(app.id, {
            name: nameInput.value,
            tool: toolSelect.value,
            welcomeMessage: welcomeInput.value,
            systemPrompt: systemPromptInput.value,
          });
          inlineStatus.textContent = `Saved ${updated?.name || "app"}.`;
        } catch (error) {
          inlineStatus.textContent = error?.message || "Failed to save app.";
        } finally {
          saveBtn.disabled = false;
        }
      });
      actions.appendChild(saveBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "settings-app-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        deleteBtn.disabled = true;
        inlineStatus.textContent = "Deleting…";
        try {
          await deleteAppRecord(app.id);
        } catch (error) {
          deleteBtn.disabled = false;
          inlineStatus.textContent = error?.message || "Failed to delete app.";
        }
      });
      actions.appendChild(deleteBtn);

      if (shareUrl) {
        const copyLinkBtn = document.createElement("button");
        copyLinkBtn.type = "button";
        copyLinkBtn.className = "settings-app-btn";
        copyLinkBtn.textContent = "Copy Link";
        copyLinkBtn.addEventListener("click", () => {
          void copyShareUrl(shareUrl, copyLinkBtn);
        });
        actions.appendChild(copyLinkBtn);
      }

      card.appendChild(actions);
      settingsAppsList.appendChild(card);
      continue;
    }

    const actions = document.createElement("div");
    actions.className = "settings-app-actions";

    if (shareUrl) {
      const copyLinkBtn = document.createElement("button");
      copyLinkBtn.type = "button";
      copyLinkBtn.className = "settings-app-btn";
      copyLinkBtn.textContent = "Copy Link";
      copyLinkBtn.addEventListener("click", () => {
        void copyShareUrl(shareUrl, copyLinkBtn);
      });
      actions.appendChild(copyLinkBtn);
    }

    card.appendChild(actions);
    settingsAppsList.appendChild(card);
  }
}

function renderSettingsUsersPanel() {
  if (!settingsUsersList) return;
  if (visitorMode) {
    settingsUsersList.innerHTML = '<div class="settings-app-empty">Users are only available to the owner.</div>';
    return;
  }

  settingsUsersList.innerHTML = "";
  const users = Array.isArray(availableUsers) ? availableUsers : [];
  if (users.length === 0) {
    settingsUsersList.innerHTML = '<div class="settings-app-empty">No extra users yet. Admin stays the default view.</div>';
    return;
  }

  const allApps = getOrderedSettingsApps();
  for (const user of users) {
    const card = document.createElement("div");
    card.className = "settings-app-card";

    const header = document.createElement("div");
    header.className = "settings-app-card-header";
    const name = document.createElement("div");
    name.className = "settings-app-name";
    name.textContent = user.name || "Unnamed user";
    const kind = document.createElement("div");
    kind.className = "settings-app-kind";
    const allowedApps = allApps.filter((app) => Array.isArray(user.appIds) && user.appIds.includes(app.id));
    const defaultApp = allowedApps.find((app) => app.id === user.defaultAppId) || allowedApps[0] || null;
    kind.textContent = `${allowedApps.length} app${allowedApps.length === 1 ? "" : "s"} · default ${defaultApp?.name || "Basic Chat"}`;
    header.appendChild(name);
    header.appendChild(kind);
    card.appendChild(header);

    const description = document.createElement("div");
    description.className = "settings-app-description";
    description.textContent = allowedApps.length > 0
      ? `Allowed apps: ${allowedApps.map((app) => app.name || app.id).join(", ")}`
      : "No apps selected yet.";
    card.appendChild(description);

    const editor = document.createElement("div");
    editor.className = "settings-app-editor";

    const nameInput = document.createElement("input");
    nameInput.className = "settings-inline-input";
    nameInput.type = "text";
    nameInput.value = user.name || "";
    editor.appendChild(nameInput);

    const pickerLabel = document.createElement("div");
    pickerLabel.className = "settings-app-kind";
    pickerLabel.textContent = "Allowed apps";
    editor.appendChild(pickerLabel);

    const chipGrid = document.createElement("div");
    chipGrid.className = "settings-app-picker-grid";
    for (const app of allApps) {
      const chip = document.createElement("label");
      chip.className = "settings-app-chip";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = app.id;
      checkbox.checked = Array.isArray(user.appIds) && user.appIds.includes(app.id);
      const text = document.createElement("span");
      text.textContent = app.name || app.id;
      chip.appendChild(checkbox);
      chip.appendChild(text);
      chipGrid.appendChild(chip);
    }
    editor.appendChild(chipGrid);

    const defaultSelect = document.createElement("select");
    defaultSelect.className = "settings-inline-select";
    const syncDefaultOptions = () => {
      const selectedAppIds = [...chipGrid.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
      const selectedApps = allApps.filter((app) => selectedAppIds.includes(app.id));
      defaultSelect.innerHTML = "";
      if (selectedApps.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "Choose at least one app";
        defaultSelect.appendChild(option);
        defaultSelect.disabled = true;
        return;
      }
      defaultSelect.disabled = false;
      for (const app of selectedApps) {
        const option = document.createElement("option");
        option.value = app.id;
        option.textContent = app.name || app.id;
        defaultSelect.appendChild(option);
      }
      const fallbackValue = selectedApps.some((app) => app.id === user.defaultAppId)
        ? user.defaultAppId
        : selectedApps[0].id;
      defaultSelect.value = fallbackValue;
    };
    chipGrid.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.addEventListener("change", syncDefaultOptions);
    });
    syncDefaultOptions();
    editor.appendChild(defaultSelect);

    const inlineStatus = document.createElement("div");
    inlineStatus.className = "settings-app-empty inline-status";
    inlineStatus.textContent = "Changes save immediately. Copy the share link when you are ready to send this user out.";
    editor.appendChild(inlineStatus);
    card.appendChild(editor);

    nameInput.addEventListener("change", async () => {
      const nextName = nameInput.value.trim();
      if (!nextName || nextName === user.name) {
        nameInput.value = user.name || "";
        return;
      }
      const updated = await patchManagedUser(user, { name: nextName }, {
        statusEl: inlineStatus,
        successText: `Saved ${nextName}.`,
      });
      if (updated?.name) {
        user.name = updated.name;
        nameInput.value = updated.name;
      }
    });

    defaultSelect.addEventListener("change", async () => {
      const nextDefaultAppId = defaultSelect.value || user.defaultAppId || "";
      if (!nextDefaultAppId || nextDefaultAppId === user.defaultAppId) return;
      const updated = await patchManagedUser(user, { defaultAppId: nextDefaultAppId }, {
        statusEl: inlineStatus,
        successText: "Default app updated.",
      });
      if (updated?.defaultAppId) {
        user.defaultAppId = updated.defaultAppId;
        defaultSelect.value = updated.defaultAppId;
      }
    });

    chipGrid.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.addEventListener("change", async () => {
        const appIds = [...chipGrid.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
        if (appIds.length === 0) {
          checkbox.checked = true;
          syncDefaultOptions();
          inlineStatus.textContent = "Choose at least one app.";
          return;
        }
        syncDefaultOptions();
        const nextDefaultAppId = defaultSelect.value || appIds[0];
        const updated = await patchManagedUser(user, {
          appIds,
          defaultAppId: nextDefaultAppId,
        }, {
          statusEl: inlineStatus,
          successText: "Allowed apps updated.",
        });
        if (updated) {
          user.appIds = Array.isArray(updated.appIds) ? updated.appIds : appIds;
          user.defaultAppId = updated.defaultAppId || nextDefaultAppId;
          syncDefaultOptions();
        }
      });
    });

    const actions = document.createElement("div");
    actions.className = "settings-app-actions";

    const copyLinkBtn = document.createElement("button");
    copyLinkBtn.type = "button";
    copyLinkBtn.className = "settings-app-btn";
    copyLinkBtn.textContent = "Copy Share Link";
    copyLinkBtn.addEventListener("click", async () => {
      copyLinkBtn.disabled = true;
      inlineStatus.textContent = "Preparing share link…";
      try {
        const shareUrl = await ensureUserShareUrl(user);
        await copyShareUrl(shareUrl, copyLinkBtn);
        inlineStatus.textContent = "Share link copied.";
      } catch (error) {
        inlineStatus.textContent = error?.message || "Failed to prepare share link.";
      } finally {
        copyLinkBtn.disabled = false;
      }
    });
    actions.appendChild(copyLinkBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "settings-app-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      deleteBtn.disabled = true;
      inlineStatus.textContent = "Deleting…";
      try {
        await deleteUserRecord(user.id);
        if (activeUserFilter === user.id) {
          activeUserFilter = ADMIN_USER_FILTER_VALUE;
          persistActiveUserFilter(activeUserFilter);
          refreshAppCatalog();
          renderSessionList();
        }
      } catch (error) {
        deleteBtn.disabled = false;
        inlineStatus.textContent = error?.message || "Failed to delete user.";
      }
    });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    settingsUsersList.appendChild(card);
  }
}

function createNewSessionShortcut({ closeSidebar = true } = {}) {
  const principal = resolveSelectedSessionPrincipal();
  const appId = resolveAppIdForPrincipal(principal, activeSessionAppFilter);
  const app = getAppRecordById(appId);
  if (!app) return false;
  return createSessionForApp(app, { closeSidebar, principal });
}

function createNewAppShortcut({ closeSidebar = true } = {}) {
  return focusNewAppComposer({ closeSidebar });
}

menuBtn.addEventListener("click", openSidebar);
closeSidebar.addEventListener("click", closeSidebarFn);
sidebarOverlay.addEventListener("click", (e) => {
  if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
});

// ---- New Session ----
newAppBtn.addEventListener("click", () => {
  createNewAppShortcut();
});

newSessionBtn.addEventListener("click", () => {
  createNewSessionShortcut();
});

createUserBtn?.addEventListener("click", () => {
  void handleCreateUser();
});

newUserNameInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void handleCreateUser();
});

createAppConfigBtn?.addEventListener("click", () => {
  void handleCreateApp();
});

// ---- Image handling ----
function buildPendingAttachment(file) {
  return {
    file,
    originalName: typeof file?.name === "string" ? file.name : "",
    mimeType: file.type || "application/octet-stream",
    objectUrl: URL.createObjectURL(file),
  };
}

async function addImageFiles(files) {
  for (const file of files) {
    if (pendingImages.length >= 4) break;
    pendingImages.push(buildPendingAttachment(file));
  }
  renderImagePreviews();
}

function renderImagePreviews() {
  imgPreviewStrip.innerHTML = "";
  if (pendingImages.length === 0) {
    imgPreviewStrip.classList.remove("has-images");
    if (typeof requestLayoutPass === "function") {
      requestLayoutPass("composer-images");
    } else if (typeof syncInputHeightForLayout === "function") {
      syncInputHeightForLayout();
    }
    return;
  }
  imgPreviewStrip.classList.add("has-images");
  pendingImages.forEach((img, i) => {
    const item = document.createElement("div");
    item.className = "img-preview-item";
    const previewNode = createComposerAttachmentPreviewNode(img);
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-img";
    removeBtn.type = "button";
    removeBtn.title = "Remove attachment";
    removeBtn.setAttribute("aria-label", "Remove attachment");
    removeBtn.innerHTML = renderUiIcon("close");
    removeBtn.onclick = () => {
      URL.revokeObjectURL(img.objectUrl);
      pendingImages.splice(i, 1);
      renderImagePreviews();
    };
    if (previewNode) {
      item.appendChild(previewNode);
    }
    item.appendChild(removeBtn);
    imgPreviewStrip.appendChild(item);
  });
  if (typeof requestLayoutPass === "function") {
    requestLayoutPass("composer-images");
  } else if (typeof syncInputHeightForLayout === "function") {
    syncInputHeightForLayout();
  }
}

imgBtn.addEventListener("click", () => imgFileInput.click());
imgFileInput.addEventListener("change", () => {
  if (imgFileInput.files.length > 0) addImageFiles(imgFileInput.files);
  imgFileInput.value = "";
});

msgInput.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length > 0) {
    e.preventDefault();
    addImageFiles(imageFiles);
  }
});
