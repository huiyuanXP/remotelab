(function () {
  "use strict";

  console.log("hello!");

  // Reliable touch detection: add class to <html> so CSS can target it
  // More reliable than @media (hover: none) on real Android/iOS devices
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    document.documentElement.classList.add('touch-device');
  }

  // ---- Elements ----
  const menuBtn = document.getElementById("menuBtn");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const closeSidebar = document.getElementById("closeSidebar");
  const collapseBtn = document.getElementById("collapseBtn");
  const sessionList = document.getElementById("sessionList");
  const newSessionBtn = document.getElementById("newSessionBtn");
  const newSessionModal = document.getElementById("newSessionModal");
  const folderInput = document.getElementById("folderInput");
  const folderSuggestions = document.getElementById("folderSuggestions");

  const toolSelect = document.getElementById("toolSelect");
  const cancelModal = document.getElementById("cancelModal");
  const createSessionBtn = document.getElementById("createSession");
  const messagesEl = document.getElementById("messages");
  const messagesInner = document.getElementById("messagesInner");
  const emptyState = document.getElementById("emptyState");
  const msgInput = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");
  const headerTitle = document.getElementById("headerTitle");
  const statusText = document.getElementById("statusText");
  const imgBtn = document.getElementById("imgBtn");
  const imgFileInput = document.getElementById("imgFileInput");
  const imgPreviewStrip = document.getElementById("imgPreviewStrip");
  const fileAttachBtn = document.getElementById("fileAttachBtn");
  const fileAttachInput = document.getElementById("fileAttachInput");
  const inlineToolSelect = document.getElementById("inlineToolSelect");
  const inlineModelSelect = document.getElementById("inlineModelSelect");
  const thinkingToggle = document.getElementById("thinkingToggle");
  const cancelBtn = document.getElementById("cancelBtn");
  const quickReplies = document.getElementById("quickReplies");
  const tabSessions = document.getElementById("tabSessions");
  const tabProgress = document.getElementById("tabProgress");
  const tabTasks = document.getElementById("tabTasks");
  const progressPanel = document.getElementById("progressPanel");
  const taskPanel = document.getElementById("taskPanel");
  const workflowView = document.getElementById("workflowView");
  const headerCtx = document.getElementById("headerCtx");
  const headerCtxDetail = document.getElementById("headerCtxDetail");
  const headerCtxFill = document.getElementById("headerCtxFill");
  const headerCtxPct = document.getElementById("headerCtxPct");
  const headerCtxCompress = document.getElementById("headerCtxCompress");
  const headerCtxClear = document.getElementById("headerCtxClear");
  const floatingLogo = document.getElementById("floatingLogo");
  const headerLogo = document.getElementById("headerLogo");

  let ws = null;
  let pendingImages = [];
  let pendingFiles = []; // { file: File, name: string }
  let currentSessionId = null;
  let sessionStatus = "idle";
  let reconnectTimer = null;
  let sessions = [];
  let workflowSessions = []; // hidden sessions created by workflow engine
  let archivedSessions = []; // archived sessions (hidden from main list)
  let knownFolders = new Set(); // all folders ever seen (active + archived) — avoids O(n) scan per render
  let showArchived = false;
  let currentHistory = []; // raw events for current session (used by Recover)
  let sessionContextTotal = 0; // latest total context tokens (input + cache)
  let pendingSummary = new Set(); // sessionIds awaiting summary generation
  let currentTaskDetailId = null; // currently viewed task in main content area
  let taskDetailCountdownInterval = null; // interval for next-run countdown in task detail panel
  let activeRunPollInterval = null; // interval for polling a live run's status
  let lastSidebarUpdatedAt = {}; // sessionId -> last known updatedAt

  let sessionLastMessage = {}; // sessionId -> last sent message text
  let pendingClearedBanner = false; // show cleared banner on next history load
  let sessionLabels = []; // loaded from /api/session-labels

  let selectedTool = localStorage.getItem("selectedTool") || null;
  let selectedModel = localStorage.getItem("selectedModel") || "";
  // Default thinking to enabled; only disable if explicitly set to 'false'
  let thinkingEnabled = localStorage.getItem("thinkingEnabled") !== "false";
  let sidebarCollapsed = localStorage.getItem("sidebarCollapsed") === "true";
  let themeMode = localStorage.getItem("themeMode") || "auto"; // 'auto' | 'dark' | 'light'
  const themeBtn = document.getElementById("themeBtn");
  let toolsList = [];
  let isDesktop = window.matchMedia("(min-width: 768px)").matches;
  let collapsedFolders = JSON.parse(
    localStorage.getItem("collapsedFolders") || "{}",
  );

  // Thinking block state
  let currentThinkingBlock = null; // { el, body, tools: Set }
  let inThinkingBlock = false;

  // ---- Browser Notifications ----
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }

  function notifyCompletion(session) {
    if (!("Notification" in window) || Notification.permission !== "granted")
      return;
    if (document.visibilityState === "visible") return;
    const folder = (session?.folder || "").split("/").pop() || "Session";
    const lastMsg = sessionLastMessage[session?.id] || "";
    const snippet = lastMsg.length > 60 ? lastMsg.slice(0, 60) + "…" : lastMsg;
    const body = snippet ? `${folder}: ${snippet}` : `${folder} — task completed`;
    const n = new Notification("RemoteLab", {
      body,
      tag: "remotelab-done",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }

  // ---- Theme ----
  function isDarkByTime() {
    const h = new Date().getHours();
    return h < 7 || h >= 19;
  }

  function applyTheme() {
    const dark = themeMode === "dark" || (themeMode === "auto" && isDarkByTime());
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const icons = { auto: "◑", dark: "●", light: "○" };
    const titles = { auto: "自动（时间段）", dark: "深色模式", light: "浅色模式" };
    themeBtn.textContent = icons[themeMode];
    themeBtn.title = titles[themeMode];
  }

  function toggleTheme() {
    const cycle = { auto: "dark", dark: "light", light: "auto" };
    themeMode = cycle[themeMode];
    localStorage.setItem("themeMode", themeMode);
    applyTheme();
  }

  // ---- Responsive layout ----
  function initResponsiveLayout() {
    const mq = window.matchMedia("(min-width: 768px)");
    function onBreakpointChange(e) {
      isDesktop = e.matches;
      if (isDesktop) {
        sidebarOverlay.classList.remove("open");
        if (sidebarCollapsed) sidebarOverlay.classList.add("collapsed");
      } else {
        sidebarOverlay.classList.remove("collapsed");
      }
    }
    mq.addEventListener("change", onBreakpointChange);
    onBreakpointChange(mq);
  }

  // ---- Thinking toggle ----
  function updateThinkingUI() {
    thinkingToggle.classList.toggle("active", thinkingEnabled);
  }
  updateThinkingUI();

  thinkingToggle.addEventListener("click", () => {
    thinkingEnabled = !thinkingEnabled;
    localStorage.setItem("thinkingEnabled", thinkingEnabled);
    updateThinkingUI();
  });

  // ---- Sidebar collapse (desktop) ----
  collapseBtn.addEventListener("click", () => {
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem("sidebarCollapsed", sidebarCollapsed);
    sidebarOverlay.classList.toggle("collapsed", sidebarCollapsed);
  });

  // ---- Inline tool select ----
  async function loadInlineTools() {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      toolsList = (data.tools || []).filter((t) => t.available);
      inlineToolSelect.innerHTML = "";
      for (const t of toolsList) {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        inlineToolSelect.appendChild(opt);
      }
      if (selectedTool && toolsList.some((t) => t.id === selectedTool)) {
        inlineToolSelect.value = selectedTool;
      } else if (toolsList.length > 0) {
        selectedTool = toolsList[0].id;
      }
    } catch {}
  }

  inlineToolSelect.addEventListener("change", () => {
    selectedTool = inlineToolSelect.value;
    localStorage.setItem("selectedTool", selectedTool);
    loadInlineModels(selectedTool);
  });

  // ---- Inline model select ----
  const CLAUDE_MODELS = [
    { id: "sonnet", name: "Sonnet" },
    { id: "opus", name: "Opus" },
    { id: "haiku", name: "Haiku" },
    { id: "sonnet[1m]", name: "Sonnet 1M" },
    { id: "opus[1m]", name: "Opus 1M" },
  ];

  function populateModelSelect(models, tool, serverDefault, sessionModel) {
    const storageKey = `selectedModel_${tool || "claude"}`;
    const saved = localStorage.getItem(storageKey);

    inlineModelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      inlineModelSelect.appendChild(opt);
    }
    // Priority: session-persisted > localStorage > server default > first item
    const preferred = (sessionModel && models.some((m) => m.id === sessionModel) ? sessionModel : null)
      || saved || serverDefault;
    if (preferred && models.some((m) => m.id === preferred)) {
      inlineModelSelect.value = preferred;
      selectedModel = preferred;
    } else if (models.length > 0) {
      selectedModel = models[0].id;
      inlineModelSelect.value = selectedModel;
      localStorage.setItem(storageKey, selectedModel);
    }
  }

  async function loadInlineModels(tool, sessionModel) {
    const activeTool = tool || selectedTool;
    if (activeTool === "codex") {
      try {
        const res = await fetch(`/api/models?tool=codex`);
        const data = await res.json();
        if (data.models && data.models.length > 0) {
          populateModelSelect(data.models, activeTool, data.default, sessionModel);
          return;
        }
      } catch {}
    }
    // Claude (or codex fetch failed): use hardcoded list
    populateModelSelect(CLAUDE_MODELS, activeTool, null, sessionModel);
  }

  inlineModelSelect.addEventListener("change", () => {
    selectedModel = inlineModelSelect.value;
    const storageKey = `selectedModel_${selectedTool || "claude"}`;
    localStorage.setItem(storageKey, selectedModel);
  });

  // ---- WebSocket ----
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      updateStatus("connected", "idle");
      const restartBanner = document.getElementById("restart-banner");
      if (restartBanner) restartBanner.remove();
      ws.send(JSON.stringify({ action: "list" }));
      if (currentSessionId) {
        ws.send(
          JSON.stringify({ action: "attach", sessionId: currentSessionId }),
        );
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleWsMessage(msg);
    };

    ws.onclose = () => {
      updateStatus("disconnected", "idle");
      scheduleReconnect();
    };

    ws.onerror = () => ws.close();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 3000);
  }

  function wsSend(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case "sessions":
        // Filter: hidden → workflow engine sessions; archived → includes disposable task runs
        sessions = (msg.sessions || []).filter(s => !s.hidden && !s.archived);
        workflowSessions = (msg.sessions || []).filter(s => s.hidden);
        archivedSessions = (msg.sessions || []).filter(s => !s.hidden && s.archived);
        rebuildKnownFolders();
        renderSessionList();
        break;

      case "session":
        if (msg.session) {
          const isHidden = !!msg.session.hidden;
          const isArchived = !!msg.session.archived;
          // Save original position before removing (to preserve list order on updates)
          const prevSessionIdx = sessions.findIndex(s => s.id === msg.session.id);
          const prevEntry = sessions.find(s => s.id === msg.session.id)
            || archivedSessions.find(s => s.id === msg.session.id)
            || workflowSessions.find(s => s.id === msg.session.id);
          // Determine target array and remove from any other array to handle moves
          if (!isHidden) {
            sessions = sessions.filter(s => s.id !== msg.session.id);
            archivedSessions = archivedSessions.filter(s => s.id !== msg.session.id);
          }
          const targetArr = isHidden ? workflowSessions : (isArchived ? archivedSessions : sessions);
          const prevStatus = sessionStatus;
          sessionStatus = msg.session.status || "idle";
          updateStatus("connected", sessionStatus);
          const wasRunning = prevEntry?.status === "running";
          if (
            msg.session.id === currentSessionId &&
            prevStatus === "running" &&
            sessionStatus === "idle"
          ) {
            notifyCompletion(msg.session);
          }
          // Mark as pending summary when any session goes running → idle
          if (wasRunning && msg.session.status === "idle") {
            pendingSummary.add(msg.session.id);
            if (activeTab === "progress") renderProgressPanel(lastProgressState);
          }
          const idx = targetArr.findIndex((s) => s.id === msg.session.id);
          if (idx >= 0) {
            targetArr[idx] = msg.session;
          } else if (prevSessionIdx >= 0 && targetArr === sessions) {
            // Re-insert at original position to prevent reordering on update
            sessions.splice(prevSessionIdx, 0, msg.session);
          } else {
            targetArr.push(msg.session);
          }
          rebuildKnownFolders();
          // Update header title if current session was renamed (e.g. auto-title)
          if (msg.session.id === currentSessionId && msg.session.name) {
            headerTitle.textContent = msg.session.name;
          }
          if (isHidden) {
            // workflow sessions update silently; task section refreshes on demand
          } else {
            renderSessionList();
          }
        }
        break;

      case "history":
        if (pendingClearedBanner) {
          pendingClearedBanner = false;
          renderSessionClearedBanner();
        } else {
          clearMessages();
        }
        if (msg.events && msg.events.length > 0) {
          currentHistory = [...msg.events];
          for (const evt of msg.events) renderEvent(evt, false);
          scrollToBottom();
        }
        break;

      case "event":
        if (msg.event) {
          currentHistory.push(msg.event);
          renderEvent(msg.event, true);
        }
        break;

      case "deleted":
        sessions = sessions.filter((s) => s.id !== msg.sessionId);
        workflowSessions = workflowSessions.filter((s) => s.id !== msg.sessionId);
        archivedSessions = archivedSessions.filter((s) => s.id !== msg.sessionId);
        rebuildKnownFolders();
        if (currentSessionId === msg.sessionId) {
          currentSessionId = null;
          clearMessages();
          showEmpty();
        }
        renderSessionList();
        break;

      case "compact":
        // Server says: session compacted, switch to new session
        if (msg.newSessionId && msg.oldSessionId === currentSessionId) {
          console.log(`[compact] Switching from ${msg.oldSessionId.slice(0,8)} to ${msg.newSessionId.slice(0,8)}`);
          // Refresh session list, then attach to new session
          wsSend({ action: "list" });
          const compactHandler = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.type === "sessions") {
              ws.removeEventListener("message", compactHandler);
              sessions = m.sessions || [];
              renderSessionList();
              const newSess = sessions.find(s => s.id === msg.newSessionId);
              if (newSess) attachSession(newSess.id, newSess);
            }
          };
          ws.addEventListener("message", compactHandler);
        }
        break;

      case "server_restart":
        showRestartBanner(msg.message);
        break;

      case "error":
        console.error("WS error:", msg.message);
        break;
    }
  }

  function showRestartBanner(message) {
    const existing = document.getElementById("restart-banner");
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.id = "restart-banner";
    banner.className = "restart-banner";
    banner.textContent = message || "Server is restarting...";
    document.body.appendChild(banner);
  }

  function renderRestartDivider(text, extraClass) {
    if (inThinkingBlock) finalizeThinkingBlock();
    const div = document.createElement("div");
    div.className = `restart-divider ${extraClass}`;
    div.innerHTML = `<span class="restart-divider-text">${text}</span>`;
    messagesInner.appendChild(div);
    scrollToBottom();
  }

  // ---- Status ----
  function updateStatus(connState, sessState) {
    if (connState === "disconnected") {
      headerLogo.classList.remove("active");
      statusText.textContent = "disconnected";
      msgInput.disabled = true;
      sendBtn.style.display = "";
      sendBtn.disabled = true;
      cancelBtn.style.display = "none";
      floatingLogo.classList.remove("active");
      return;
    }
    sessionStatus = sessState;
    const isRunning = sessState === "running";
    headerLogo.classList.toggle("active", isRunning);
    statusText.textContent = isRunning ? "running" : (currentSessionId ? "idle" : "connected");
    const hasSession = !!currentSessionId;
    msgInput.disabled = !hasSession;
    // Show both Send and Stop when running (Send = interrupt & send new message)
    sendBtn.style.display = "";
    sendBtn.disabled = !hasSession;
    sendBtn.title = isRunning ? "Interrupt & send" : "Send";
    cancelBtn.style.display = isRunning && hasSession ? "flex" : "none";
    msgInput.placeholder = isRunning ? "Send a correction or hint..." : "Message...";
    imgBtn.disabled = !hasSession;
    fileAttachBtn.disabled = !hasSession;
    inlineToolSelect.disabled = !hasSession;
    inlineModelSelect.disabled = !hasSession;
    thinkingToggle.disabled = !hasSession;
    quickReplies.style.display = hasSession && !isRunning ? "flex" : "none";
  }

  // ---- Floating logo & favicon global status ----
  const faviconEl = document.getElementById("favicon");
  const faviconCanvas = document.createElement("canvas");
  faviconCanvas.width = 64;
  faviconCanvas.height = 64;
  const faviconCtx = faviconCanvas.getContext("2d");
  let faviconAngle = 0;
  let faviconAnimating = false;
  let faviconRAF = null;

  // Build SVG image for favicon
  function makeFaviconSvg(color) {
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><g stroke='${color}' stroke-width='5.5' fill='none'><circle cx='50' cy='28' r='19'/><circle cx='72' cy='50' r='19'/><circle cx='50' cy='72' r='19'/><circle cx='28' cy='50' r='19'/></g><circle cx='50' cy='50' r='4' fill='${color}'/></svg>`;
  }

  const faviconImgIdle = new Image();
  faviconImgIdle.src = "data:image/svg+xml," + encodeURIComponent(makeFaviconSvg("#6b7280"));
  const faviconImgActive = new Image();
  faviconImgActive.src = "data:image/svg+xml," + encodeURIComponent(makeFaviconSvg("#22c55e"));

  function drawFavicon(img, angle) {
    const s = 64;
    faviconCtx.clearRect(0, 0, s, s);
    faviconCtx.save();
    faviconCtx.translate(s / 2, s / 2);
    faviconCtx.rotate(angle);
    faviconCtx.drawImage(img, -s / 2, -s / 2, s, s);
    faviconCtx.restore();
    faviconEl.href = faviconCanvas.toDataURL("image/png");
  }

  function animateFavicon(ts) {
    if (!faviconAnimating) return;
    // 8s per full rotation, matching CSS logo-spin
    faviconAngle = ((ts % 8000) / 8000) * Math.PI * 2;
    drawFavicon(faviconImgActive, faviconAngle);
    faviconRAF = requestAnimationFrame(animateFavicon);
  }

  function startFaviconSpin() {
    if (faviconAnimating) return;
    faviconAnimating = true;
    faviconRAF = requestAnimationFrame(animateFavicon);
  }

  function stopFaviconSpin() {
    faviconAnimating = false;
    if (faviconRAF) { cancelAnimationFrame(faviconRAF); faviconRAF = null; }
    faviconAngle = 0;
    drawFavicon(faviconImgIdle, 0);
  }

  function updateFloatingLogo() {
    const anyRunning = sessions.some(s => s.status === "running");
    floatingLogo.classList.toggle("active", anyRunning);
    if (anyRunning) startFaviconSpin();
    else stopFaviconSpin();
  }

  // ---- Message rendering ----
  function clearMessages() {
    messagesInner.innerHTML = "";
    // Reset thinking block state
    inThinkingBlock = false;
    currentThinkingBlock = null;
    currentHistory = [];
    sessionContextTotal = 0;
  }

  function showEmpty() {
    messagesInner.innerHTML = "";
    messagesInner.appendChild(emptyState);
    inThinkingBlock = false;
    currentThinkingBlock = null;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function renderEvent(evt, autoScroll) {
    if (emptyState.parentNode === messagesInner) emptyState.remove();

    const shouldScroll =
      autoScroll &&
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <
        120;

    switch (evt.type) {
      case "message":
        renderMessage(evt);
        break;
      case "tool_use":
        renderToolUse(evt);
        break;
      case "tool_result":
        renderToolResult(evt);
        break;
      case "file_change":
        renderFileChange(evt);
        break;
      case "reasoning":
        renderReasoning(evt);
        break;
      case "status":
        renderStatusMsg(evt);
        break;
      case "usage":
        renderUsage(evt);
        break;
      case "question":
        renderQuestion(evt);
        break;
      case "plan_approval":
        renderPlanApproval(evt);
        break;
      case "session_error":
        renderSessionError(evt);
        break;
      case "compact":
        renderCompactDivider(evt);
        break;
      case "restart_interrupt":
        renderRestartDivider("\u26a1 Server restarting \u2014 session will resume automatically", "restart-interrupt-divider");
        break;
      case "restart_resume":
        renderRestartDivider("\u2713 Server restarted \u2014 continuing your work...", "restart-resume-divider");
        break;
    }

    if (shouldScroll) scrollToBottom();
  }

  // ---- Thinking block helpers ----
  function openThinkingBlock() {
    const block = document.createElement("div");
    block.className = "thinking-block collapsed"; // collapsed by default

    const header = document.createElement("div");
    header.className = "thinking-header";
    header.innerHTML = `<span class="thinking-icon">&#9881;</span>
      <span class="thinking-label">Thinking…</span>
      <span class="thinking-chevron">&#9660;</span>`;

    const body = document.createElement("div");
    body.className = "thinking-body";

    header.addEventListener("click", () => {
      block.classList.toggle("collapsed");
    });

    block.appendChild(header);
    block.appendChild(body);
    messagesInner.appendChild(block);

    currentThinkingBlock = {
      el: block,
      header,
      body,
      label: header.querySelector(".thinking-label"),
      tools: new Set(),
    };
    inThinkingBlock = true;
  }

  function finalizeThinkingBlock() {
    if (!currentThinkingBlock) return;
    const { label, tools } = currentThinkingBlock;
    const toolList = [...tools];
    if (toolList.length > 0) {
      label.textContent = `Thought · used ${toolList.join(", ")}`;
    } else {
      label.textContent = "Thought";
    }
    inThinkingBlock = false;
    currentThinkingBlock = null;
  }

  function getThinkingBody() {
    if (!inThinkingBlock) openThinkingBlock();
    return currentThinkingBlock.body;
  }

  // ---- Render functions ----
  function renderMessage(evt) {
    const role = evt.role || "assistant";

    if (role === "assistant" && inThinkingBlock) {
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
          const imgEl = document.createElement("img");
          imgEl.src = `/api/images/${img.filename}`;
          imgEl.alt = "attached image";
          imgEl.loading = "lazy";
          imgEl.onclick = () => window.open(imgEl.src, "_blank");
          imgWrap.appendChild(imgEl);
        }
        bubble.appendChild(imgWrap);
      }
      if (evt.content) {
        const span = document.createElement("span");
        span.textContent = evt.content;
        bubble.appendChild(span);
      }
      wrap.appendChild(bubble);
      messagesInner.appendChild(wrap);
    } else {
      const div = document.createElement("div");
      div.className = "msg-assistant md-content";
      if (evt.content) div.innerHTML = marked.parse(evt.content);
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
      <span class="tool-toggle">&#9654;</span>`;

    const body = document.createElement("div");
    body.className = "tool-body";
    body.id = "tool_" + evt.id;
    const pre = document.createElement("pre");
    pre.textContent = evt.toolInput || "";
    body.appendChild(pre);

    header.addEventListener("click", () => {
      header.classList.toggle("expanded");
      body.classList.toggle("expanded");
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
      pre.textContent = evt.output || "";
      body.appendChild(label);
      body.appendChild(pre);
      if (evt.exitCode && evt.exitCode !== 0) {
        targetCard.querySelector(".tool-header").classList.add("expanded");
        body.classList.add("expanded");
      }
    }
  }

  function renderFileChange(evt) {
    const container = getThinkingBody();
    const div = document.createElement("div");
    div.className = "file-card";
    const kind = evt.changeType || "edit";
    div.innerHTML = `<span class="file-path">${esc(evt.filePath || "")}</span>
      <span class="change-type ${kind}">${kind}</span>`;
    container.appendChild(div);
  }

  function renderReasoning(evt) {
    const container = getThinkingBody();
    const div = document.createElement("div");
    div.className = "reasoning";
    div.textContent = evt.content || "";
    container.appendChild(div);
  }

  function renderStatusMsg(evt) {
    if (!evt.content || evt.content === "completed" || evt.content === "thinking")
      return;
    const c = evt.content;
    // Filter out internal process-level status messages
    if (
      c === "Starting CLI..." ||
      c === "Resuming session..." ||
      c.startsWith("Waiting for CLI") ||
      c.startsWith("auto-continuing")
    )
      return;
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = c;
    messagesInner.appendChild(div);
  }

  const CONTEXT_WINDOW = 200000; // claude-sonnet context window
  const CONTEXT_DANGER_THRESHOLD = 0.85; // header danger threshold

  function fmtTok(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function updateHeaderContext(input, output, cacheWrite, cacheRead) {
    // Context fill = input + cacheCreation.
    // cacheCreation accumulates the system prompt (first call) + all conversation history
    // (each subsequent call), so it ≈ the total tokens sent on the most recent API call.
    //
    // cacheRead is NOT included: it's a cumulative count of how many times previously-cached
    // content was re-read across ALL API calls in the run (e.g. system prompt re-read 9× for
    // a task with 9 tool calls = 450k), so it always exceeds the 200k window and is meaningless
    // for measuring context fill.
    const contextTotal = input + cacheWrite;
    const pct = Math.min(contextTotal / CONTEXT_WINDOW, 1);
    const pctRounded = Math.round(pct * 100);

    // Line 1: total context (what fills the window) + output
    // Line 2: breakdown — new input this call vs accumulated cache
    headerCtxDetail.textContent =
      `ctx: ${fmtTok(contextTotal)}  out: ${fmtTok(output)}\nin: ${fmtTok(input)}  +c: ${fmtTok(cacheWrite)}`;

    headerCtxFill.style.width = `${pct * 100}%`;
    headerCtxFill.className = "header-ctx-fill" +
      (pct >= CONTEXT_DANGER_THRESHOLD ? " danger" : pct >= 0.6 ? " warn" : "");

    headerCtxPct.textContent = `${pctRounded}%`;
    headerCtxPct.className = "header-ctx-pct" + (pct >= CONTEXT_DANGER_THRESHOLD ? " danger" : "");

    if (pct >= CONTEXT_DANGER_THRESHOLD) {
      headerCtxCompress.classList.add("visible");
    } else {
      headerCtxCompress.classList.remove("visible");
    }
    headerCtxClear.classList.add("visible");

    // Shrink the title to give space to the bar
    headerTitle.style.flex = "0 0 auto";
    headerCtx.classList.add("visible");
  }

  function resetHeaderContext() {
    headerCtx.classList.remove("visible");
    headerCtxCompress.disabled = false;
    headerCtxCompress.textContent = "Compress";
    headerCtxClear.disabled = false;
    headerCtxClear.textContent = "Clear";
    headerTitle.style.flex = "";
  }

  headerCtxCompress.addEventListener("click", () => {
    if (!currentSessionId) return;
    wsSend({ action: "compact" });
    headerCtxCompress.disabled = true;
    headerCtxCompress.textContent = "Compressing…";
  });

  headerCtxClear.addEventListener("click", () => {
    if (!currentSessionId) return;
    const sess = sessions.find((s) => s.id === currentSessionId);
    if (!sess) return;
    if (!confirm("清空这个 Session？会创建一个全新的会话，AI 不会继承之前的对话内容。")) return;
    headerCtxClear.disabled = true;
    headerCtxClear.textContent = "Clearing…";
    pendingClearedBanner = true;
    wsSend({ action: "create", folder: sess.folder, tool: sess.tool || selectedTool, name: sess.name || "" });
    const handler = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "session" && msg.session) {
        ws.removeEventListener("message", handler);
        attachSession(msg.session.id, msg.session);
        wsSend({ action: "list" });
      }
    };
    ws.addEventListener("message", handler);
  });

  function renderUsage(evt) {
    const input = evt.inputTokens || 0;
    const output = evt.outputTokens || 0;
    const cacheWrite = evt.cacheCreationTokens || 0;
    // cacheRead excluded: it's cumulative across all API calls in the run, not per-call context
    const total = input + cacheWrite;
    sessionContextTotal = total;

    updateHeaderContext(input, output, cacheWrite, evt.cacheReadTokens || 0);

    const div = document.createElement("div");
    div.className = "usage-info";

    const tokens = document.createElement("span");
    tokens.textContent = `ctx: ${total.toLocaleString()} · out: ${output.toLocaleString()}`;
    div.appendChild(tokens);

    messagesInner.appendChild(div);
  }

  function renderSessionClearedBanner() {
    if (emptyState.parentNode === messagesInner) emptyState.remove();
    const banner = document.createElement("div");
    banner.className = "session-cleared-banner";
    banner.innerHTML = `
      <div class="session-cleared-icon">🗑</div>
      <div class="session-cleared-title">Session 已清空</div>
      <div class="session-cleared-desc">以上消息已被清空，AI 不会继承上方任何对话内容。<br>这是一个全新的会话，请重新开始。</div>`;
    messagesInner.appendChild(banner);
  }

  function renderCompactDivider(evt) {
    if (inThinkingBlock) finalizeThinkingBlock();
    const div = document.createElement("div");
    div.className = "compact-divider";
    div.innerHTML = '<span class="compact-divider-text">Context compacted &mdash; conversation continues in a new session</span>';
    if (evt.summary) {
      const details = document.createElement("details");
      details.className = "compact-summary-details";
      const summaryEl = document.createElement("summary");
      summaryEl.textContent = "View summary";
      details.appendChild(summaryEl);
      const pre = document.createElement("pre");
      pre.className = "compact-summary-pre";
      pre.textContent = evt.summary;
      details.appendChild(pre);
      div.appendChild(details);
    }
    messagesInner.appendChild(div);
    scrollToBottom();
  }

  function renderSessionError(evt) {
    if (inThinkingBlock) finalizeThinkingBlock();
    const card = document.createElement("div");
    card.className = "interactive-card session-error-card";

    const tag = document.createElement("span");
    tag.className = "interactive-tag";
    tag.textContent = "Session Error";
    card.appendChild(tag);

    const msg = document.createElement("p");
    msg.className = "interactive-question";
    msg.textContent = "The session could not be resumed. You can delete it or recover the conversation by replaying history into a new session.";
    card.appendChild(msg);

    const actions = document.createElement("div");
    actions.className = "session-error-actions";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "session-error-btn session-error-delete";
    deleteBtn.textContent = "Delete session";
    deleteBtn.addEventListener("click", () => {
      if (!currentSessionId) return;
      if (confirm("Delete this session?")) {
        wsSend({ action: "delete", sessionId: currentSessionId });
      }
    });

    const recoverBtn = document.createElement("button");
    recoverBtn.className = "session-error-btn session-error-recover";
    recoverBtn.textContent = "Recover conversation";
    recoverBtn.addEventListener("click", () => recoverSession(recoverBtn));

    actions.appendChild(deleteBtn);
    actions.appendChild(recoverBtn);
    card.appendChild(actions);
    messagesInner.appendChild(card);
  }

  function recoverSession(btn) {
    const currentSession = sessions.find((s) => s.id === currentSessionId);
    if (!currentSession) return;

    // Build a recovery prompt from the visible conversation history
    const lines = ["[Previous conversation for context recovery — please review and confirm ready to continue:]", ""];
    for (const e of currentHistory) {
      if (e.type === "message" && e.role === "user" && e.content) {
        lines.push(`[USER]: ${e.content}`);
      } else if (e.type === "message" && e.role === "assistant" && e.content) {
        lines.push(`[ASSISTANT]: ${e.content}`);
      }
    }
    lines.push("", "[Please confirm you have reviewed the above and are ready to continue.]");
    const recoveryPrompt = lines.join("\n");

    if (btn) { btn.disabled = true; btn.textContent = "Recovering…"; }

    // Create new session, attach, send recovery prompt
    const tool = currentSession.tool || selectedTool;
    const name = (currentSession.name || "").replace(/ \(recovered\)$/, "") + " (recovered)";
    wsSend({ action: "create", folder: currentSession.folder, tool, name });

    const handler = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "session" && msg.session) {
        ws.removeEventListener("message", handler);
        attachSession(msg.session.id, msg.session);
        wsSend({ action: "list" });
        // Send the recovery prompt after attach completes (history loads first)
        setTimeout(() => {
          const m = { action: "send", text: recoveryPrompt };
          if (tool) m.tool = tool;
          m.thinking = thinkingEnabled;
          wsSend(m);
        }, 300);
      }
    };
    ws.addEventListener("message", handler);
  }

  // ---- Interactive events (AskUserQuestion / ExitPlanMode passthrough) ----

  function sendQuickReply(text) {
    if (!currentSessionId) return;
    sessionLastMessage[currentSessionId] = text;
    const msg = { action: "send", text };
    if (selectedTool) msg.tool = selectedTool;
    msg.model = selectedModel;
    msg.thinking = thinkingEnabled;
    wsSend(msg);
  }

  function renderQuestion(evt) {
    if (inThinkingBlock) finalizeThinkingBlock();

    const questions = evt.questions;
    if (!Array.isArray(questions) || questions.length === 0) return;

    const card = document.createElement("div");
    card.className = "interactive-card question-card";

    // Per-question answer state: index -> selected labels (array for multi, single-element for single)
    const answers = questions.map(() => []);

    questions.forEach((q, qi) => {
      const section = document.createElement("div");
      section.className = "question-section";

      if (q.header) {
        const tag = document.createElement("span");
        tag.className = "interactive-tag";
        tag.textContent = q.header;
        section.appendChild(tag);
      }

      const qText = document.createElement("div");
      qText.className = "interactive-question";
      qText.textContent = q.question || "";
      section.appendChild(qText);

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "interactive-options";

      const optBtns = [];
      for (const opt of (q.options || [])) {
        const btn = document.createElement("button");
        btn.className = "interactive-option-btn";
        const labelSpan = document.createElement("span");
        labelSpan.className = "option-label";
        labelSpan.textContent = opt.label;
        btn.appendChild(labelSpan);
        if (opt.description) {
          const descSpan = document.createElement("span");
          descSpan.className = "option-desc";
          descSpan.textContent = opt.description;
          btn.appendChild(descSpan);
        }
        btn.addEventListener("click", () => {
          if (card.classList.contains("submitted")) return;
          // Clear other input when option selected
          const otherIn = section.querySelector(".interactive-other-input");
          if (otherIn) otherIn.value = "";

          if (q.multiSelect) {
            btn.classList.toggle("selected");
            const sel = [];
            optBtns.forEach(b => { if (b.classList.contains("selected")) sel.push(b.querySelector(".option-label").textContent); });
            answers[qi] = sel;
          } else {
            optBtns.forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            answers[qi] = [opt.label];
          }
        });
        optBtns.push(btn);
        optionsWrap.appendChild(btn);
      }
      section.appendChild(optionsWrap);

      // "Other" free-text input
      const otherWrap = document.createElement("div");
      otherWrap.className = "interactive-other";
      const otherInput = document.createElement("input");
      otherInput.type = "text";
      otherInput.placeholder = "Other...";
      otherInput.className = "interactive-other-input";
      otherInput.addEventListener("input", () => {
        if (otherInput.value.trim()) {
          optBtns.forEach(b => b.classList.remove("selected"));
          answers[qi] = [];
        }
      });
      otherWrap.appendChild(otherInput);
      section.appendChild(otherWrap);

      card.appendChild(section);
    });

    // Submit button
    const submitWrap = document.createElement("div");
    submitWrap.className = "question-submit-wrap";
    const submitBtn = document.createElement("button");
    submitBtn.className = "question-submit-btn";
    submitBtn.textContent = "Confirm";
    submitBtn.addEventListener("click", () => {
      // Collect answers as { "question text": "selected answer" } for the hook
      const answersObj = {};
      let hasAnswer = false;
      questions.forEach((q, qi) => {
        const otherIn = card.querySelectorAll(".question-section")[qi]?.querySelector(".interactive-other-input");
        const otherVal = otherIn?.value.trim();
        let answer;
        if (otherVal) {
          answer = otherVal;
        } else if (answers[qi].length > 0) {
          answer = answers[qi].join(", ");
        } else {
          return; // skip unanswered
        }
        answersObj[q.question || ("Q" + (qi + 1))] = answer;
        hasAnswer = true;
      });
      if (!hasAnswer) return;

      card.classList.add("submitted");
      submitBtn.disabled = true;
      card.querySelectorAll(".interactive-option-btn").forEach(b => b.disabled = true);
      card.querySelectorAll(".interactive-other-input").forEach(i => i.disabled = true);
      wsSend({ action: "hook_response", toolUseId: evt.toolUseId, answers: answersObj });
    });
    submitWrap.appendChild(submitBtn);
    card.appendChild(submitWrap);

    messagesInner.appendChild(card);
  }

  function renderPlanApproval(evt) {
    if (inThinkingBlock) finalizeThinkingBlock();

    const card = document.createElement("div");
    card.className = "interactive-card plan-approval-card";

    const tag = document.createElement("span");
    tag.className = "interactive-tag";
    tag.textContent = "Plan";
    card.appendChild(tag);

    if (evt.plan) {
      const planBody = document.createElement("div");
      planBody.className = "plan-body md-content";
      planBody.innerHTML = marked.parse(evt.plan);
      card.appendChild(planBody);
    }

    const actions = document.createElement("div");
    actions.className = "plan-actions";

    const approveBtn = document.createElement("button");
    approveBtn.className = "plan-btn approve";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      approveBtn.classList.add("selected");
      feedbackWrap.style.display = "none";
      wsSend({ action: "hook_response", toolUseId: evt.toolUseId, decision: "allow" });
    });

    const rejectBtn = document.createElement("button");
    rejectBtn.className = "plan-btn reject";
    rejectBtn.textContent = "Reject";
    rejectBtn.addEventListener("click", () => {
      feedbackWrap.style.display = feedbackWrap.style.display === "none" ? "flex" : "none";
    });

    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    card.appendChild(actions);

    // Feedback input for rejection
    const feedbackWrap = document.createElement("div");
    feedbackWrap.className = "interactive-other";
    feedbackWrap.style.display = "none";
    const feedbackInput = document.createElement("input");
    feedbackInput.type = "text";
    feedbackInput.placeholder = "Feedback (what to change)...";
    feedbackInput.className = "interactive-other-input";
    const feedbackBtn = document.createElement("button");
    feedbackBtn.className = "interactive-other-send";
    feedbackBtn.textContent = "Send";
    feedbackBtn.addEventListener("click", () => {
      const val = feedbackInput.value.trim();
      if (!val) return;
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      rejectBtn.classList.add("selected");
      feedbackInput.disabled = true;
      feedbackBtn.disabled = true;
      wsSend({ action: "hook_response", toolUseId: evt.toolUseId, decision: "deny", reason: val });
    });
    feedbackInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); feedbackBtn.click(); }
    });
    feedbackWrap.appendChild(feedbackInput);
    feedbackWrap.appendChild(feedbackBtn);
    card.appendChild(feedbackWrap);

    messagesInner.appendChild(card);
  }

  function esc(s) {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  // ---- Session Labels ----
  const LABEL_PRESET_COLORS = ['#ef4444','#f59e0b','#eab308','#10b981','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];

  async function loadSessionLabels() {
    try {
      const res = await fetch('/api/session-labels');
      const data = await res.json();
      sessionLabels = data.labels || [];
    } catch {}
  }

  async function loadUiSettings() {
    try {
      const res = await fetch('/api/ui-settings');
      const data = await res.json();
      if (data.folderOrder) {
        folderOrderList = data.folderOrder;
        localStorage.setItem("folderOrder", JSON.stringify(folderOrderList));
      }
      if (data.collapsedFolders) {
        collapsedFolders = data.collapsedFolders;
        localStorage.setItem("collapsedFolders", JSON.stringify(collapsedFolders));
      }
    } catch {}
  }

  function getLabelById(id) {
    return sessionLabels.find(l => l.id === id) || null;
  }

  function closeLabelPopover() {
    const existing = document.querySelector('.label-popover');
    if (existing) existing.remove();
  }

  function showLabelPopover(logoEl, session) {
    closeLabelPopover();
    const popover = document.createElement('div');
    popover.className = 'label-popover';

    const currentLabel = session.label || null;

    // Render label options
    for (const label of sessionLabels) {
      const opt = document.createElement('div');
      opt.className = 'label-option' + (currentLabel === label.id ? ' active' : '');
      opt.innerHTML = `<span class="label-color-dot" style="background:${label.color}"></span>${esc(label.name)}`;
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        wsSend({ action: 'set-label', sessionId: session.id, label: label.id });
        // Optimistic update
        const s = sessions.find(x => x.id === session.id);
        if (s) s.label = label.id;
        closeLabelPopover();
        renderSessionList();
      });
      popover.appendChild(opt);
    }

    // Clear option (if has label)
    if (currentLabel) {
      const sep = document.createElement('div');
      sep.className = 'label-separator';
      popover.appendChild(sep);

      const clearOpt = document.createElement('div');
      clearOpt.className = 'label-option';
      clearOpt.innerHTML = `<span class="label-color-dot" style="background:var(--text-muted)"></span>Clear label`;
      clearOpt.addEventListener('click', (e) => {
        e.stopPropagation();
        wsSend({ action: 'set-label', sessionId: session.id, label: null });
        const s = sessions.find(x => x.id === session.id);
        if (s) delete s.label;
        closeLabelPopover();
        renderSessionList();
      });
      popover.appendChild(clearOpt);
    }

    // Separator + Add new label
    const sep2 = document.createElement('div');
    sep2.className = 'label-separator';
    popover.appendChild(sep2);

    const addBtn = document.createElement('div');
    addBtn.className = 'label-option';
    addBtn.textContent = '＋ Add new label';
    let formVisible = false;
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (formVisible) return;
      formVisible = true;
      addBtn.style.display = 'none';
      const form = document.createElement('div');
      form.className = 'label-add-form';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Label name';
      form.appendChild(nameInput);

      const colorPicker = document.createElement('div');
      colorPicker.className = 'color-picker-dots';
      let selectedColor = LABEL_PRESET_COLORS[0];
      for (const c of LABEL_PRESET_COLORS) {
        const dot = document.createElement('span');
        dot.className = 'color-picker-dot' + (c === selectedColor ? ' selected' : '');
        dot.style.background = c;
        dot.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selectedColor = c;
          colorPicker.querySelectorAll('.color-picker-dot').forEach(d => d.classList.remove('selected'));
          dot.classList.add('selected');
        });
        colorPicker.appendChild(dot);
      }
      form.appendChild(colorPicker);

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'label-add-confirm';
      confirmBtn.textContent = 'Add';
      confirmBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const name = nameInput.value.trim();
        if (!name) return;
        try {
          const res = await fetch('/api/session-labels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color: selectedColor }),
          });
          const data = await res.json();
          if (data.label) {
            sessionLabels.push(data.label);
            // Also apply it to this session
            wsSend({ action: 'set-label', sessionId: session.id, label: data.label.id });
            const s = sessions.find(x => x.id === session.id);
            if (s) s.label = data.label.id;
          }
        } catch {}
        closeLabelPopover();
        renderSessionList();
      });
      form.appendChild(confirmBtn);
      popover.appendChild(form);
      nameInput.focus();
    });
    popover.appendChild(addBtn);

    // Position popover next to logo
    document.body.appendChild(popover);
    const rect = logoEl.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.left = (rect.right + 4) + 'px';
    popover.style.top = rect.top + 'px';
    // Keep within viewport
    requestAnimationFrame(() => {
      const pr = popover.getBoundingClientRect();
      if (pr.bottom > window.innerHeight) {
        popover.style.top = Math.max(4, window.innerHeight - pr.height - 4) + 'px';
      }
      if (pr.right > window.innerWidth) {
        popover.style.left = (rect.left - pr.width - 4) + 'px';
      }
    });

    // Close on click outside
    const closeHandler = (e) => {
      if (!popover.contains(e.target)) {
        closeLabelPopover();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  // ---- Session list ----
  // Persisted folder order for drag-to-reorder
  let folderOrderList = JSON.parse(localStorage.getItem("folderOrder") || "[]");

  function saveFolderOrder(order) {
    folderOrderList = order;
    localStorage.setItem("folderOrder", JSON.stringify(order));
    fetch('/api/ui-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folderOrder: order }) }).catch(() => {});
  }

  function rebuildKnownFolders() {
    knownFolders = new Set();
    for (const s of sessions) knownFolders.add(s.folder || "?");
    for (const s of archivedSessions) knownFolders.add(s.folder || "?");
  }

  // Shared rendering logic for both sessions and workflow sessions.
  // opts.allowAdd — show the "+" button to create a new session in the folder
  // opts.allowDrag — enable drag-to-reorder folders
  function renderSessionItems(sessArr, containerEl, opts = {}) {
    const { allowAdd = false, allowDrag = false } = opts;
    containerEl.innerHTML = "";

    const groups = new Map();
    for (const s of sessArr) {
      const folder = s.folder || "?";
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(s);
    }
    // Keep folders visible even when all their sessions are archived
    for (const folder of knownFolders) {
      if (!groups.has(folder)) groups.set(folder, []);
    }

    let sortedFolders;
    if (allowDrag) {
      // Stable folder ordering: manual order first, then by earliest created time
      sortedFolders = [...groups.keys()].sort((a, b) => {
        const idxA = folderOrderList.indexOf(a);
        const idxB = folderOrderList.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        const earliestA = groups.get(a).reduce((min, s) => s.created && s.created < min ? s.created : min, "z");
        const earliestB = groups.get(b).reduce((min, s) => s.created && s.created < min ? s.created : min, "z");
        return earliestA.localeCompare(earliestB);
      });
      // Sync folderOrder to include all current folders (add new ones at end)
      const currentOrder = [...folderOrderList.filter(f => groups.has(f))];
      for (const f of sortedFolders) {
        if (!currentOrder.includes(f)) currentOrder.push(f);
      }
      if (JSON.stringify(currentOrder) !== JSON.stringify(folderOrderList)) {
        saveFolderOrder(currentOrder);
      }
    } else {
      // Simple sort by earliest created time
      sortedFolders = [...groups.keys()].sort((a, b) => {
        const ea = groups.get(a).reduce((min, s) => s.created && s.created < min ? s.created : min, "z");
        const eb = groups.get(b).reduce((min, s) => s.created && s.created < min ? s.created : min, "z");
        return ea.localeCompare(eb);
      });
    }

    for (const folder of sortedFolders) {
      const folderSessions = groups.get(folder);
      const group = document.createElement("div");
      group.className = "folder-group";
      group.dataset.folder = folder;

      const shortFolder = folder.replace(/^\/Users\/[^/]+/, "~");
      const folderName = shortFolder.split("/").pop() || shortFolder;

      const header = document.createElement("div");
      header.className =
        "folder-group-header" + (collapsedFolders[folder] ? " collapsed" : "");
      const runningCount = folderSessions.filter(s => s.status === "running").length;
      const runningBadge = runningCount > 0
        ? `<span class="folder-running-badge"><svg width="12" height="12" viewBox="0 0 100 100" fill="none"><g stroke="currentColor" stroke-width="6" fill="none"><circle cx="50" cy="28" r="19"/><circle cx="72" cy="50" r="19"/><circle cx="50" cy="72" r="19"/><circle cx="28" cy="50" r="19"/></g><circle cx="50" cy="50" r="5" fill="currentColor"/></svg>${runningCount}</span>`
        : "";
      header.innerHTML = `${allowDrag ? `<span class="folder-drag-handle" title="Drag to reorder">⠿</span>` : ""}
        <span class="folder-chevron">&#9660;</span>
        <span class="folder-name" title="${esc(shortFolder)}">${esc(folderName)}</span>
        <span class="folder-count">${folderSessions.length}</span>${runningBadge}
        ${allowAdd ? `<button class="folder-add-btn" title="New session">+</button>` : ""}`;
      header.addEventListener("click", (e) => {
        if (allowAdd && e.target.classList.contains("folder-add-btn")) return;
        if (allowDrag && e.target.classList.contains("folder-drag-handle")) return;
        header.classList.toggle("collapsed");
        collapsedFolders[folder] = header.classList.contains("collapsed");
        localStorage.setItem("collapsedFolders", JSON.stringify(collapsedFolders));
        fetch('/api/ui-settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collapsedFolders }) }).catch(() => {});
      });
      if (allowAdd) {
        header.querySelector(".folder-add-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          if (!isDesktop) closeSidebarFn();
          const tool = selectedTool || (toolsList.length > 0 ? toolsList[0].id : "claude");
          wsSend({ action: "create", folder, tool, name: "" });
          const handler = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === "session" && msg.session) {
              ws.removeEventListener("message", handler);
              attachSession(msg.session.id, msg.session);
              wsSend({ action: "list" });
            }
          };
          ws.addEventListener("message", handler);
        });
      }

      const items = document.createElement("div");
      items.className = "folder-group-items";

      for (const s of folderSessions) {
        const div = document.createElement("div");
        div.className =
          "session-item" + (s.id === currentSessionId ? " active" : "");

        const displayName = s.name || s.tool || "session";
        const label = s.label ? getLabelById(s.label) : null;
        let metaHtml;
        if (s.status === "running") {
          metaHtml = `<span class="status-running">● running</span>`;
        } else if (label) {
          metaHtml = `<span style="color:${label.color}">● ${esc(label.name)}</span>`;
        } else if (s.tool && s.name) {
          metaHtml = `<span>${esc(s.tool)}</span>`;
        } else {
          metaHtml = "";
        }

        const logoRunning = s.status === "running" ? " running" : "";
        const logoColor = (s.status !== "running" && label) ? ` style="color:${label.color}"` : "";
        div.innerHTML = `
          <div class="session-item-logo${logoRunning}"${logoColor} title="Set label">
            <svg width="16" height="16" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g stroke="currentColor" stroke-width="6" fill="none">
                <circle cx="50" cy="28" r="19"/>
                <circle cx="72" cy="50" r="19"/>
                <circle cx="50" cy="72" r="19"/>
                <circle cx="28" cy="50" r="19"/>
              </g>
              <circle cx="50" cy="50" r="5" fill="currentColor"/>
            </svg>
          </div>
          <div class="session-item-info">
            <div class="session-item-name">${esc(displayName)}</div>
            <div class="session-item-meta">${metaHtml}</div>
          </div>
          <div class="session-item-actions">
            <button class="session-action-btn rename" title="Rename" data-id="${s.id}">&#9998;</button>
            <button class="session-action-btn archive" title="Archive" data-id="${s.id}">&#8863;</button>
            <button class="session-action-btn del" title="Delete" data-id="${s.id}">&times;</button>
            <button class="session-menu-btn" title="More" data-id="${s.id}">&#8942;</button>
          </div>`;

        // Logo click → label popover (stop propagation to prevent session switch)
        const logoEl = div.querySelector('.session-item-logo');
        logoEl.addEventListener('click', (e) => {
          e.stopPropagation();
          showLabelPopover(logoEl, s);
        });

        div.addEventListener("click", (e) => {
          if (
            e.target.classList.contains("rename") ||
            e.target.classList.contains("archive") ||
            e.target.classList.contains("del") ||
            e.target.classList.contains("session-menu-btn") ||
            e.target.closest(".session-item-logo")
          )
            return;
          attachSession(s.id, s);
          if (!isDesktop) closeSidebarFn();
        });

        div.querySelector(".rename").addEventListener("click", (e) => {
          e.stopPropagation();
          startRename(div, s);
        });

        div.querySelector(".archive").addEventListener("click", (e) => {
          e.stopPropagation();
          wsSend({ action: "archive", sessionId: s.id, archived: true });
        });

        div.querySelector(".del").addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm("Delete this session?")) {
            wsSend({ action: "delete", sessionId: s.id });
          }
        });

        div.querySelector(".session-menu-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          showSessionDropdown(e.currentTarget, s, div);
        });

        items.appendChild(div);
      }

      if (allowDrag) {
        // Drag-to-reorder: desktop (HTML5 drag) + mobile (touch)
        header.querySelector(".folder-drag-handle").addEventListener("mousedown", () => {
          group.draggable = true;
        });
        group.addEventListener("dragend", () => {
          group.classList.remove("dragging");
          group.draggable = false;
        });
        group.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", folder);
          group.classList.add("dragging");
        });
        group.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const dragging = containerEl.querySelector(".folder-group.dragging");
          if (dragging && dragging !== group) {
            const rect = group.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (e.clientY < midY) {
              containerEl.insertBefore(dragging, group);
            } else {
              containerEl.insertBefore(dragging, group.nextSibling);
            }
          }
        });
        group.addEventListener("drop", (e) => {
          e.preventDefault();
          const newOrder = [...containerEl.querySelectorAll(".folder-group")].map(g => g.dataset.folder);
          saveFolderOrder(newOrder);
        });

        // Touch drag for mobile
        const handle = header.querySelector(".folder-drag-handle");
        let touchDragState = null;
        handle.addEventListener("touchstart", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const touch = e.touches[0];
          touchDragState = { startY: touch.clientY, el: group, placeholder: null };
          group.classList.add("dragging");
          const ph = document.createElement("div");
          ph.className = "folder-drag-placeholder";
          ph.style.height = group.offsetHeight + "px";
          group.parentNode.insertBefore(ph, group);
          touchDragState.placeholder = ph;
          group.style.position = "fixed";
          group.style.zIndex = "1000";
          group.style.width = group.offsetWidth + "px";
          group.style.left = group.getBoundingClientRect().left + "px";
          group.style.top = touch.clientY - group.offsetHeight / 2 + "px";
          group.style.pointerEvents = "none";
        }, { passive: false });

        handle.addEventListener("touchmove", (e) => {
          if (!touchDragState) return;
          e.preventDefault();
          const touch = e.touches[0];
          const group = touchDragState.el;
          group.style.top = touch.clientY - group.offsetHeight / 2 + "px";
          const groups = [...containerEl.querySelectorAll(".folder-group:not(.dragging)")];
          for (const g of groups) {
            const rect = g.getBoundingClientRect();
            if (touch.clientY < rect.top + rect.height / 2) {
              containerEl.insertBefore(touchDragState.placeholder, g);
              return;
            }
          }
          containerEl.appendChild(touchDragState.placeholder);
        }, { passive: false });

        handle.addEventListener("touchend", () => {
          if (!touchDragState) return;
          const group = touchDragState.el;
          group.classList.remove("dragging");
          group.style.position = "";
          group.style.zIndex = "";
          group.style.width = "";
          group.style.left = "";
          group.style.top = "";
          group.style.pointerEvents = "";
          if (touchDragState.placeholder.parentNode) {
            touchDragState.placeholder.parentNode.insertBefore(group, touchDragState.placeholder);
            touchDragState.placeholder.remove();
          }
          touchDragState = null;
          const newOrder = [...containerEl.querySelectorAll(".folder-group")].map(g => g.dataset.folder);
          saveFolderOrder(newOrder);
        });
      }

      group.appendChild(header);
      group.appendChild(items);
      containerEl.appendChild(group);
    }
    if (allowDrag) updateFloatingLogo();
  }

  function renderSessionList() {
    renderSessionItems(sessions, sessionList, { allowAdd: true, allowDrag: true });
    renderArchivedSection();
  }

  function renderArchivedSection() {
    // Remove old archived section if any
    const old = sessionList.querySelector(".archived-section");
    if (old) old.remove();

    if (archivedSessions.length === 0) return;

    const section = document.createElement("div");
    section.className = "archived-section";

    const toggle = document.createElement("div");
    toggle.className = "archived-section-toggle";
    toggle.innerHTML = `<span class="archived-chevron">${showArchived ? "&#9660;" : "&#9654;"}</span> ${archivedSessions.length} archived`;
    toggle.addEventListener("click", () => {
      showArchived = !showArchived;
      renderArchivedSection();
    });
    section.appendChild(toggle);

    if (showArchived) {
      const container = document.createElement("div");
      container.className = "archived-items";
      for (const s of archivedSessions) {
        const div = document.createElement("div");
        div.className = "session-item archived" + (s.id === currentSessionId ? " active" : "");
        const displayName = s.name || s.tool || "session";
        div.innerHTML = `
          <div class="session-item-logo">
            <svg width="16" height="16" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g stroke="currentColor" stroke-width="6" fill="none">
                <circle cx="50" cy="28" r="19"/>
                <circle cx="72" cy="50" r="19"/>
                <circle cx="50" cy="72" r="19"/>
                <circle cx="28" cy="50" r="19"/>
              </g>
              <circle cx="50" cy="50" r="5" fill="currentColor"/>
            </svg>
          </div>
          <div class="session-item-info">
            <div class="session-item-name">${esc(displayName)}</div>
            <div class="session-item-meta"><span>${esc(s.tool || "")}</span></div>
          </div>
          <div class="session-item-actions">
            <button class="session-action-btn unarchive" title="Unarchive" data-id="${s.id}">&#8862;</button>
            <button class="session-action-btn del" title="Delete" data-id="${s.id}">&times;</button>
            <button class="session-menu-btn" title="More" data-id="${s.id}">&#8942;</button>
          </div>`;

        div.addEventListener("click", (e) => {
          if (e.target.classList.contains("unarchive") || e.target.classList.contains("del") || e.target.classList.contains("session-menu-btn")) return;
          attachSession(s.id, s);
          if (!isDesktop) closeSidebarFn();
        });
        div.querySelector(".unarchive").addEventListener("click", (e) => {
          e.stopPropagation();
          wsSend({ action: "archive", sessionId: s.id, archived: false });
        });
        div.querySelector(".del").addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm("Delete this session?")) {
            wsSend({ action: "delete", sessionId: s.id });
          }
        });
        div.querySelector(".session-menu-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          showArchivedDropdown(e.currentTarget, s);
        });
        container.appendChild(div);
      }
      section.appendChild(container);
    }

    sessionList.appendChild(section);
  }

  // ---- Task panel (schedules in sidebar tab) ----

  function formatCron(cron) {
    if (!cron) return "Manual only";
    const parts = cron.split(/\s+/);
    if (parts.length < 5) return cron;
    const [min, hour, dom, mon, dow] = parts;
    const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dom === "*" && mon === "*" && dow === "*") return `Daily at ${time} (UTC)`;
    if (dom === "*" && mon === "*" && dow !== "*") {
      const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const dayLabel = /^\d$/.test(dow) ? (days[+dow] || dow) : dow;
      return `${dayLabel} at ${time} (UTC)`;
    }
    return `${time} (UTC) ${cron}`;
  }

  // Compute the next UTC trigger time for a cron expression (daily/weekly subset).
  // Mirrors scheduler.mjs msUntilNextCron but works in the browser using UTC methods.
  function nextCronUTC(cron) {
    if (!cron) return null;
    const parts = cron.split(/\s+/);
    if (parts.length < 5) return null;
    const [min, hour, , , dow] = parts;
    const minute = parseInt(min, 10);
    const hourVal = parseInt(hour, 10);
    const now = new Date();
    const next = new Date();
    next.setUTCHours(hourVal, minute, 0, 0);
    if (dow !== "*") {
      const targetDay = parseInt(dow, 10);
      const currentDay = now.getUTCDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead < 0) daysAhead += 7;
      if (daysAhead === 0 && next <= now) daysAhead = 7;
      next.setUTCDate(next.getUTCDate() + daysAhead);
    } else {
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  // Format milliseconds remaining as "Xh Ym" or "Ym" or "< 1m"
  function formatCountdown(ms) {
    if (ms <= 0) return "now";
    const totalMin = Math.ceil(ms / 60_000);
    if (totalMin < 1) return "< 1m";
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatRunAt(runAt) {
    if (!runAt) return null;
    const diff = new Date(runAt).getTime() - Date.now();
    if (diff <= 0) return "past due";
    if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)} min`;
    if (diff < 86_400_000) return `in ${Math.floor(diff / 3_600_000)}h ${Math.ceil((diff % 3_600_000) / 60_000)}m`;
    return new Date(runAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatInterval(ms) {
    if (!ms) return null;
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 60) return `Every ${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `Every ${h}h ${m}m` : `Every ${h}h`;
  }

  async function loadTaskSection() {
    try {
      const schedRes = await fetch("/api/schedules");
      const { schedules = [] } = await schedRes.json();

      taskPanel.innerHTML = "";

      if (schedules.length === 0) {
        taskPanel.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--text-muted);text-align:center">No tasks configured</div>';
        return;
      }

      // Panel header with refresh
      const hdr = document.createElement("div");
      hdr.className = "task-panel-header";
      hdr.innerHTML = `
        <span class="task-panel-label">Schedules</span>
        <button class="task-panel-refresh" title="Refresh">↻</button>
      `;
      hdr.querySelector(".task-panel-refresh").addEventListener("click", (e) => { e.stopPropagation(); loadTaskSection(); });
      taskPanel.appendChild(hdr);

      for (const sched of schedules) {
        let enabled = sched.enabled !== false;

        // Build summary line: cron or runAt or "Manual only"
        let summaryText = formatCron(sched.cron);
        const runAtLabel = formatRunAt(sched.runAt);
        if (runAtLabel) summaryText = runAtLabel;
        if (sched.intervalMs) summaryText = formatInterval(sched.intervalMs);

        const item = document.createElement("div");
        item.className = "task-item" + (enabled ? "" : " disabled") + (sched.id === currentTaskDetailId ? " active" : "");

        const disposableBadge = sched.disposable ? ' <span title="Disposable">\u{1F5D1}\uFE0F</span>' : "";

        // Header row: name + badge, toggle, run
        const headerRow = document.createElement("div");
        headerRow.className = "task-item-header";
        headerRow.innerHTML = `
          <span class="task-item-name">${escapeHtml(sched.id)}${disposableBadge}</span>
          <label class="task-item-toggle" title="${enabled ? "Enabled" : "Disabled"}">
            <input type="checkbox" ${enabled ? "checked" : ""}>
            <span class="toggle-track"></span>
            <span class="toggle-thumb"></span>
          </label>
          <button class="task-item-trigger">Run</button>
        `;

        // Summary line below header
        const summaryRow = document.createElement("div");
        summaryRow.className = "task-item-summary";
        summaryRow.textContent = summaryText;

        const triggerBtn = headerRow.querySelector(".task-item-trigger");
        const toggleInput = headerRow.querySelector(".task-item-toggle input");

        // Toggle enable/disable (stop propagation so card click doesn't fire)
        // Must stop on the <label> itself, not just <input>, because clicking
        // toggle-track/toggle-thumb hits the label first and would bubble to item
        headerRow.querySelector(".task-item-toggle").addEventListener("click", (e) => e.stopPropagation());
        toggleInput.addEventListener("change", async () => {
          const newEnabled = toggleInput.checked;
          enabled = newEnabled;
          item.classList.toggle("disabled", !newEnabled);
          headerRow.querySelector(".task-item-toggle").title = newEnabled ? "Enabled" : "Disabled";
          try {
            const res = await fetch("/api/schedules/" + encodeURIComponent(sched.id), {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: newEnabled }),
            });
            if (!res.ok) throw new Error("PATCH failed");
          } catch (err) {
            console.error("Failed to toggle schedule:", err);
            enabled = !newEnabled;
            toggleInput.checked = !newEnabled;
            item.classList.toggle("disabled", newEnabled);
            headerRow.querySelector(".task-item-toggle").title = !newEnabled ? "Enabled" : "Disabled";
          }
        });

        // Trigger button
        triggerBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          triggerBtn.disabled = true;
          triggerBtn.textContent = "…";
          try {
            const res = await fetch("/api/schedules/" + encodeURIComponent(sched.id) + "/trigger", { method: "POST" });
            triggerBtn.textContent = res.ok ? "OK" : "Err";
          } catch { triggerBtn.textContent = "Err"; }
          setTimeout(() => { triggerBtn.textContent = "Run"; triggerBtn.disabled = false; }, 2000);
        });

        // Click card → show task detail in main content area
        item.addEventListener("click", () => {
          openTaskDetail(sched.id);
          if (!isDesktop) closeSidebarFn();
        });

        item.appendChild(headerRow);
        item.appendChild(summaryRow);
        taskPanel.appendChild(item);
      }
    } catch (err) {
      console.warn("Failed to load task panel:", err);
    }
  }

  // ---- Task detail (main content area) ----
  function showTaskDetailView() {
    // Switch main content to show task detail (same pattern as workflowView)
    currentSessionId = null;
    messagesEl.style.display = "none";
    document.getElementById("inputArea").style.display = "none";
    workflowView.style.display = "";
    resetHeaderContext();
    renderSessionList();
  }

  async function openTaskDetail(scheduleId) {
    // Clear any previous countdown/poll intervals before opening a new detail panel
    if (taskDetailCountdownInterval) {
      clearInterval(taskDetailCountdownInterval);
      taskDetailCountdownInterval = null;
    }
    if (activeRunPollInterval) {
      clearInterval(activeRunPollInterval);
      activeRunPollInterval = null;
    }
    currentTaskDetailId = scheduleId;
    showTaskDetailView();
    headerTitle.textContent = scheduleId;
    workflowView.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Loading…</div>';

    try {
      const [schedulesRes, runsRes] = await Promise.all([
        fetch("/api/schedules"),
        fetch("/api/workflow-runs"),
      ]);
      const { schedules = [] } = await schedulesRes.json();
      const { runs = [] } = await runsRes.json();

      const sched = schedules.find(s => s.id === scheduleId);
      if (!sched) {
        workflowView.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Task not found.</div>';
        return;
      }

      let enabled = sched.enabled !== false;
      workflowView.innerHTML = "";

      const container = document.createElement("div");
      container.className = "tdp-container";

      // ── Header ──
      const header = document.createElement("div");
      header.className = "tdp-header";
      header.innerHTML = `
        <span class="tdp-title">${escapeHtml(sched.id)}</span>
        <span class="tdp-status-badge ${enabled ? "enabled" : "disabled"}">${enabled ? "Enabled" : "Disabled"}</span>
      `;
      container.appendChild(header);

      // ── Body ──
      const body = document.createElement("div");
      body.className = "tdp-body";

      // ── Basic Info ──
      const infoSection = document.createElement("div");
      infoSection.className = "tdp-section";
      const cronLabel = sched.intervalMs ? formatInterval(sched.intervalMs) : formatCron(sched.cron);
      const runAtLabel = formatRunAt(sched.runAt);
      const runCountDisplay = sched.maxRuns != null
        ? `${sched.runCount || 0} / ${sched.maxRuns}`
        : `${sched.runCount || 0} / \u221E`;

      // Compute next run info for cron schedules
      let nextRunDate = nextCronUTC(sched.cron);
      if (!nextRunDate && sched.intervalMs) {
        const base = sched.lastRun ? new Date(sched.lastRun).getTime() : Date.now();
        nextRunDate = new Date(base + sched.intervalMs);
      }
      const nextRunLocalStr = nextRunDate
        ? nextRunDate.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : null;

      infoSection.innerHTML = `
        <div class="tdp-section-title">Basic Info</div>
        <div class="tdp-info-grid">
          <span class="tdp-info-label">Schedule</span>
          <span class="tdp-info-value">${escapeHtml(cronLabel)}</span>
          ${runAtLabel ? `<span class="tdp-info-label">Run At</span><span class="tdp-info-value">${escapeHtml(runAtLabel)}</span>` : ""}
          ${nextRunLocalStr ? `<span class="tdp-info-label">Next Run</span><span class="tdp-info-value">${escapeHtml(nextRunLocalStr)}</span>` : ""}
          ${nextRunDate ? `<span class="tdp-info-label">Countdown</span><span class="tdp-info-value tdp-countdown"></span>` : ""}
          <span class="tdp-info-label">Disposable</span>
          <span class="tdp-info-value">${sched.disposable ? "Yes" : "No"}</span>
          <span class="tdp-info-label">Runs</span>
          <span class="tdp-info-value">${escapeHtml(runCountDisplay)}</span>
        </div>
      `;
      body.appendChild(infoSection);

      // Countdown: update every minute
      if (nextRunDate) {
        const countdownEl = infoSection.querySelector(".tdp-countdown");
        const updateCountdown = () => {
          countdownEl.textContent = formatCountdown(nextRunDate.getTime() - Date.now());
        };
        updateCountdown();
        taskDetailCountdownInterval = setInterval(updateCountdown, 60_000);
      }

      // ── Actions (toggle + run) ──
      const actionsSection = document.createElement("div");
      actionsSection.className = "tdp-actions";
      actionsSection.innerHTML = `
        <label class="tdp-toggle" title="${enabled ? "Enabled" : "Disabled"}">
          <input type="checkbox" ${enabled ? "checked" : ""}>
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
        <span class="tdp-toggle-label">${enabled ? "Enabled" : "Disabled"}</span>
        <button class="tdp-run-btn">Run Now</button>
      `;

      const panelToggle = actionsSection.querySelector(".tdp-toggle input");
      const panelToggleLabel = actionsSection.querySelector(".tdp-toggle-label");
      const statusBadge = header.querySelector(".tdp-status-badge");
      const panelRunBtn = actionsSection.querySelector(".tdp-run-btn");

      panelToggle.addEventListener("change", async () => {
        const newEnabled = panelToggle.checked;
        enabled = newEnabled;
        panelToggleLabel.textContent = newEnabled ? "Enabled" : "Disabled";
        statusBadge.textContent = newEnabled ? "Enabled" : "Disabled";
        statusBadge.className = "tdp-status-badge " + (newEnabled ? "enabled" : "disabled");
        try {
          const res = await fetch("/api/schedules/" + encodeURIComponent(sched.id), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: newEnabled }),
          });
          if (!res.ok) throw new Error("PATCH failed");
          loadTaskSection();
        } catch (err) {
          console.error("Failed to toggle schedule:", err);
          enabled = !newEnabled;
          panelToggle.checked = !newEnabled;
          panelToggleLabel.textContent = !newEnabled ? "Enabled" : "Disabled";
          statusBadge.textContent = !newEnabled ? "Enabled" : "Disabled";
          statusBadge.className = "tdp-status-badge " + (!newEnabled ? "enabled" : "disabled");
        }
      });

      panelRunBtn.addEventListener("click", async () => {
        panelRunBtn.disabled = true;
        panelRunBtn.textContent = "Running…";
        try {
          const res = await fetch("/api/schedules/" + encodeURIComponent(sched.id) + "/trigger", { method: "POST" });
          const data = await res.json();
          if (res.ok && data.runId) {
            addLiveRunEntry(data.runId, runSection);
            pollRunStatus(data.runId, runSection);
          }
          panelRunBtn.textContent = res.ok ? "Triggered!" : "Error";
        } catch { panelRunBtn.textContent = "Error"; }
        setTimeout(() => { panelRunBtn.textContent = "Run Now"; panelRunBtn.disabled = false; }, 2500);
      });

      body.appendChild(actionsSection);

      // ── Workflow Detail ──
      if (sched.workflow) {
        const wfSection = document.createElement("div");
        wfSection.className = "tdp-section";
        wfSection.innerHTML = `<div class="tdp-section-title">Workflow Detail</div>
          <div style="font-size:11px;color:var(--text-muted)">Loading workflow…</div>`;
        body.appendChild(wfSection);
        loadWorkflowIntoPanel(sched.workflow, wfSection);
      }

      // ── Run History ──
      const schedRuns = runs.filter(r => {
        if (sched.workflow) return r.workflow === sched.workflow;
        return r.scheduleId === sched.id;
      });
      const runSection = document.createElement("div");
      runSection.className = "tdp-section";
      runSection.innerHTML = `<div class="tdp-section-title">Run History</div>`;
      if (schedRuns.length === 0) {
        runSection.innerHTML += '<div class="tdp-empty">No runs yet</div>';
      } else {
        const runList = document.createElement("div");
        runList.style.cssText = "display:flex;flex-direction:column;gap:4px";
        for (const run of schedRuns) {
          const entry = document.createElement("div");
          const startedAt = run.startedAt ? relativeTime(new Date(run.startedAt).getTime()) : "—";
          const status = run.status || "unknown";
          entry.innerHTML = `
            <div class="tdp-run-entry">
              <span class="tdp-run-id">${escapeHtml(run.runId.slice(0, 8))}</span>
              <span class="tdp-run-status ${escapeHtml(status)}">${escapeHtml(status)}</span>
              <span class="tdp-run-time">${escapeHtml(startedAt)}</span>
            </div>
            <div class="tdp-run-detail"></div>
          `;
          const detail = entry.querySelector(".tdp-run-detail");
          entry.querySelector(".tdp-run-entry").addEventListener("click", () => {
            const isOpen = detail.classList.contains("open");
            runList.querySelectorAll(".tdp-run-detail.open").forEach(el => el.classList.remove("open"));
            if (isOpen) return;
            detail.classList.add("open");
            if (!detail.dataset.loaded) {
              detail.dataset.loaded = "1";
              buildRunTasksHtml(run, detail);
            }
          });
          runList.appendChild(entry);
        }
        runSection.appendChild(runList);
      }
      body.appendChild(runSection);

      container.appendChild(body);
      workflowView.appendChild(container);
    } catch (err) {
      console.error("Failed to open task detail:", err);
      workflowView.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Failed to load task details.</div>';
    }
  }

  async function loadWorkflowIntoPanel(workflowName, container) {
    try {
      const res = await fetch("/api/workflows");
      if (!res.ok) throw new Error("Failed to fetch workflows");
      const { workflows = [] } = await res.json();
      const wf = workflows.find(w => w.id === workflowName || w.name === workflowName);
      if (!wf) {
        container.innerHTML = '<div class="tdp-section-title">Workflow Detail</div><div class="tdp-empty">Workflow definition not found</div>';
        return;
      }
      container.innerHTML = `<div class="tdp-section-title">Workflow: ${escapeHtml(wf.name || wf.id)}</div>`;
      const steps = wf.steps || [];
      if (steps.length === 0) {
        container.innerHTML += '<div class="tdp-empty">No steps defined</div>';
        return;
      }
      for (const step of steps) {
        const stepEl = document.createElement("div");
        stepEl.className = "tdp-step";
        const stepType = step.type || "sequential";
        stepEl.innerHTML = `<div class="tdp-step-header">${escapeHtml(step.id || "step")} <span style="font-weight:400;color:var(--text-muted);font-size:11px">(${escapeHtml(stepType)})</span></div>`;
        const tasks = step.tasks || [];
        for (const task of tasks) {
          const taskEl = document.createElement("div");
          taskEl.className = "tdp-task";
          const workspace = task.workspace || "—";
          const model = task.model || "—";
          const prompt = task.prompt || "";
          taskEl.innerHTML = `
            <div class="tdp-task-id">${escapeHtml(task.id || "task")}</div>
            <div class="tdp-task-meta">workspace: ${escapeHtml(workspace)} · model: ${escapeHtml(model)}</div>
            ${prompt ? `<div class="tdp-task-prompt">${escapeHtml(prompt)}</div>` : ""}
          `;
          stepEl.appendChild(taskEl);
        }
        container.appendChild(stepEl);
      }
    } catch (err) {
      console.error("Failed to load workflow detail:", err);
      container.innerHTML = '<div class="tdp-section-title">Workflow Detail</div><div class="tdp-empty">Failed to load</div>';
    }
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

    const rerender = renderSessionList;

    function commit() {
      const newName = input.value.trim();
      if (newName && newName !== current) {
        wsSend({ action: "rename", sessionId: session.id, name: newName });
      } else {
        rerender(); // revert
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
        rerender();
      }
    });
  }

  function showSessionDropdown(btn, session, itemEl) {
    const existing = document.querySelector(".session-dropdown");
    if (existing) {
      const wasSameBtn = existing._triggerBtn === btn;
      existing.remove();
      if (wasSameBtn) return;
    }

    const dropdown = document.createElement("div");
    dropdown.className = "session-dropdown";
    dropdown._triggerBtn = btn;
    const curLabel = session.label ? getLabelById(session.label) : null;
    const dotColor = curLabel ? curLabel.color : 'var(--text-muted)';
    dropdown.innerHTML = `
      <div class="session-dropdown-item rename-action">&#9998;&nbsp; Rename</div>
      <div class="session-dropdown-item label-action"><span class="session-dropdown-label-dot" style="background:${dotColor}"></span>&nbsp; Label</div>
      <div class="session-dropdown-item archive-action">&#8863;&nbsp; Archive</div>
      <div class="session-dropdown-item del-action del">&#215;&nbsp; Delete</div>`;
    document.body.appendChild(dropdown);

    // Position below button, right-aligned, clamped to viewport
    const btnRect = btn.getBoundingClientRect();
    const dRect = dropdown.getBoundingClientRect();
    let top = btnRect.bottom + 4;
    let left = btnRect.right - dRect.width;
    if (left < 4) left = 4;
    if (top + dRect.height > window.innerHeight - 8) top = btnRect.top - dRect.height - 4;
    dropdown.style.top = top + "px";
    dropdown.style.left = left + "px";

    dropdown.querySelector(".rename-action").addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.remove();
      startRename(itemEl, session);
    });

    dropdown.querySelector(".label-action").addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.remove();
      showLabelPopover(itemEl.querySelector(".session-item-logo"), session);
    });

    dropdown.querySelector(".archive-action").addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.remove();
      wsSend({ action: "archive", sessionId: session.id, archived: true });
    });

    dropdown.querySelector(".del-action").addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.remove();
      if (confirm("Delete this session?")) {
        wsSend({ action: "delete", sessionId: session.id });
      }
    });

    function onOutsideEvent(e) {
      if (!dropdown.isConnected) {
        document.removeEventListener("click", onOutsideEvent, true);
        document.removeEventListener("touchstart", onOutsideEvent, true);
        return;
      }
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.remove();
        document.removeEventListener("click", onOutsideEvent, true);
        document.removeEventListener("touchstart", onOutsideEvent, true);
      }
    }
    setTimeout(() => {
      document.addEventListener("click", onOutsideEvent, true);
      document.addEventListener("touchstart", onOutsideEvent, true);
    }, 0);
  }

  function showArchivedDropdown(btn, session) {
    const existing = document.querySelector(".session-dropdown");
    if (existing) {
      const wasSameBtn = existing._triggerBtn === btn;
      existing.remove();
      if (wasSameBtn) return;
    }
    const dropdown = document.createElement("div");
    dropdown.className = "session-dropdown";
    dropdown._triggerBtn = btn;
    dropdown.innerHTML = `
      <div class="session-dropdown-item unarchive-action">&#8862;&nbsp; Unarchive</div>
      <div class="session-dropdown-item del-action del">&#215;&nbsp; Delete</div>`;
    document.body.appendChild(dropdown);

    const btnRect = btn.getBoundingClientRect();
    const dRect = dropdown.getBoundingClientRect();
    let top = btnRect.bottom + 4;
    let left = btnRect.right - dRect.width;
    if (left < 4) left = 4;
    if (top + dRect.height > window.innerHeight - 8) top = btnRect.top - dRect.height - 4;
    dropdown.style.top = top + "px";
    dropdown.style.left = left + "px";

    dropdown.querySelector(".unarchive-action").addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.remove();
      wsSend({ action: "archive", sessionId: session.id, archived: false });
    });
    dropdown.querySelector(".del-action").addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.remove();
      if (confirm("Delete this session?")) {
        wsSend({ action: "delete", sessionId: session.id });
      }
    });

    function onOutsideEvent(e) {
      if (!dropdown.isConnected) {
        document.removeEventListener("click", onOutsideEvent, true);
        document.removeEventListener("touchstart", onOutsideEvent, true);
        return;
      }
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.remove();
        document.removeEventListener("click", onOutsideEvent, true);
        document.removeEventListener("touchstart", onOutsideEvent, true);
      }
    }
    setTimeout(() => {
      document.addEventListener("click", onOutsideEvent, true);
      document.addEventListener("touchstart", onOutsideEvent, true);
    }, 0);
  }

  function attachSession(id, session) {
    // Hide workflow/task-detail view and restore normal chat layout
    workflowView.style.display = "none";
    messagesEl.style.display = "";
    document.getElementById("inputArea").style.display = "";
    currentTaskDetailId = null;
    if (taskDetailCountdownInterval) {
      clearInterval(taskDetailCountdownInterval);
      taskDetailCountdownInterval = null;
    }
    if (activeRunPollInterval) {
      clearInterval(activeRunPollInterval);
      activeRunPollInterval = null;
    }

    currentSessionId = id;
    clearMessages();
    resetHeaderContext();
    // Show Clear button immediately once a session is active
    headerCtxClear.classList.add("visible");
    headerCtxClear.disabled = false;
    headerCtxClear.textContent = "Clear";
    headerTitle.style.flex = "0 0 auto";
    headerCtx.classList.add("visible");
    wsSend({ action: "attach", sessionId: id });

    const displayName =
      session?.name || session?.folder?.split("/").pop() || "Session";
    headerTitle.textContent = displayName;
    msgInput.disabled = false;
    sendBtn.disabled = false;
    imgBtn.disabled = false;
    fileAttachBtn.disabled = false;
    inlineToolSelect.disabled = false;
    inlineModelSelect.disabled = false;
    thinkingToggle.disabled = false;

    if (session?.tool && toolsList.some((t) => t.id === session.tool)) {
      inlineToolSelect.value = session.tool;
      selectedTool = session.tool;
      localStorage.setItem("selectedTool", selectedTool);
      loadInlineModels(selectedTool, session.model || null);
    }

    loadQuickReplies(session?.folder);
    msgInput.focus();
    renderSessionList();
  }

  // ---- Sidebar ----
  function openSidebar() {
    sidebarOverlay.classList.add("open");
  }
  function closeSidebarFn() {
    sidebarOverlay.classList.remove("open");
  }

  menuBtn.addEventListener("click", openSidebar);
  closeSidebar.addEventListener("click", closeSidebarFn);
  sidebarOverlay.addEventListener("click", (e) => {
    if (e.target === sidebarOverlay && !isDesktop) closeSidebarFn();
  });

  // ---- New Session Modal ----
  newSessionBtn.addEventListener("click", () => {
    if (!isDesktop) closeSidebarFn();
    newSessionModal.classList.add("open");
    loadTools();
    folderInput.value = "";
    folderSuggestions.innerHTML = "";
    folderInput.focus();
  });

  cancelModal.addEventListener("click", () =>
    newSessionModal.classList.remove("open"),
  );
  newSessionModal.addEventListener("click", (e) => {
    if (e.target === newSessionModal) newSessionModal.classList.remove("open");
  });

  folderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createSessionBtn.click(); }
  });

  createSessionBtn.addEventListener("click", () => {
    const folder = folderInput.value.trim();
    const tool = toolSelect.value;
    if (!folder) {
      folderInput.focus();
      return;
    }
    wsSend({ action: "create", folder, tool, name: "" });
    newSessionModal.classList.remove("open");

    const handler = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "session" && msg.session) {
        ws.removeEventListener("message", handler);
        attachSession(msg.session.id, msg.session);
        wsSend({ action: "list" });
      }
    };
    ws.addEventListener("message", handler);
  });

  async function loadTools() {
    try {
      const res = await fetch("/api/tools");
      const data = await res.json();
      toolSelect.innerHTML = "";
      for (const t of data.tools || []) {
        if (!t.available) continue;
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        toolSelect.appendChild(opt);
      }
    } catch {}
  }

  // Folder autocomplete
  let acTimer = null;
  folderInput.addEventListener("input", () => {
    clearTimeout(acTimer);
    acTimer = setTimeout(async () => {
      const q = folderInput.value.trim();
      if (q.length < 2) {
        folderSuggestions.innerHTML = "";
        return;
      }
      try {
        const res = await fetch(`/api/autocomplete?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        folderSuggestions.innerHTML = "";
        for (const s of (data.suggestions || []).slice(0, 5)) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = s.replace(/^\/Users\/[^/]+/, "~");
          btn.onclick = () => {
            folderInput.value = s;
            folderSuggestions.innerHTML = "";
          };
          folderSuggestions.appendChild(btn);
        }
      } catch {}
    }, 200);
  });

  // ---- Image handling ----
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(",")[1];
        resolve({
          data: base64,
          mimeType: file.type || "image/png",
          objectUrl: URL.createObjectURL(file),
        });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (pendingImages.length >= 4) break;
      pendingImages.push(await fileToBase64(file));
    }
    renderImagePreviews();
  }

  function renderImagePreviews() {
    imgPreviewStrip.innerHTML = "";
    if (pendingImages.length === 0 && pendingFiles.length === 0) {
      imgPreviewStrip.classList.remove("has-images");
      return;
    }
    imgPreviewStrip.classList.add("has-images");
    pendingImages.forEach((img, i) => {
      const item = document.createElement("div");
      item.className = "img-preview-item";
      const imgEl = document.createElement("img");
      imgEl.src = img.objectUrl;
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-img";
      removeBtn.innerHTML = "&times;";
      removeBtn.onclick = () => {
        URL.revokeObjectURL(img.objectUrl);
        pendingImages.splice(i, 1);
        renderImagePreviews();
      };
      item.appendChild(imgEl);
      item.appendChild(removeBtn);
      imgPreviewStrip.appendChild(item);
    });
    pendingFiles.forEach((pf, i) => {
      const item = document.createElement("div");
      item.className = "file-preview-item";
      const nameEl = document.createElement("span");
      nameEl.className = "file-preview-name";
      nameEl.textContent = pf.name;
      nameEl.title = pf.name;
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-img";
      removeBtn.innerHTML = "&times;";
      removeBtn.onclick = () => {
        pendingFiles.splice(i, 1);
        renderImagePreviews();
      };
      item.appendChild(nameEl);
      item.appendChild(removeBtn);
      imgPreviewStrip.appendChild(item);
    });
  }

  imgBtn.addEventListener("click", () => imgFileInput.click());
  imgFileInput.addEventListener("change", () => {
    if (imgFileInput.files.length > 0) addImageFiles(imgFileInput.files);
    imgFileInput.value = "";
  });

  // ---- File attachment (queued, uploaded on send) ----
  fileAttachBtn.addEventListener("click", () => fileAttachInput.click());
  fileAttachInput.addEventListener("change", () => {
    const files = Array.from(fileAttachInput.files);
    fileAttachInput.value = "";
    if (!files.length) return;
    for (const file of files) {
      pendingFiles.push({ file, name: file.name });
    }
    renderImagePreviews();
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

  // ---- Send message ----
  async function sendMessage() {
    const text = msgInput.value.trim();
    if ((!text && pendingImages.length === 0 && pendingFiles.length === 0) || !currentSessionId) return;

    let fullText = text;

    // Upload pending files before sending
    if (pendingFiles.length > 0) {
      const filesToUpload = [...pendingFiles];
      pendingFiles = [];
      renderImagePreviews();
      const paths = [];
      for (const pf of filesToUpload) {
        try {
          const res = await fetch(
            `/api/upload?name=${encodeURIComponent(pf.name)}&sessionId=${encodeURIComponent(currentSessionId)}`,
            { method: "POST", body: pf.file }
          );
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(`Upload failed: ${err.error || res.statusText}`);
            continue;
          }
          const data = await res.json();
          paths.push(data.path);
        } catch (e) {
          alert(`Upload failed: ${e.message}`);
        }
      }
      if (paths.length > 0) {
        const fileRefs = paths.map((p) => `📎 ${p}`).join("\n");
        fullText = [fullText, fileRefs].filter(Boolean).join("\n").trim();
      }
    }

    const msg = { action: "send", text: fullText || "(image)" };
    if (currentSessionId) sessionLastMessage[currentSessionId] = fullText || "(image)";
    if (selectedTool) msg.tool = selectedTool;
    msg.model = selectedModel;
    msg.thinking = thinkingEnabled;
    if (pendingImages.length > 0) {
      msg.images = pendingImages.map((img) => ({
        data: img.data,
        mimeType: img.mimeType,
      }));
      pendingImages.forEach((img) => URL.revokeObjectURL(img.objectUrl));
      pendingImages = [];
      renderImagePreviews();
    }
    wsSend(msg);
    msgInput.value = "";
    autoResizeInput();
  }

  cancelBtn.addEventListener("click", () => wsSend({ action: "cancel" }));

  // ---- Quick Replies (per-folder, persistent) ----
  let qrButtons = [];
  let qrFolder = null;
  let qrEditing = false;

  function renderQuickReplies() {
    quickReplies.innerHTML = "";
    quickReplies.classList.toggle("editing", qrEditing);
    for (const text of qrButtons) {
      const btn = document.createElement("button");
      btn.className = "qr-btn";
      btn.dataset.text = text;
      btn.textContent = text;
      if (qrEditing) {
        const del = document.createElement("span");
        del.className = "qr-del";
        del.textContent = "\u00d7";
        btn.appendChild(del);
      }
      quickReplies.appendChild(btn);
    }
    if (qrEditing) {
      const addBtn = document.createElement("button");
      addBtn.className = "qr-add";
      addBtn.textContent = "＋";
      addBtn.addEventListener("click", () => {
        const text = prompt("Button text:");
        if (text && text.trim()) {
          qrButtons.push(text.trim());
          saveQuickReplies();
          renderQuickReplies();
        }
      });
      quickReplies.appendChild(addBtn);
    }
    const editBtn = document.createElement("button");
    editBtn.className = "qr-edit-toggle";
    editBtn.textContent = qrEditing ? "✓" : "\u270e";
    editBtn.title = qrEditing ? "Finish editing" : "Edit shortcuts";
    editBtn.addEventListener("click", () => {
      qrEditing = !qrEditing;
      renderQuickReplies();
    });
    quickReplies.appendChild(editBtn);
  }

  async function loadQuickReplies(folder) {
    if (!folder) return;
    qrFolder = folder;
    try {
      const res = await fetch("/api/quick-replies?folder=" + encodeURIComponent(folder));
      const data = await res.json();
      qrButtons = data.buttons || [];
    } catch {
      qrButtons = ["Continue", "Agree", "Commit this", "Restart", "Update your memory"];
    }
    qrEditing = false;
    renderQuickReplies();
  }

  async function saveQuickReplies() {
    if (!qrFolder) return;
    try {
      await fetch("/api/quick-replies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder: qrFolder, buttons: qrButtons }),
      });
    } catch {}
  }

  quickReplies.addEventListener("click", (e) => {
    const del = e.target.closest(".qr-del");
    if (del && qrEditing) {
      const btn = del.closest(".qr-btn");
      const idx = qrButtons.indexOf(btn.dataset.text);
      if (idx >= 0) {
        qrButtons.splice(idx, 1);
        saveQuickReplies();
        renderQuickReplies();
      }
      return;
    }
    const btn = e.target.closest(".qr-btn");
    if (btn && !qrEditing) {
      const text = btn.dataset.text;
      const cur = msgInput.value;
      msgInput.value = cur ? cur + " " + text : text;
      msgInput.focus();
    }
  });

  sendBtn.addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea: 3 lines default, 10 lines max
  function autoResizeInput() {
    msgInput.style.height = "auto";
    const lineH = parseFloat(getComputedStyle(msgInput).lineHeight) || 24;
    const minH = lineH * 3;
    const maxH = lineH * 10;
    const newH = Math.min(Math.max(msgInput.scrollHeight, minH), maxH);
    msgInput.style.height = newH + "px";
  }
  msgInput.addEventListener("input", autoResizeInput);
  // Set initial height
  requestAnimationFrame(() => autoResizeInput());

  // ---- Progress sidebar ----
  let activeTab = "sessions"; // "sessions" | "progress"
  let progressPollTimer = null;
  let lastProgressState = { sessions: {} };
  function switchTab(tab) {
    activeTab = tab;
    tabSessions.classList.toggle("active", tab === "sessions");
    tabProgress.classList.toggle("active", tab === "progress");
    tabTasks.classList.toggle("active", tab === "tasks");
    sessionList.style.display = tab === "sessions" ? "" : "none";
    progressPanel.classList.toggle("visible", tab === "progress");
    taskPanel.classList.toggle("visible", tab === "tasks");
    newSessionBtn.classList.toggle("hidden", tab !== "sessions");
    if (tab === "progress") {
      fetchSidebarState();
      if (!progressPollTimer) {
        progressPollTimer = setInterval(fetchSidebarState, 30_000);
      }
    } else {
      clearInterval(progressPollTimer);
      progressPollTimer = null;
    }
    if (tab === "tasks") {
      loadTaskSection();
    }
  }

  tabSessions.addEventListener("click", () => switchTab("sessions"));
  tabProgress.addEventListener("click", () => switchTab("progress"));
  tabTasks.addEventListener("click", () => switchTab("tasks"));

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function renderProgressPanel(state) {
    progressPanel.innerHTML = "";

    const stateEntries = Object.entries(state.sessions || {});
    const pendingOnly = [...pendingSummary].filter(id => !state.sessions[id]);
    const allActiveEntries = [
      ...stateEntries,
      ...pendingOnly.map(id => {
        const s = sessions.find(sess => sess.id === id);
        return [id, { folder: s?.folder || "", name: s?.name || "", _pendingOnly: true }];
      }),
    ];

    // Enrich with metadata (label, running status) from sessions array
    const enriched = allActiveEntries.map(([id, entry]) => {
      const sess = sessions.find(s => s.id === id);
      return {
        id,
        entry,
        isRunning: !!(sess && sess.status === "running"),
        isSummarizing: pendingSummary.has(id),
        label: sess?.label || null,
      };
    });

    // Priority buckets: pending-review > running > other labeled > unlabeled
    const grpPendingReview = enriched.filter(e => e.label === "pending-review");
    const grpRunning = enriched.filter(e => e.isRunning && e.label !== "pending-review");
    const grpOtherLabeled = enriched.filter(e => !e.isRunning && e.label && e.label !== "pending-review");
    const grpUnlabeled = enriched.filter(e => !e.isRunning && !e.label);

    const sortByRecency = (a, b) => {
      if (a.isSummarizing !== b.isSummarizing) return a.isSummarizing ? -1 : 1;
      return (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0);
    };
    [grpPendingReview, grpRunning, grpOtherLabeled, grpUnlabeled].forEach(g => g.sort(sortByRecency));

    // Archived sessions (may or may not have sidebar summary data)
    const archivedEnriched = archivedSessions.map(sess => {
      const entry = state.sessions[sess.id] || { folder: sess.folder || "", name: sess.name || "" };
      return { id: sess.id, entry, isRunning: false, isSummarizing: false, label: sess.label || null };
    });
    archivedEnriched.sort((a, b) => (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0));

    if (enriched.length === 0 && archivedSessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "progress-empty";
      empty.textContent = "No summaries yet. Send a message in any session to generate one.";
      progressPanel.appendChild(empty);
      return;
    }

    const renderCard = ({ id: sessionId, entry, isRunning, isSummarizing, label }) => {
      const card = document.createElement("div");
      card.className = "progress-card";
      const folderName = (entry.folder || "").split("/").pop() || entry.folder || "unknown";
      const displayName = entry.name || folderName;
      const labelObj = label ? getLabelById(label) : null;
      const labelHtml = labelObj
        ? `<span class="progress-card-label" style="background:${escapeHtml(labelObj.color)}20;color:${escapeHtml(labelObj.color)};border-color:${escapeHtml(labelObj.color)}40">${escapeHtml(labelObj.name)}</span>`
        : label
          ? `<span class="progress-card-label">${escapeHtml(label)}</span>`
          : "";

      if (entry._pendingOnly) {
        card.innerHTML = `
          <div class="progress-card-header">
            <div class="progress-card-name">${escapeHtml(displayName)}</div>
            ${labelHtml}
          </div>
          <div class="progress-card-folder">${escapeHtml(entry.folder || "")}</div>
          <div class="progress-summarizing">Summarizing...</div>
        `;
      } else {
        card.innerHTML = `
          <div class="progress-card-header">
            ${isRunning ? '<div class="progress-running-dot"></div>' : ''}
            <div class="progress-card-name">${escapeHtml(displayName)}</div>
            ${labelHtml}
          </div>
          <div class="progress-card-folder">${escapeHtml(entry.folder || "")}</div>
          <div class="progress-card-bg">${escapeHtml(entry.background || "")}</div>
          ${entry.lastAction ? `<div class="progress-card-action">↳ ${escapeHtml(entry.lastAction)}</div>` : ""}
          <div class="progress-card-footer">
            ${entry.updatedAt ? `<span class="progress-card-time">${relativeTime(entry.updatedAt)}</span>` : ""}
            ${isSummarizing ? '<span class="progress-summarizing">Summarizing...</span>' : ""}
          </div>
        `;
      }

      card.addEventListener("click", () => {
        const session = sessions.find(s => s.id === sessionId) || archivedSessions.find(s => s.id === sessionId);
        if (session) {
          switchTab("sessions");
          attachSession(session.id, session);
          if (!isDesktop) closeSidebarFn();
        }
      });
      card.style.cursor = "pointer";
      return card;
    };

    const renderSection = (title, items, extraClass) => {
      if (items.length === 0) return;
      const header = document.createElement("div");
      header.className = "progress-section-header" + (extraClass ? " " + extraClass : "");
      header.textContent = title;
      progressPanel.appendChild(header);
      items.forEach(item => progressPanel.appendChild(renderCard(item)));
    };

    renderSection("Pending Review", grpPendingReview, "is-pending-review");
    renderSection("Running", grpRunning, "is-running");
    renderSection("Labeled", grpOtherLabeled, "");
    renderSection("Other", grpUnlabeled, "");

    // Archived — collapsible section pinned to bottom
    if (archivedEnriched.length > 0) {
      const archiveSection = document.createElement("div");
      archiveSection.className = "progress-archived-section";

      const archiveToggle = document.createElement("div");
      archiveToggle.className = "progress-section-header progress-archive-toggle";

      let archiveOpen = false;
      const archiveBody = document.createElement("div");
      archiveBody.className = "progress-archive-body";
      archiveBody.style.display = "none";
      archivedEnriched.forEach(item => archiveBody.appendChild(renderCard(item)));

      const updateToggle = () => {
        archiveToggle.innerHTML = `<span class="progress-archive-chevron">${archiveOpen ? "▾" : "▸"}</span> Archived (${archivedEnriched.length})`;
        archiveBody.style.display = archiveOpen ? "" : "none";
      };
      archiveToggle.addEventListener("click", () => { archiveOpen = !archiveOpen; updateToggle(); });
      updateToggle();

      archiveSection.appendChild(archiveToggle);
      archiveSection.appendChild(archiveBody);
      progressPanel.appendChild(archiveSection);
    }
  }


  // ---- Live run helpers ----

  function addLiveRunEntry(runId, runSection) {
    const entry = document.createElement("div");
    entry.id = `run-${runId}`;
    entry.innerHTML = `
      <div class="tdp-run-entry">
        <span class="tdp-run-id">${runId.slice(0, 8)}</span>
        <span class="tdp-run-status running">running</span>
        <span class="tdp-run-time">just now</span>
      </div>
      <div class="tdp-run-detail open">
        <div class="tdp-run-live-status" style="padding:8px;font-size:11px;color:var(--text-muted)">
          Starting workflow…
        </div>
      </div>
    `;
    const title = runSection.querySelector(".tdp-section-title");
    if (title && title.nextSibling) {
      runSection.insertBefore(entry, title.nextSibling);
    } else {
      runSection.appendChild(entry);
    }
    const empty = runSection.querySelector(".tdp-empty");
    if (empty) empty.remove();
  }

  function pollRunStatus(runId, runSection) {
    if (activeRunPollInterval) clearInterval(activeRunPollInterval);
    activeRunPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/workflow-runs/${encodeURIComponent(runId)}`);
        if (!res.ok) return;
        const meta = await res.json();

        const entry = document.getElementById(`run-${runId}`);
        if (!entry) { clearInterval(activeRunPollInterval); activeRunPollInterval = null; return; }

        const statusEl = entry.querySelector(".tdp-run-status");
        if (statusEl) {
          statusEl.textContent = meta.status;
          statusEl.className = `tdp-run-status ${meta.status}`;
        }

        const liveStatus = entry.querySelector(".tdp-run-live-status");
        if (liveStatus && meta.steps) {
          const stepEntries = Object.entries(meta.steps);
          if (stepEntries.length === 0) {
            liveStatus.textContent = "Starting workflow…";
          } else {
            liveStatus.innerHTML = stepEntries.map(([stepId, step]) =>
              `<div><strong>${escapeHtml(stepId)}</strong>: ${escapeHtml(step.status)}</div>`
            ).join('');
          }
        }

        if (meta.status === 'completed' || meta.status === 'failed') {
          clearInterval(activeRunPollInterval);
          activeRunPollInterval = null;
          if (liveStatus) {
            liveStatus.innerHTML = '';
            buildRunTasksHtml(meta, liveStatus);
          }
        }
      } catch (err) {
        console.warn('Poll run status failed:', err);
      }
    }, 3000);
  }

  // ---- Workflow main view (reserved for future run history detail) ----
  function buildRunTasksHtml(run, container) {
    const steps = run.steps || {};
    const stepEntries = Object.entries(steps);
    if (stepEntries.length === 0) {
      container.innerHTML = '<div class="workflow-empty" style="padding:6px 8px">No steps recorded</div>';
      return;
    }
    for (const [stepId, stepInfo] of stepEntries) {
      for (const taskId of (stepInfo.tasks || [])) {
        const taskRow = document.createElement("div");
        taskRow.className = "workflow-task-row";
        taskRow.innerHTML = `
          <div class="workflow-task-header">
            <span class="workflow-task-id">${escapeHtml(stepId + "/" + taskId)}</span>
            <span class="workflow-task-chevron">▶</span>
          </div>
          <div class="workflow-task-body"></div>
        `;
        const taskHeader = taskRow.querySelector(".workflow-task-header");
        const body = taskRow.querySelector(".workflow-task-body");
        const chevron = taskRow.querySelector(".workflow-task-chevron");
        taskHeader.addEventListener("click", async () => {
          const wasOpen = body.classList.contains("open");
          body.classList.toggle("open", !wasOpen);
          chevron.style.transform = wasOpen ? "" : "rotate(90deg)";
          if (!wasOpen && !body.dataset.loaded) {
            body.textContent = "Loading…";
            try {
              const res = await fetch(`/api/workflow-runs/${encodeURIComponent(run.runId)}/task/${encodeURIComponent(taskId)}`);
              const data = await res.json();
              body.textContent = data.text || "(empty)";
              body.dataset.loaded = "1";
            } catch {
              body.textContent = "(failed to load)";
            }
          }
        });
        container.appendChild(taskRow);
      }
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function fetchSidebarState() {
    try {
      const res = await fetch("/api/sidebar");
      if (!res.ok) return;
      const state = await res.json();
      // Clear pending flag for sessions whose summary just arrived or updated
      for (const [sessionId, entry] of Object.entries(state.sessions || {})) {
        if (pendingSummary.has(sessionId)) {
          const prev = lastSidebarUpdatedAt[sessionId] || 0;
          if ((entry.updatedAt || 0) > prev) {
            pendingSummary.delete(sessionId);
          }
        }
        lastSidebarUpdatedAt[sessionId] = entry.updatedAt || 0;
      }
      lastProgressState = state;
      renderProgressPanel(state);
    } catch {}
  }

  // ---- Init ----
  applyTheme();
  setInterval(applyTheme, 60000); // recheck time every minute for auto mode
  themeBtn.addEventListener("click", toggleTheme);
  initResponsiveLayout();
  loadInlineTools();
  loadInlineModels();
  loadSessionLabels();
  loadUiSettings();
  connect();
})();
