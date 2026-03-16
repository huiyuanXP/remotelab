import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { CHAT_SESSIONS_FILE, CHAT_IMAGES_DIR, INTERRUPTED_SESSIONS_FILE, SESSION_LABELS_FILE } from '../lib/config.mjs';
import { spawnTool } from './process-runner.mjs';
import { loadHistory, appendEvent } from './history.mjs';
import { messageEvent, statusEvent, compactEvent, restartInterruptEvent, restartResumeEvent } from './normalizer.mjs';
import { triggerSummary, removeSidebarEntry, generateCompactSummary, generateAutoTitle } from './summarizer.mjs';

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/**
 * Save base64 images to disk and return image metadata with file paths.
 */
function saveImages(images) {
  if (!images || images.length === 0) return [];
  if (!existsSync(CHAT_IMAGES_DIR)) mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
  return images.map(img => {
    const ext = MIME_EXT[img.mimeType] || '.png';
    const filename = randomBytes(12).toString('hex') + ext;
    const filepath = join(CHAT_IMAGES_DIR, filename);
    writeFileSync(filepath, Buffer.from(img.data, 'base64'));
    return { filename, savedPath: filepath, mimeType: img.mimeType || 'image/png', data: img.data };
  });
}

// In-memory session registry
// sessionId -> { id, folder, tool, status, runner, listeners: Set<ws> }
const liveSessions = new Map();

// Global subscribers: WS clients that receive system-level events
// (session created, deleted, status changes) regardless of which session they're attached to.
const globalSubscribers = new Set();

export function subscribeGlobal(ws) {
  globalSubscribers.add(ws);
}

export function unsubscribeGlobal(ws) {
  globalSubscribers.delete(ws);
}

function broadcastGlobal(msg) {
  const data = JSON.stringify(msg);
  for (const ws of globalSubscribers) {
    try {
      if (ws.readyState === 1) ws.send(data);
    } catch {}
  }
}

// Maps Claude's internal session_id → RemoteLab sessionId (for hook routing)
const claudeSessionMap = new Map();

// Pending PreToolUse hook requests: remoteLabSessionId → { resolve, reject, toolName, toolInput }
const pendingHooks = new Map();

// Completion waiters: sessionId → [{ resolve, reject }]
// Used by waitForIdle() / createAndRun() to block until a session finishes running.
const completionWaiters = new Map();

function generateId() {
  return randomBytes(16).toString('hex');
}

// ---- Hook IPC (PreToolUse HTTP bridge for AskUserQuestion / ExitPlanMode) ----

export function registerClaudeSession(claudeSessionId, remoteLabSessionId) {
  claudeSessionMap.set(claudeSessionId, remoteLabSessionId);
}

export function unregisterClaudeSession(claudeSessionId) {
  claudeSessionMap.delete(claudeSessionId);
}

/**
 * Called by the HTTP hook endpoint when Claude fires a PreToolUse event.
 * Returns a Promise that resolves when the user responds via hook_response WebSocket action.
 * Rejects after timeout or if the session ends.
 */
export function receiveHookRequest(claudeSessionId, toolName, toolInput) {
  const remoteLabSessionId = claudeSessionMap.get(claudeSessionId);
  if (!remoteLabSessionId) {
    return Promise.reject(new Error(`No RemoteLab session mapped for Claude session ${claudeSessionId}`));
  }
  return new Promise((resolve, reject) => {
    pendingHooks.set(remoteLabSessionId, { resolve, reject, toolName, toolInput });
  });
}

/**
 * Called from ws.mjs when user sends a hook_response action.
 * Returns true if a pending hook was found and resolved, false otherwise.
 */
export function resolveHookRequest(remoteLabSessionId, msg) {
  const pending = pendingHooks.get(remoteLabSessionId);
  if (!pending) return false;
  pendingHooks.delete(remoteLabSessionId);
  pending.resolve(msg);
  return true;
}

// ---- Persistence ----

