"use strict";

(function attachRemoteLabSessionStateModel(root) {
  const defaultBoardColumn = {
    key: "unassigned",
    label: "Unassigned",
    title: "Sessions that are not yet arranged by the board model.",
    emptyText: "Nothing here yet",
    order: 0,
  };

  const workflowPrioritySpecs = {
    high: {
      key: "high",
      label: "High",
      rank: 3,
      className: "board-priority-high",
      title: "Needs user attention soon.",
    },
    medium: {
      key: "medium",
      label: "Medium",
      rank: 2,
      className: "board-priority-medium",
      title: "Worth checking soon, but not urgent.",
    },
    low: {
      key: "low",
      label: "Low",
      rank: 1,
      className: "board-priority-low",
      title: "Safe to leave for later.",
    },
  };

  function createEmptyStatus() {
    return {
      key: "idle",
      label: "",
      className: "",
      dotClass: "",
      itemClass: "",
      title: "",
    };
  }

  function createStatus(key, label, className = "", dotClass = "", itemClass = "", title = "") {
    return {
      key,
      label,
      className,
      dotClass,
      itemClass,
      title,
    };
  }

  function normalizeSessionWorkflowState(value) {
    const normalized = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    if (!normalized) return "";
    if (["waiting", "waiting_user", "waiting_for_user", "waiting_on_user", "needs_user", "needs_input"].includes(normalized)) {
      return "waiting_user";
    }
    if (["done", "complete", "completed", "finished"].includes(normalized)) {
      return "done";
    }
    if (["parked", "paused", "pause", "backlog", "todo"].includes(normalized)) {
      return "parked";
    }
    return "";
  }

  function normalizeSessionWorkflowPriority(value) {
    const normalized = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    if (!normalized) return "";
    if (["high", "urgent", "asap", "important", "critical", "top", "top_priority", "p1"].includes(normalized)) {
      return "high";
    }
    if (["medium", "normal", "default", "standard", "soon", "next", "p2"].includes(normalized)) {
      return "medium";
    }
    if (["low", "later", "backlog", "deferred", "eventually", "p3"].includes(normalized)) {
      return "low";
    }
    return "";
  }

  function getWorkflowPriorityInfo(value) {
    const normalized = normalizeSessionWorkflowPriority(value);
    if (!normalized || !workflowPrioritySpecs[normalized]) return null;
    return { ...workflowPrioritySpecs[normalized] };
  }

  function getSessionSortTime(session) {
    const stamp = session?.lastEventAt || session?.updatedAt || session?.created || "";
    const time = new Date(stamp).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function normalizeBoardColumnKey(value) {
    return typeof value === "string"
      ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
      : "";
  }

  function normalizeBoardLayout(layout, sessions = []) {
    const rawColumns = Array.isArray(layout?.columns) ? layout.columns : [];
    const sessionList = Array.isArray(sessions) ? sessions : [];
    const columns = [];
    const seenKeys = new Set();

    for (const entry of rawColumns) {
      const key = normalizeBoardColumnKey(entry?.key || entry?.label);
      const label = typeof entry?.label === "string" && entry.label.trim()
        ? entry.label.trim()
        : "";
      if (!key || !label || seenKeys.has(key)) continue;
      columns.push({
        key,
        label,
        title: typeof entry?.description === "string" && entry.description.trim()
          ? entry.description.trim()
          : (typeof entry?.title === "string" ? entry.title.trim() : ""),
        emptyText: typeof entry?.emptyText === "string" && entry.emptyText.trim()
          ? entry.emptyText.trim()
          : `No sessions in ${label}`,
        order: Number.isInteger(entry?.order) ? entry.order : columns.length * 10,
      });
      seenKeys.add(key);
    }

    for (const session of sessionList) {
      const key = normalizeBoardColumnKey(session?.board?.columnKey || session?.board?.columnLabel);
      const label = typeof session?.board?.columnLabel === "string" && session.board.columnLabel.trim()
        ? session.board.columnLabel.trim()
        : "";
      if (!key || !label || seenKeys.has(key)) continue;
      columns.push({
        key,
        label,
        title: "",
        emptyText: `No sessions in ${label}`,
        order: Number.isInteger(session?.board?.columnOrder) ? session.board.columnOrder : columns.length * 10,
      });
      seenKeys.add(key);
    }

    if (columns.length === 0) {
      return [{ ...defaultBoardColumn }];
    }

    columns.sort((a, b) => (
      (Number.isInteger(a.order) ? a.order : 9999) - (Number.isInteger(b.order) ? b.order : 9999)
      || a.label.localeCompare(b.label)
    ));
    return columns;
  }

  function normalizeSessionActivity(session) {
    const raw = session?.activity || {};
    const rawRunState = raw?.run?.state;
    const runState =
      rawRunState === "running"
        ? rawRunState
        : "idle";
    const queueCount = Number.isInteger(raw?.queue?.count)
      ? raw.queue.count
      : 0;
    const queueState = raw?.queue?.state === "queued" && queueCount > 0
      ? "queued"
      : "idle";
    const renameState = raw?.rename?.state === "pending" || raw?.rename?.state === "failed"
      ? raw.rename.state
      : "idle";
    const compactState = raw?.compact?.state === "pending"
      ? "pending"
      : "idle";

    return {
      run: {
        state: runState,
        phase: typeof raw?.run?.phase === "string" ? raw.run.phase : null,
        runId: typeof raw?.run?.runId === "string" ? raw.run.runId : null,
        cancelRequested: raw?.run?.cancelRequested === true,
      },
      queue: {
        state: queueState,
        count: queueCount,
      },
      rename: {
        state: renameState,
        error: typeof raw?.rename?.error === "string" ? raw.rename.error : "",
      },
      compact: {
        state: compactState,
      },
    };
  }

  function isSessionBusy(session) {
    const activity = normalizeSessionActivity(session);
    return activity.run.state === "running"
      || activity.queue.state === "queued"
      || activity.compact.state === "pending";
  }

  function getSessionPrimaryStatus(session, options = {}) {
    if (!session) {
      return createEmptyStatus();
    }

    const indicators = getSessionStatusSummary(session, options).indicators;
    return indicators[0] || createStatus("idle", "idle");
  }

  function getSessionStatusSummary(session, { includeToolFallback = false } = {}) {
    const activity = normalizeSessionActivity(session);
    const indicators = [];

    if (activity.run.state === "running") {
      indicators.push(createStatus("running", "running", "status-running", "running"));
    }

    if (activity.queue.state === "queued") {
      indicators.push(createStatus(
        "queued",
        "queued",
        "status-queued",
        "queued",
        "",
        activity.queue.count > 0
          ? `${activity.queue.count} follow-up${activity.queue.count === 1 ? "" : "s"} queued`
          : "",
      ));
    }

    if (activity.compact.state === "pending") {
      indicators.push(createStatus("compacting", "compacting", "status-compacting", "compacting"));
    }

    if (activity.rename.state === "pending") {
      indicators.push(createStatus("renaming", "renaming", "status-renaming", "renaming"));
    }

    if (activity.rename.state === "failed") {
      indicators.push(createStatus(
        "rename-failed",
        "rename failed",
        "status-rename-failed",
        "rename-failed",
        "",
        activity.rename.error || "Session rename failed",
      ));
    }

    const primary = indicators[0] || (
      session?.tool && includeToolFallback
        ? createStatus("tool", session.tool)
        : createStatus("idle", "idle")
    );

    return {
      primary,
      indicators: indicators.length > 0 || !primary.label ? indicators : [primary],
    };
  }

  function getSessionVisualStatus(session, options = {}) {
    return getSessionStatusSummary(session, options).primary;
  }

  function getBoardColumns(layout, sessions = []) {
    return normalizeBoardLayout(layout, sessions).map((column) => ({ ...column }));
  }

  function getSessionBoardColumn(session, layout, sessions = []) {
    const columns = getBoardColumns(layout, sessions);
    const requestedKey = normalizeBoardColumnKey(session?.board?.columnKey || session?.board?.columnLabel);
    return columns.find((column) => column.key === requestedKey) || columns[0] || { ...defaultBoardColumn };
  }

  function getSessionBoardPriority(session) {
    const explicitPriority = getWorkflowPriorityInfo(session?.board?.priority || session?.workflowPriority);
    if (explicitPriority) return explicitPriority;
    return getWorkflowPriorityInfo("medium");
  }

  function getSessionBoardOrder(session) {
    return Number.isInteger(session?.board?.order)
      ? session.board.order
      : 9999;
  }

  function compareBoardSessions(a, b) {
    const boardOrderDiff = getSessionBoardOrder(a) - getSessionBoardOrder(b);
    if (boardOrderDiff) return boardOrderDiff;

    const priorityDiff = (getSessionBoardPriority(b)?.rank || 0) - (getSessionBoardPriority(a)?.rank || 0);
    if (priorityDiff) return priorityDiff;

    const pinDiff = (b?.pinned === true ? 1 : 0) - (a?.pinned === true ? 1 : 0);
    if (pinDiff) return pinDiff;

    return getSessionSortTime(b) - getSessionSortTime(a);
  }

  root.RemoteLabSessionStateModel = {
    createEmptyStatus,
    normalizeSessionWorkflowPriority,
    normalizeSessionWorkflowState,
    normalizeSessionActivity,
    isSessionBusy,
    getSessionPrimaryStatus,
    getSessionStatusSummary,
    getSessionVisualStatus,
    getBoardColumns,
    getSessionBoardColumn,
    getSessionBoardPriority,
    getSessionBoardOrder,
    compareBoardSessions,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