function loadSessionsMeta() {
  try {
    if (!existsSync(CHAT_SESSIONS_FILE)) return [];
    return JSON.parse(readFileSync(CHAT_SESSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSessionsMeta(list) {
  const dir = dirname(CHAT_SESSIONS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CHAT_SESSIONS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

/**
 * Persist claudeSessionId / codexThreadId for a session to disk so they survive restart.
 * Pass null to explicitly clear a field.
 */
function persistSessionIds(sessionId, claudeSessionId, codexThreadId) {
  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === sessionId);
  if (idx === -1) return;
  if (claudeSessionId !== undefined) {
    if (claudeSessionId === null) delete metas[idx].claudeSessionId;
    else metas[idx].claudeSessionId = claudeSessionId;
  }
  if (codexThreadId !== undefined) {
    if (codexThreadId === null) delete metas[idx].codexThreadId;
    else metas[idx].codexThreadId = codexThreadId;
  }
  saveSessionsMeta(metas);
}

// ---- Session Labels ----

const DEFAULT_LABELS = [
  { id: 'running', name: 'Running', color: '#16a34a' },
  { id: 'pending-review', name: 'Pending Review', color: '#f59e0b' },
  { id: 'planned', name: 'Planned', color: '#8b5cf6' },
  { id: 'done', name: 'Done', color: '#22c55e' },
];

function loadLabels() {
  try {
    if (!existsSync(SESSION_LABELS_FILE)) {
      saveLabels(DEFAULT_LABELS);
      return [...DEFAULT_LABELS];
    }
    return JSON.parse(readFileSync(SESSION_LABELS_FILE, 'utf8'));
  } catch {
    return [...DEFAULT_LABELS];
  }
}

function saveLabels(labels) {
  const dir = dirname(SESSION_LABELS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_LABELS_FILE, JSON.stringify(labels, null, 2), 'utf8');
}

export function getLabels() {
  return loadLabels();
}

export function addLabel(label) {
  const labels = loadLabels();
  labels.push(label);
  saveLabels(labels);
  return label;
}

export function removeLabel(labelId) {
  const labels = loadLabels();
  const idx = labels.findIndex(l => l.id === labelId);
  if (idx === -1) return false;
  labels.splice(idx, 1);
  saveLabels(labels);
  // Clear this label from any sessions that use it
  const metas = loadSessionsMeta();
  let changed = false;
  for (const m of metas) {
    if (m.label === labelId) {
      delete m.label;
      changed = true;
    }
  }
  if (changed) saveSessionsMeta(metas);
  return true;
}

export function updateLabel(labelId, updates) {
  const labels = loadLabels();
  const label = labels.find(l => l.id === labelId);
  if (!label) return null;
  if (updates.name !== undefined) label.name = updates.name;
  if (updates.color !== undefined) label.color = updates.color;
  saveLabels(labels);
  return label;
}

export function setSessionLabel(sessionId, labelId) {
  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === sessionId);
  if (idx === -1) return null;
  if (labelId === null || labelId === undefined) {
    delete metas[idx].label;
  } else {
    metas[idx].label = labelId;
  }
  saveSessionsMeta(metas);
  const live = liveSessions.get(sessionId);
  const updated = { ...metas[idx], status: live ? live.status : 'idle' };
  broadcast(sessionId, { type: 'session', session: updated });
  broadcastGlobal({ type: 'session', session: updated });
  return updated;
}

// ---- Public API ----

export function listSessions() {
  const metas = loadSessionsMeta();
  return metas.map(m => ({
    ...m,
    status: liveSessions.has(m.id)
      ? liveSessions.get(m.id).status
      : 'idle',
  }));
}

export function getSession(id) {
  const metas = loadSessionsMeta();
  const meta = metas.find(m => m.id === id);
  if (!meta) return null;
  const live = liveSessions.get(id);
  return {
    ...meta,
    status: live ? live.status : 'idle',
  };
}

export function createSession(folder, tool, name = '', options = {}) {
  const id = generateId();
  const session = {
    id,
    folder,
    tool,
    name: name || '',
    created: new Date().toISOString(),
  };
  if (options.continuedFrom) {
    session.continuedFrom = options.continuedFrom;
  }
  if (options.hidden) {
    session.hidden = true;
  }

  const metas = loadSessionsMeta();
  metas.push(session);
  saveSessionsMeta(metas);

  const result = { ...session, status: 'idle' };
  // Notify all connected clients (e.g. sessions created via REST API or MCP)
  broadcastGlobal({ type: 'session', session: result });
  return result;
}

export function deleteSession(id) {
  const live = liveSessions.get(id);
  if (live?.runner) {
    live.runner.cancel();
  }
  liveSessions.delete(id);

  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === id);
  if (idx === -1) return false;
  metas.splice(idx, 1);
  saveSessionsMeta(metas);
  removeSidebarEntry(id);
  broadcastGlobal({ type: 'deleted', sessionId: id });
  return true;
}

export function archiveSession(id, archived) {
  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === id);
  if (idx === -1) return null;
  if (archived) {
    metas[idx].archived = true;
  } else {
    delete metas[idx].archived;
  }
  saveSessionsMeta(metas);
  const live = liveSessions.get(id);
  const updated = { ...metas[idx], status: live ? live.status : 'idle' };
  broadcast(id, { type: 'session', session: updated });
  broadcastGlobal({ type: 'session', session: updated });
  return updated;
}

export function renameSession(id, name) {
  const metas = loadSessionsMeta();
  const idx = metas.findIndex(m => m.id === id);
  if (idx === -1) return null;
  metas[idx].name = name;
  saveSessionsMeta(metas);
  const live = liveSessions.get(id);
  const updated = { ...metas[idx], status: live ? live.status : 'idle' };
  broadcast(id, { type: 'session', session: updated });
  return updated;
}

/**
 * Subscribe a WebSocket to session events.
 */
export function subscribe(sessionId, ws) {
  let live = liveSessions.get(sessionId);
  if (!live) {
    const meta = loadSessionsMeta().find(m => m.id === sessionId);
    live = {
      status: 'idle',
      runner: null,
      listeners: new Set(),
      claudeSessionId: meta?.claudeSessionId,
      codexThreadId: meta?.codexThreadId,
    };
    liveSessions.set(sessionId, live);
  }
  live.listeners.add(ws);
}

export function unsubscribe(sessionId, ws) {
  const live = liveSessions.get(sessionId);
  if (live) {
    live.listeners.delete(ws);
  }
}

/**
 * Broadcast event to all subscribed WebSocket clients.
 */
function broadcast(sessionId, msg) {
  const live = liveSessions.get(sessionId);
  if (!live) return;
  const data = JSON.stringify(msg);
  for (const ws of live.listeners) {
    try {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(data);
      }
    } catch {}
  }
}

/**
 * Send a user message to a session. Spawns a new process if needed.
 */
export function sendMessage(sessionId, text, images, options = {}) {
  let session = getSession(sessionId);
  if (!session) throw new Error('Session not found');

  // Determine effective tool: per-message override or session default
  const effectiveTool = options.tool || session.tool;
  console.log(`[session-mgr] sendMessage session=${sessionId.slice(0,8)} tool=${effectiveTool} (session.tool=${session.tool}) thinking=${!!options.thinking} text="${text.slice(0,80)}" images=${images?.length || 0}`);

  // Save images to disk
  const savedImages = saveImages(images);
  // For history/display: store filenames (not base64) so history files stay small
  const imageRefs = savedImages.map(img => ({ filename: img.filename, mimeType: img.mimeType }));

  // Store user message in history
  const userEvt = messageEvent('user', text, imageRefs.length > 0 ? imageRefs : undefined);
  appendEvent(sessionId, userEvt);
  broadcast(sessionId, { type: 'event', event: userEvt });

  // Auto-generate title if session has no name and this is the first message
  if (!session.name) {
    const existingHistory = loadHistory(sessionId);
    // existingHistory includes the message we just appended, so first message means length === 1
    if (existingHistory.length <= 1) {
      generateAutoTitle(text).then(title => {
        if (title) {
          console.log(`[session-mgr] Auto-title for ${sessionId.slice(0,8)}: "${title}"`);
          renameSession(sessionId, title);
        }
      }).catch(() => {});
    }
  }

  let live = liveSessions.get(sessionId);
  if (!live) {
    const meta = loadSessionsMeta().find(m => m.id === sessionId);
    live = {
      status: 'idle',
      runner: null,
      listeners: new Set(),
      claudeSessionId: meta?.claudeSessionId,
      codexThreadId: meta?.codexThreadId,
    };
    liveSessions.set(sessionId, live);
  }

  console.log(`[session-mgr] live state: status=${live.status}, hasRunner=${!!live.runner}, claudeSessionId=${live.claudeSessionId || 'none'}, codexThreadId=${live.codexThreadId || 'none'}, listeners=${live.listeners.size}`);

  // If tool was switched, clear resume IDs (they are tool-specific)
  if (effectiveTool !== session.tool) {
    console.log(`[session-mgr] Tool switched from ${session.tool} to ${effectiveTool}, clearing resume IDs`);
    live.claudeSessionId = undefined;
    live.codexThreadId = undefined;
    persistSessionIds(sessionId, null, null);
  }

  // If a process is still running, this is an "interrupt & send" — cancel old process
  let wasInterrupted = false;
  if (live.runner) {
    wasInterrupted = true;
    console.log(`[session-mgr] Interrupting existing runner for new message`);
    // Increment epoch so the stale onExit is ignored
    live.runEpoch = (live.runEpoch || 0) + 1;
    // Capture session/thread IDs before killing
    if (live.runner.claudeSessionId) {
      live.claudeSessionId = live.runner.claudeSessionId;
    }
    if (live.runner.codexThreadId) {
      live.codexThreadId = live.runner.codexThreadId;
    }
    live.runner.cancel();
    live.runner = null;
  }

  // Epoch counter: guards onExit from stale processes overwriting new runner state
  live.runEpoch = (live.runEpoch || 0) + 1;
  const myEpoch = live.runEpoch;

  live.status = 'running';
  // System-level: auto-set "running" label when session receives a message
  {
    const metas = loadSessionsMeta();
    const idx = metas.findIndex(m => m.id === sessionId);
    if (idx !== -1) {
      metas[idx].label = 'running';
      saveSessionsMeta(metas);
      session = metas[idx];
    }
  }
  broadcast(sessionId, { type: 'session', session: { ...session, status: 'running' } });
  broadcastGlobal({ type: 'session', session: { ...session, status: 'running' } });

  const onEvent = (evt) => {
    console.log(`[session-mgr] onEvent session=${sessionId.slice(0,8)} type=${evt.type} content=${(evt.content || evt.toolName || '').slice(0, 80)}`);
    appendEvent(sessionId, evt);
    broadcast(sessionId, { type: 'event', event: evt });
  };

  const onExit = (code) => {
    console.log(`[session-mgr] onExit session=${sessionId.slice(0,8)} code=${code} epoch=${myEpoch}`);
    const l = liveSessions.get(sessionId);

    // If a newer sendMessage has started a new process, this onExit is stale — skip cleanup
    if (l && l.runEpoch !== myEpoch) {
      console.log(`[session-mgr] Stale onExit (epoch ${myEpoch} vs current ${l.runEpoch}), skipping`);
      return;
    }

    // Auto-retry: if --resume failed (non-zero exit, resume was attempted, not already retried),
    // clear the stale claudeSessionId and re-spawn the same message fresh.
    if (code !== 0 && spawnOptions.claudeSessionId && !spawnOptions._retried) {
      console.log(`[session-mgr] Resume failed for session ${sessionId.slice(0,8)}, retrying without --resume`);
      delete spawnOptions.claudeSessionId;
      spawnOptions._retried = true;
      if (l) {
        l.claudeSessionId = undefined;
        const retryRunner = spawnTool(effectiveTool, session.folder, text, onEvent, onExit, spawnOptions);
        l.runner = retryRunner;
      }
      return;
    }

    if (l) {
      // Capture session/thread IDs for next resume
      if (l.runner?.claudeSessionId) {
        l.claudeSessionId = l.runner.claudeSessionId;
        console.log(`[session-mgr] Saved claudeSessionId=${l.claudeSessionId} for session ${sessionId.slice(0,8)}`);
        unregisterClaudeSession(l.runner.claudeSessionId);
      }
      if (l.runner?.codexThreadId) {
        l.codexThreadId = l.runner.codexThreadId;
        console.log(`[session-mgr] Saved codexThreadId=${l.codexThreadId} for session ${sessionId.slice(0,8)}`);
      }
      // Persist IDs to disk so they survive server restart
      persistSessionIds(sessionId, l.claudeSessionId, l.codexThreadId);
      l.status = 'idle';
      l.runner = null;
    }
    // Notify any waiters (e.g. workflow engine's createAndRun)
    const waiters = completionWaiters.get(sessionId);
    if (waiters && waiters.length > 0) {
      completionWaiters.delete(sessionId);
      for (const w of waiters) w.resolve();
    }
    // Reject any pending hook so the HTTP long-poll can unblock
    const pending = pendingHooks.get(sessionId);
    if (pending) {
      pendingHooks.delete(sessionId);
      pending.reject(new Error('Session ended before hook was resolved'));
    }
    // Re-fetch session from disk to pick up any changes (e.g. auto-title rename)
    const freshSession = getSession(sessionId) || session;
    broadcast(sessionId, {
      type: 'session',
      session: { ...freshSession, status: 'idle' },
    });
    broadcastGlobal({ type: 'session', session: { ...freshSession, status: 'idle' } });
    // Trigger async sidebar summary (non-blocking, does not affect session flow)
    triggerSummary({ id: sessionId, folder: freshSession.folder, name: freshSession.name || '' });

  };

  const spawnOptions = { sessionId };
  if (live.claudeSessionId) {
    spawnOptions.claudeSessionId = live.claudeSessionId;
    console.log(`[session-mgr] Will resume Claude session: ${live.claudeSessionId}`);
  }
  if (live.codexThreadId) {
    spawnOptions.codexThreadId = live.codexThreadId;
    console.log(`[session-mgr] Will resume Codex thread: ${live.codexThreadId}`);
  }

  if (savedImages.length > 0) {
    spawnOptions.images = savedImages;
  }
  if (options.thinking) {
    spawnOptions.thinking = true;
  }
  if (options.model) {
    spawnOptions.model = options.model;
    // Persist model selection to session metadata so it survives refresh/reattach
    const metas = loadSessionsMeta();
    const idx = metas.findIndex(m => m.id === sessionId);
    if (idx !== -1 && metas[idx].model !== options.model) {
      metas[idx].model = options.model;
      saveSessionsMeta(metas);
    }
  }
  // Register Claude's session_id → our sessionId mapping when Claude announces itself
  spawnOptions.onClaudeSessionId = (claudeSessionId) => {
    registerClaudeSession(claudeSessionId, sessionId);
  };

  // Log Claude session file size if resuming (helps diagnose slow --resume)
  if (spawnOptions.claudeSessionId) {
    const home = process.env.HOME || '';
    const sessDir = join(home, '.claude', 'projects');
    try {
      // Search for the session JSONL file across all project dirs
      const projects = readdirSync(sessDir);
      for (const proj of projects) {
        const sessFile = join(sessDir, proj, '.sessions', spawnOptions.claudeSessionId + '.jsonl');
        if (existsSync(sessFile)) {
          const size = statSync(sessFile).size;
          const sizeKB = (size / 1024).toFixed(1);
          console.log(`[session-mgr] Claude session file: ${sessFile} (${sizeKB} KB)`);
          break;
        }
      }
    } catch {}
  }

  // When interrupting a running task, wrap the prompt so the model handles
  // the interrupt then continues the original task (via --resume context).
  let promptText = text;
  if (wasInterrupted) {
    promptText = [
      '[INTERRUPT from user — the previous task was interrupted. Handle this message first, then continue the task you were working on. If this message is a correction or clarification, apply it to the ongoing task. Check your conversation history to recall what you were doing.]',
      '',
      text,
    ].join('\n');
    console.log(`[session-mgr] Wrapped interrupt prompt for session ${sessionId.slice(0,8)}`);
  }

  console.log(`[session-mgr] Spawning tool=${effectiveTool} folder=${session.folder} thinking=${!!options.thinking}`);
  const runner = spawnTool(effectiveTool, session.folder, promptText, onEvent, onExit, spawnOptions);
  live.runner = runner;
}

/**
 * Cancel the running process for a session.
 */
export function cancelSession(sessionId) {
  const live = liveSessions.get(sessionId);
  if (live?.runner) {
    // Increment epoch so the stale onExit from the killed process is ignored
    // (prevents auto-retry from re-spawning with the old message)
    live.runEpoch = (live.runEpoch || 0) + 1;
    // Capture session/thread IDs before killing so next message can --resume
    if (live.runner.claudeSessionId) {
      live.claudeSessionId = live.runner.claudeSessionId;
      console.log(`[session-mgr] Cancel: saved claudeSessionId=${live.claudeSessionId} for session ${sessionId.slice(0,8)}`);
      unregisterClaudeSession(live.runner.claudeSessionId);
    }
    if (live.runner.codexThreadId) {
      live.codexThreadId = live.runner.codexThreadId;
      console.log(`[session-mgr] Cancel: saved codexThreadId=${live.codexThreadId} for session ${sessionId.slice(0,8)}`);
    }
    // Persist IDs to disk so they survive server restart
    persistSessionIds(sessionId, live.claudeSessionId, live.codexThreadId);
    live.runner.cancel();
    live.runner = null;
    live.status = 'idle';
    // Reject any pending hook so the HTTP long-poll can unblock
    const pending = pendingHooks.get(sessionId);
    if (pending) {
      pendingHooks.delete(sessionId);
      pending.reject(new Error('Session cancelled by user'));
    }
    const session = getSession(sessionId);
    broadcast(sessionId, {
      type: 'session',
      session: { ...session, status: 'idle' },
    });
    broadcastGlobal({ type: 'session', session: { ...session, status: 'idle' } });
    const evt = statusEvent('cancelled');
    appendEvent(sessionId, evt);
    broadcast(sessionId, { type: 'event', event: evt });
  }
}

/**
 * Get session history for replay on reconnect.
 */
export function getHistory(sessionId) {
  return loadHistory(sessionId);
}

// ---- Auto-compact ----


/**
 * Auto-compact a session: generate summary, create new session, seamlessly switch listeners.
 */
export async function compactSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error('Session not found');

  console.log(`[session-mgr] Starting compact for session ${sessionId.slice(0,8)}`);

  // Broadcast compacting status to listeners
  const compactingEvt = statusEvent('Compacting context...');
  appendEvent(sessionId, compactingEvt);
  broadcast(sessionId, { type: 'event', event: compactingEvt });

  // Generate summary
  const summary = await generateCompactSummary(sessionId, session.folder);
  console.log(`[session-mgr] Compact summary generated (${summary.length} chars)`);

  // Determine continued name
  const match = session.name?.match(/\(continued(?: (\d+))?\)$/);
  let newName;
  if (match) {
    const n = match[1] ? parseInt(match[1], 10) + 1 : 2;
    newName = session.name.replace(/\(continued(?: \d+)?\)$/, `(continued ${n})`);
  } else {
    newName = `${session.name || session.folder.split('/').pop()} (continued)`;
  }

  // Create new session
  const newSession = createSession(session.folder, session.tool, newName, { continuedFrom: sessionId });
  console.log(`[session-mgr] Created continuation session ${newSession.id.slice(0,8)}`);

  // Record compact events in both sessions
  const summaryExcerpt = summary.slice(0, 200) + (summary.length > 200 ? '...' : '');
  const oldEvt = compactEvent(sessionId, newSession.id, summaryExcerpt);
  appendEvent(sessionId, oldEvt);

  const newEvt = compactEvent(sessionId, newSession.id, summaryExcerpt);
  appendEvent(newSession.id, newEvt);

  // Transfer listeners from old session to new session
  const oldLive = liveSessions.get(sessionId);
  const listeners = oldLive ? new Set(oldLive.listeners) : new Set();

  // Set up new session in liveSessions
  let newLive = liveSessions.get(newSession.id);
  if (!newLive) {
    newLive = { status: 'idle', runner: null, listeners: new Set() };
    liveSessions.set(newSession.id, newLive);
  }
  for (const ws of listeners) {
    newLive.listeners.add(ws);
  }

  // Broadcast compact switch to all listeners (on old session, before detach)
  broadcast(sessionId, { type: 'compact', oldSessionId: sessionId, newSessionId: newSession.id });

  // Send the summary as the first message to the new session
  const summaryPrompt = [
    '[Context compaction — this is a continuation of a previous conversation. Here is the summary of what we\'ve been working on:]',
    '',
    summary,
    '',
    '[Please acknowledge you\'ve reviewed the above context and confirm you\'re ready to continue. Then wait for the user\'s next instruction.]',
  ].join('\n');

  sendMessage(newSession.id, summaryPrompt, undefined, { tool: session.tool });
}

/**
 * Returns a Promise that resolves when the session next becomes idle.
 * Used by workflow engine tasks to wait for Claude to finish.
 */
export function waitForIdle(sessionId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = completionWaiters.get(sessionId);
      if (waiters) {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
      }
      reject(new Error(`Timeout waiting for session ${sessionId.slice(0,8)} to become idle`));
    }, timeoutMs);

    const entry = {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject,
    };

    if (!completionWaiters.has(sessionId)) completionWaiters.set(sessionId, []);
    completionWaiters.get(sessionId).push(entry);
  });
}

/**
 * Create a session, send a prompt, wait for completion, return last assistant message.
 * Used by the workflow engine to run tasks headlessly.
 */
export async function createAndRun(folder, model, prompt) {
  const home = homedir();
  const normalizedFolder = folder.startsWith(home + '/') ? folder.slice(home.length + 1) : folder;
  const session = createSession(normalizedFolder, 'claude', `workflow-${Date.now()}`, { hidden: true });

  // Register waiter BEFORE sendMessage to avoid a race where onExit fires synchronously
  const idlePromise = waitForIdle(session.id, 5 * 60 * 1000);

  sendMessage(session.id, prompt, undefined, { model });

  await idlePromise;

  // Extract last assistant message content from history
  const history = loadHistory(session.id);
  const lastMsg = [...history].reverse().find(e => e.type === 'message' && e.role === 'assistant');
  return lastMsg?.content || '[no assistant output]';
}

// ---- Restart recovery ----

function saveInterruptedSessions() {
  const interrupted = [];
  for (const [sessionId, live] of liveSessions) {
    if (live.runner && live.status === 'running') {
      const claudeSessionId = live.runner.claudeSessionId || live.claudeSessionId;
      const codexThreadId = live.runner.codexThreadId || live.codexThreadId;
      interrupted.push({ sessionId, claudeSessionId, codexThreadId });
      // Record interrupt event in history
      const evt = restartInterruptEvent();
      appendEvent(sessionId, evt);
      broadcast(sessionId, { type: 'event', event: evt });
    }
  }
  if (interrupted.length > 0) {
    const dir = dirname(INTERRUPTED_SESSIONS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(INTERRUPTED_SESSIONS_FILE, JSON.stringify(interrupted, null, 2), 'utf8');
    console.log(`[session-mgr] Saved ${interrupted.length} interrupted session(s) for recovery`);
  }
}

export function broadcastRestart() {
  broadcastGlobal({ type: 'server_restart', message: 'Server is restarting. Sessions will resume automatically...' });
}

export async function recoverInterruptedSessions() {
  try {
    if (!existsSync(INTERRUPTED_SESSIONS_FILE)) return;
    const interrupted = JSON.parse(readFileSync(INTERRUPTED_SESSIONS_FILE, 'utf8'));
    unlinkSync(INTERRUPTED_SESSIONS_FILE);
    if (!interrupted || interrupted.length === 0) return;
    console.log(`[session-mgr] Recovering ${interrupted.length} interrupted session(s)`);
    // Brief delay to let the server fully initialize
    await new Promise(r => setTimeout(r, 2000));
    for (const { sessionId } of interrupted) {
      const session = getSession(sessionId);
      if (!session) {
        console.log(`[session-mgr] Interrupted session ${sessionId.slice(0, 8)} not found, skipping`);
        continue;
      }
      console.log(`[session-mgr] Auto-resuming session ${sessionId.slice(0, 8)}: ${session.name}`);
      // Append resume event to history so it shows in chat on reconnect
      const resumeEvt = restartResumeEvent();
      appendEvent(sessionId, resumeEvt);
      // Send resume message (uses existing --resume claudeSessionId mechanism)
      try {
        sendMessage(sessionId, '[SERVER NOTIFICATION] The RemoteLab server was automatically restarted. Your session has been resumed. Do NOT restart any services. Please review your conversation history and continue your previous task from where you left off.', null, {});
      } catch (err) {
        console.error(`[session-mgr] Failed to resume session ${sessionId.slice(0, 8)}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[session-mgr] Failed to recover interrupted sessions:', err.message);
  }
}

/**
 * Kill all running processes (for shutdown).
 */
export function killAll() {
  saveInterruptedSessions();
  for (const [, live] of liveSessions) {
    if (live.runner) {
      live.runner.cancel();
    }
  }
  liveSessions.clear();
}
