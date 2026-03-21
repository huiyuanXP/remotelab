import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { spawn } from 'child_process';
import { readdir, stat } from 'fs/promises';
import { createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { SESSION_EXPIRY, CHAT_IMAGES_DIR, QUICK_REPLIES_FILE, REPORT_TO_FILE, UI_SETTINGS_FILE } from '../lib/config.mjs';
import {
  sessions, saveAuthSessions,
  verifyToken, verifyPassword, generateToken,
  parseCookies, setCookie, clearCookie,
} from '../lib/auth.mjs';
import { getAvailableTools } from '../lib/tools.mjs';
import { listSessions, getSession, createSession, deleteSession, sendMessage, getHistory, waitForIdle, receiveHookRequest, getLabels, addLabel, removeLabel, updateLabel, setSessionLabel, archiveSession, restartServer, broadcastReportNew } from './session-manager.mjs';
import { executeWorkflow, listWorkflowRuns } from './workflow-engine.mjs';
import { reloadSchedule, updateLastRun } from './scheduler.mjs';
import { getSidebarState } from './summarizer.mjs';
import { listReports, getReport, getReportHtml, createReport, markAsRead, deleteReport } from './reports.mjs';
import { initTaskManager, createTask, getTask, listTasks, updateTask, deleteTask } from './task-manager.mjs';
import { readBody, readBodyBinary } from '../lib/utils.mjs';
import {
  getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts,
  setSecurityHeaders, generateNonce, requireAuth,
} from './middleware.mjs';

// ---- report_to persistence (survives chat-server restarts) ----

// workerSessionId → reportToSessionId
const pendingReportTo = new Map();

function saveReportTo() {
  const data = Object.fromEntries(pendingReportTo);
  writeFileSync(REPORT_TO_FILE, JSON.stringify(data), 'utf8');
}

function registerReportTo(workerSessionId, reportToSessionId) {
  pendingReportTo.set(workerSessionId, reportToSessionId);
  saveReportTo();
  waitForIdle(workerSessionId, 30 * 60 * 1000).then(() => {
    sendReport(workerSessionId, reportToSessionId);
  }).catch(err => {
    console.warn(`[router] report_to watcher failed for ${workerSessionId.slice(0,8)}: ${err.message}`);
  }).finally(() => {
    pendingReportTo.delete(workerSessionId);
    saveReportTo();
  });
}

function sendReport(workerSessionId, reportToSessionId) {
  const workerSession = getSession(workerSessionId);
  const workerName = workerSession?.name || workerSessionId.slice(0, 8);
  const history = getHistory(workerSessionId);
  const firstMsg = history.find(e => e.role === 'user')?.content || '';
  const lastMsg = [...history].reverse().find(e => e.role === 'assistant')?.content || '';
  const report = [
    `[子任务完成汇报] Session "${workerName}"`,
    firstMsg && `[Task] ${firstMsg}`,
    lastMsg && `[Result] ${lastMsg}`,
  ].filter(Boolean).join('\n');
  sendMessage(reportToSessionId, report, undefined, {});
}

export function recoverReportToWatchers() {
  try {
    if (!existsSync(REPORT_TO_FILE)) return;
    const data = JSON.parse(readFileSync(REPORT_TO_FILE, 'utf8'));
    const entries = Object.entries(data);
    if (entries.length === 0) return;
    console.log(`[router] Recovering ${entries.length} report_to watcher(s)`);
    for (const [workerSessionId, reportToSessionId] of entries) {
      const session = getSession(workerSessionId);
      if (!session) {
        console.log(`[router] Worker session ${workerSessionId.slice(0,8)} gone, skipping`);
        continue;
      }
      // Check if worker has a real result (last assistant msg after last user msg)
      const history = getHistory(workerSessionId);
      const lastUserIdx = [...history].map((e, i) => e.role === 'user' ? i : -1).filter(i => i >= 0).pop() ?? -1;
      const lastAssistantIdx = [...history].map((e, i) => e.role === 'assistant' ? i : -1).filter(i => i >= 0).pop() ?? -1;
      const hasResult = lastAssistantIdx > lastUserIdx;

      if (session.status === 'idle' && hasResult) {
        // Worker cleanly finished — send report immediately
        console.log(`[router] Worker ${workerSessionId.slice(0,8)} idle with result, sending report`);
        sendReport(workerSessionId, reportToSessionId);
        pendingReportTo.delete(workerSessionId);
      } else {
        // Worker mid-task or interrupted — re-register watcher, wait for next idle
        console.log(`[router] Re-watching worker ${workerSessionId.slice(0,8)} (status=${session.status}, hasResult=${hasResult})`);
        registerReportTo(workerSessionId, reportToSessionId);
      }
    }
    saveReportTo(); // update file (remove completed ones)
  } catch (err) {
    console.error(`[router] Failed to recover report_to watchers: ${err.message}`);
  }
}

// ---- Task Manager initialization ----
// Auto-dispatch: when a blocked task becomes pending and has an assigned session,
// send it a message to start execution.
initTaskManager(async (task) => {
  const text = [
    `[自动派发] 任务依赖已全部完成，请开始执行。`,
    `任务: ${task.subject}`,
    task.description ? `描述: ${task.description}` : null,
    `Task ID: ${task.id}`,
    ``,
    `⚠️ 完成后必须调用 mcp__remotelab__update_task，将 task_id="${task.id}" 的 status 设为 "completed"。这会自动触发下游依赖任务的执行。`,
  ].filter(Boolean).join('\n');
  try {
    sendMessage(task.assigned_session_id, text, undefined, {});
    if (task.report_to) {
      registerReportTo(task.assigned_session_id, task.report_to);
    }
    console.log(`[TaskManager] Auto-dispatched task "${task.id}" to session ${task.assigned_session_id.slice(0, 8)}`);
  } catch (err) {
    console.error(`[TaskManager] Auto-dispatch failed for task "${task.id}": ${err.message}`);
  }
});

// Paths (files are read from disk on each request for hot-reload)
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const loginTemplatePath = join(__dirname, '..', 'templates', 'login.html');
const reportsTemplatePath = join(__dirname, '..', 'templates', 'reports.html');
const staticDir = join(__dirname, '..', 'static');

const staticMimeTypes = {
  'manifest.json': 'application/manifest+json',
  'icon.svg': 'image/svg+xml',
  'apple-touch-icon.png': 'image/png',
  'chat.js': 'application/javascript',
  'themes.js': 'application/javascript',
  'marked.min.js': 'application/javascript',
  'highlight.min.js': 'application/javascript',
  'hljs-github-dark.css': 'text/css',
};

// ---- Git helper ----

function runGit(args, cwd, { maxOutput = 512 * 1024, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '', stderr = '', killed = false;
    let timer;
    if (timeout > 0) {
      timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeout);
    }
    proc.stdout.on('data', d => { if (stdout.length < maxOutput) stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (timer) clearTimeout(timer);
      if (killed) reject(new Error('Git operation timed out'));
      else if (code !== 0) reject(new Error(stderr.trim() || `git exited with code ${code}`));
      else resolve(stdout);
    });
    proc.on('error', err => { if (timer) clearTimeout(timer); reject(err); });
  });
}

export async function handleRequest(req, res) {
  const parsedUrl = parseUrl(req.url, true);
  const pathname = parsedUrl.pathname;

  // Static assets (read from disk each time for hot-reload)
  const staticName = pathname.slice(1); // strip leading /
  if (staticMimeTypes[staticName]) {
    try {
      const content = readFileSync(join(staticDir, staticName));
      res.writeHead(200, {
        'Content-Type': staticMimeTypes[staticName],
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
    return;
  }

  const nonce = generateNonce();
  setSecurityHeaders(res, nonce);

  // Token auth via query
  const queryToken = parsedUrl.query.token;
  if (queryToken) {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      console.warn(`[router] 429 token-auth ip=${ip}`);
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
      res.end('Too many failed attempts. Please try again later.');
      return;
    }
    if (verifyToken(queryToken)) {
      clearFailedAttempts(ip);
      const sessionToken = generateToken();
      sessions.set(sessionToken, { expiry: Date.now() + SESSION_EXPIRY });
      saveAuthSessions();
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': setCookie(sessionToken) });
      res.end();
    } else {
      recordFailedAttempt(ip);
      res.writeHead(302, { 'Location': '/login' });
      res.end();
    }
    return;
  }

  // Login — POST (form submit)
  if (pathname === '/login' && req.method === 'POST') {
    const ip = getClientIp(req);
    if (isRateLimited(ip)) {
      console.warn(`[router] 429 login ip=${ip}`);
      res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
      res.end('Too many failed attempts. Please try again later.');
      return;
    }
    let body;
    try { body = await readBody(req, 4096); } catch { body = ''; }
    const params = new URLSearchParams(body);
    const type = params.get('type');
    let valid = false;
    if (type === 'token') {
      valid = verifyToken(params.get('token') || '');
    } else if (type === 'password') {
      valid = verifyPassword(params.get('username') || '', params.get('password') || '');
    }
    if (valid) {
      clearFailedAttempts(ip);
      const sessionToken = generateToken();
      sessions.set(sessionToken, { expiry: Date.now() + SESSION_EXPIRY });
      saveAuthSessions();
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': setCookie(sessionToken) });
    } else {
      recordFailedAttempt(ip);
      const mode = type === 'password' ? 'pw' : 'token';
      console.warn(`[router] login failed mode=${mode} ip=${ip}`);
      res.writeHead(302, { 'Location': `/login?error=1&mode=${mode}` });
    }
    res.end();
    return;
  }

  // Login — GET (show form)
  if (pathname === '/login') {
    const hasError = parsedUrl.query.error === '1';
    const mode = parsedUrl.query.mode === 'pw' ? 'pw' : 'token';
    let loginHtml;
    try { loginHtml = readFileSync(loginTemplatePath, 'utf8'); } catch { loginHtml = '<h1>Login template missing</h1>'; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(loginHtml
      .replace(/\{\{NONCE\}\}/g, nonce)
      .replace(/\{\{ERROR_CLASS\}\}/g, hasError ? '' : 'hidden')
      .replace(/\{\{MODE\}\}/g, mode));
    return;
  }

  // Logout
  if (pathname === '/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const token = cookies.session_token;
    if (token) { sessions.delete(token); saveAuthSessions(); }
    res.writeHead(302, { 'Location': '/login', 'Set-Cookie': clearCookie() });
    res.end();
    return;
  }

  // ---- Internal hook endpoint (called by Claude Code's PreToolUse HTTP hook) ----
  // No auth required: only reachable from 127.0.0.1 (Claude process on same machine)
  if (pathname === '/api/internal/hook/pretooluse' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 65536); } catch { body = '{}'; }
    let hookData;
    try { hookData = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { session_id: claudeSessionId, tool_name: toolName, tool_input: toolInput } = hookData;
    console.log(`[router] hook pretooluse tool=${toolName} claude_session=${claudeSessionId?.slice(0,8)}`);

    // Wait briefly for the Claude session mapping to be registered (race condition guard)
    let decision;
    try {
      // Give session-manager up to 2s to register the mapping if not yet available
      let attempts = 0;
      while (attempts < 20) {
        try {
          const hookPromise = receiveHookRequest(claudeSessionId, toolName, toolInput);
          decision = await Promise.race([
            hookPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('hook timeout')), 295000)),
          ]);
          break;
        } catch (err) {
          if (err.message.includes('No RemoteLab session mapped') && attempts < 19) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.warn(`[router] hook pretooluse failed: ${err.message}`);
      // Non-blocking: return 200 with empty body so Claude continues with default behavior
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    // Build hook response based on tool type and user decision
    let hookResponse;
    if (toolName === 'AskUserQuestion') {
      hookResponse = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: {
            questions: toolInput?.questions || [],
            answers: decision.answers || {},
          },
        },
      };
    } else if (toolName === 'ExitPlanMode') {
      if (decision.decision === 'deny') {
        hookResponse = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason
              ? `User rejected the plan: ${decision.reason}`
              : 'User rejected the plan.',
          },
        };
      } else {
        hookResponse = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        };
      }
    } else {
      hookResponse = {};
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(hookResponse));
    return;
  }

  // ---- Internal report submission endpoint (called by MCP server) ----
  // No auth required: only reachable from 127.0.0.1
  if (pathname === '/api/internal/report' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 65536); } catch { body = '{}'; }
    let data;
    try { data = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { title, file_path: filePath, session_id: sessionId, source } = data;
    // Permission check: only whitelisted folders
    const REPORT_WHITELIST = process.env.REPORT_WHITELIST ? process.env.REPORT_WHITELIST.split(',') : [];
    if (sessionId) {
      const session = getSession(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      if (!REPORT_WHITELIST.some(w => session.folder === w || session.folder.startsWith(w + '/'))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Permission denied: workspace "${session.folder}" not authorized for report submission. Allowed: ${REPORT_WHITELIST.join(', ')}` }));
        return;
      }
    }

    try {
      const session = sessionId ? getSession(sessionId) : null;
      const report = createReport({
        title,
        filePath,
        sessionId,
        sessionFolder: session?.folder || null,
        source: source || 'unknown',
      });
      // Broadcast to all connected WebSocket clients
      broadcastReportNew(report);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, reportId: report.id, report }));
    } catch (err) {
      console.warn(`[router] report submission failed: ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Auth required from here on
  if (!requireAuth(req, res)) return;

  // ---- API endpoints ----

  if (pathname === '/api/sessions' && req.method === 'GET') {
    const sessionList = listSessions().filter(s => !s.hidden);
    const folderFilter = parsedUrl.query.folder;
    const filtered = folderFilter
      ? sessionList.filter(s => s.folder === folderFilter)
      : sessionList;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: filtered }));
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 10240); } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        console.warn('[router] 413 POST /api/sessions body too large');
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }
      throw err;
    }
    try {
      const { folder, tool, name } = JSON.parse(body);
      if (!folder || !tool) {
        console.warn('[router] 400 POST /api/sessions missing folder or tool');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder and tool are required' }));
        return;
      }
      const resolvedFolder = folder.startsWith('~')
        ? join(homedir(), folder.slice(1))
        : resolve(folder);
      if (!existsSync(resolvedFolder) || !statSync(resolvedFolder).isDirectory()) {
        console.warn(`[router] 400 POST /api/sessions folder not found: ${resolvedFolder}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Folder does not exist' }));
        return;
      }
      const session = createSession(resolvedFolder, tool, name || '');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
    const id = pathname.split('/').pop();
    const ok = deleteSession(id);
    if (ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      console.warn(`[router] 404 DELETE /api/sessions/${id} not found`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
    return;
  }

  // ---- Session sub-routes: /api/sessions/{id}, /api/sessions/{id}/history, /api/sessions/{id}/messages ----
  const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9]+)(\/(\w+))?$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    const subRoute = sessionMatch[3];

    if (!subRoute && req.method === 'GET') {
      const session = getSession(id);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
      return;
    }

    if (subRoute === 'history' && req.method === 'GET') {
      const session = getSession(id);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const events = getHistory(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session, events }));
      return;
    }

    if (subRoute === 'messages' && req.method === 'POST') {
      const session = getSession(id);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      let body;
      try { body = await readBody(req, 65536); } catch (err) {
        if (err.code === 'BODY_TOO_LARGE') {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
          return;
        }
        throw err;
      }
      try {
        const { text, images, tool, thinking, model, report_to } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'text is required' }));
          return;
        }
        sendMessage(id, text.trim(), images, { tool, thinking: !!thinking, model });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionId: id, status: 'running' }));

        // Server-side report_to: persisted watcher survives both Claude Code and chat-server restarts
        if (report_to) {
          registerReportTo(id, report_to);
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
      return;
    }
  }

  // ---- Session Labels API ----

  // PATCH /api/sessions/{id}/label — set or clear session label
  const labelMatch = pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/label$/);
  if (labelMatch && req.method === 'PATCH') {
    const id = labelMatch[1];
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const { label } = JSON.parse(body);
      const updated = setSessionLabel(id, label || null);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: updated }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  // PATCH /api/sessions/{id}/archive — archive or unarchive a session
  const archiveMatch = pathname.match(/^\/api\/sessions\/([a-f0-9]+)\/archive$/);
  if (archiveMatch && req.method === 'PATCH') {
    const id = archiveMatch[1];
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const { archived } = JSON.parse(body);
      const updated = archiveSession(id, !!archived);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: updated }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname === '/api/session-labels' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ labels: getLabels() }));
    return;
  }

  if (pathname === '/api/session-labels' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const { name, color } = JSON.parse(body);
      if (!name || !color) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name and color are required' }));
        return;
      }
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const label = addLabel({ id, name, color });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ label }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  const labelIdMatch = pathname.match(/^\/api\/session-labels\/([a-z0-9-]+)$/);
  if (labelIdMatch && req.method === 'DELETE') {
    const ok = removeLabel(labelIdMatch[1]);
    if (ok) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Label not found' }));
    }
    return;
  }

  if (labelIdMatch && req.method === 'PUT') {
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const updates = JSON.parse(body);
      const updated = updateLabel(labelIdMatch[1], updates);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Label not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ label: updated }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  // POST /api/restart — restart the chat server
  if (pathname === '/api/restart' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const triggerSessionId = body.session_id || null;
      restartServer(triggerSessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Server restarting...' }));
    } catch {
      restartServer(null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Server restarting...' }));
    }
    return;
  }

  // GET /api/folders — list folders with session counts
  if (pathname === '/api/folders' && req.method === 'GET') {
    const allSessions = listSessions().filter(s => !s.hidden);
    const folderMap = new Map();
    for (const s of allSessions) {
      if (!folderMap.has(s.folder)) folderMap.set(s.folder, []);
      folderMap.get(s.folder).push(s);
    }
    const folders = Array.from(folderMap.entries()).map(([folder, sess]) => ({
      folder,
      sessionCount: sess.length,
      sessions: sess.map(s => ({ id: s.id, name: s.name, tool: s.tool, status: s.status, created: s.created })),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ folders }));
    return;
  }

  // GET /api/folders/:folder/files — recursive file tree
  const filesMatch = pathname.match(/^\/api\/folders\/([^/]+)\/files$/);
  if (filesMatch && req.method === 'GET') {
    const folderPath = decodeURIComponent(filesMatch[1]);
    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Folder not found' }));
      return;
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache', 'build', 'coverage', 'out']);
    const SKIP_FILES = new Set(['.DS_Store']);
    const MAX_DEPTH = 10;
    const MAX_FILE_SIZE = 5 * 1024 * 1024;

    async function buildTree(dir, depth) {
      if (depth > MAX_DEPTH) return [];
      const entries = await readdir(dir, { withFileTypes: true });
      const results = [];
      for (const entry of entries) {
        const name = entry.name;
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          const children = await buildTree(join(dir, name), depth + 1);
          results.push({ name, type: 'dir', children });
        } else if (entry.isFile()) {
          if (SKIP_FILES.has(name) || name.endsWith('.lock')) continue;
          try {
            const st = await stat(join(dir, name));
            if (st.size > MAX_FILE_SIZE) continue;
            results.push({ name, type: 'file', size: st.size });
          } catch { continue; }
        }
      }
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return results;
    }

    try {
      const tree = await buildTree(folderPath, 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tree }));
    } catch (err) {
      console.error(`[router] file tree error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file tree' }));
    }
    return;
  }

  // GET /api/folders/:folder/file?path=<relative> — read single file
  const fileMatch = pathname.match(/^\/api\/folders\/([^/]+)\/file$/);
  if (fileMatch && req.method === 'GET') {
    const folderPath = decodeURIComponent(fileMatch[1]);
    const relPath = parsedUrl.query.path || '';

    if (!relPath || relPath.startsWith('/') || relPath.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }

    const fullPath = resolve(folderPath, relPath);
    if (!fullPath.startsWith(folderPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path traversal denied' }));
      return;
    }

    try {
      if (!existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
      }
      const st = statSync(fullPath);
      if (st.size > 1024 * 1024) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large', size: st.size }));
        return;
      }
      const content = readFileSync(fullPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content, size: st.size }));
    } catch (err) {
      console.error(`[router] file read error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file' }));
    }
    return;
  }

  // PUT /api/folders/:folder/file — write file
  const filePutMatch = pathname.match(/^\/api\/folders\/([^/]+)\/file$/);
  if (filePutMatch && req.method === 'PUT') {
    const folderPath = decodeURIComponent(filePutMatch[1]);
    let body;
    try { body = JSON.parse(await readBody(req, 1.5 * 1024 * 1024)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const relPath = body.path || '';
    const content = body.content;

    if (!relPath || relPath.startsWith('/') || relPath.includes('..')) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }

    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Content too large (max 1MB)' }));
      return;
    }

    const fullPath = resolve(folderPath, relPath);
    if (!fullPath.startsWith(folderPath)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Path traversal denied' }));
      return;
    }

    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error(`[router] file write error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to write file' }));
    }
    return;
  }

  // ---- Git API ----

  const gitMatch = pathname.match(/^\/api\/folders\/([^/]+)\/git\/(\w+)$/);
  if (gitMatch) {
    const folderPath = decodeURIComponent(gitMatch[1]);
    const action = gitMatch[2];

    if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Folder not found' }));
      return;
    }

    const jsonReply = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    const BRANCH_RE = /^[a-zA-Z0-9._\/-]+$/;
    const REF_RE = /^[a-zA-Z0-9^~._\/-]+$/;

    function validateFilePath(folderPath, relPath) {
      if (!relPath || relPath.includes('..')) return null;
      const full = resolve(folderPath, relPath);
      if (!full.startsWith(folderPath)) return null;
      return full;
    }

    try {
      // GET /git/status
      if (action === 'status' && req.method === 'GET') {
        const [porcelain, branchRaw] = await Promise.all([
          runGit(['status', '--porcelain=v1'], folderPath),
          runGit(['rev-parse', '--abbrev-ref', 'HEAD'], folderPath),
        ]);
        const branch = branchRaw.trim();
        const files = [];
        for (const line of porcelain.split('\n').filter(Boolean)) {
          const x = line[0]; // index (staging area) status
          const y = line[1]; // worktree status
          const path = line.slice(3);
          // A file can appear in both staged and unstaged if it has changes in both areas (e.g. "MM")
          if (x !== ' ' && x !== '?') {
            files.push({ status: x, path, staged: true });
          }
          if (y !== ' ' && x === '?') {
            // Untracked file (??)
            files.push({ status: '?', path, staged: false });
          } else if (y !== ' ') {
            // Unstaged working tree changes
            files.push({ status: y, path, staged: false });
          } else if (x !== ' ' && x !== '?' && y === ' ') {
            // Only staged, no unstaged counterpart — already added above
          }
        }
        // Get ahead/behind tracking info
        let ahead = null, behind = null, tracking = null;
        try {
          const trackBranch = (await runGit(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], folderPath)).trim();
          if (trackBranch) {
            tracking = trackBranch;
            const counts = (await runGit(['rev-list', '--left-right', '--count', `HEAD...@{upstream}`], folderPath)).trim();
            const [a, b] = counts.split(/\s+/);
            ahead = parseInt(a, 10) || 0;
            behind = parseInt(b, 10) || 0;
          }
        } catch { /* no upstream tracking */ }
        jsonReply(200, { files, branch, clean: files.length === 0, ahead, behind, tracking });
        return;
      }

      // GET /git/diff?file=<path>&staged=true
      if (action === 'diff' && req.method === 'GET') {
        const file = parsedUrl.query.file || '';
        const staged = parsedUrl.query.staged === 'true';
        const args = ['diff'];
        if (staged) args.push('--cached');
        if (file) {
          if (!validateFilePath(folderPath, file)) {
            jsonReply(403, { error: 'Invalid file path' });
            return;
          }
          args.push('--', file);
        }
        const diff = await runGit(args, folderPath);
        jsonReply(200, { diff });
        return;
      }

      // POST /git/stage
      if (action === 'stage' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.all) {
          await runGit(['add', '-A'], folderPath);
        } else if (Array.isArray(body.files) && body.files.length > 0) {
          for (const f of body.files) {
            if (!validateFilePath(folderPath, f)) {
              jsonReply(403, { error: `Invalid file path: ${f}` });
              return;
            }
          }
          await runGit(['add', '--', ...body.files], folderPath);
        } else {
          jsonReply(400, { error: 'Provide files array or all:true' });
          return;
        }
        jsonReply(200, { ok: true });
        return;
      }

      // POST /git/unstage
      if (action === 'unstage' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!Array.isArray(body.files) || body.files.length === 0) {
          jsonReply(400, { error: 'Provide files array' });
          return;
        }
        for (const f of body.files) {
          if (!validateFilePath(folderPath, f)) {
            jsonReply(403, { error: `Invalid file path: ${f}` });
            return;
          }
        }
        await runGit(['reset', 'HEAD', '--', ...body.files], folderPath);
        jsonReply(200, { ok: true });
        return;
      }

      // POST /git/commit
      if (action === 'commit' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const msg = (body.message || '').trim();
        if (!msg || msg.length > 1000) {
          jsonReply(400, { error: 'Message required (max 1000 chars)' });
          return;
        }
        const out = await runGit(['commit', '-m', msg], folderPath);
        const hashMatch = out.match(/\[[\w\-/.]+ ([a-f0-9]+)\]/);
        jsonReply(200, { ok: true, hash: hashMatch ? hashMatch[1] : null });
        return;
      }

      // GET /git/log?limit=20
      if (action === 'log' && req.method === 'GET') {
        let limit = parseInt(parsedUrl.query.limit, 10) || 20;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;
        const out = await runGit(['log', `--format=%H|%h|%an|%ae|%at|%s`, `-n`, String(limit)], folderPath);
        const commits = out.split('\n').filter(Boolean).map(line => {
          const [hash, short, author, email, date, ...rest] = line.split('|');
          return { hash, short, author, email, date: parseInt(date, 10), message: rest.join('|') };
        });
        jsonReply(200, { commits });
        return;
      }

      // GET /git/branches
      if (action === 'branches' && req.method === 'GET') {
        const fmt = '%(refname:short)|%(objectname:short)|%(HEAD)|%(subject)|%(authordate:unix)|%(authorname)|%(upstream:short)|%(upstream:track)';
        const out = await runGit(['branch', '-a', '--format=' + fmt], folderPath);
        const branches = out.split('\n').filter(Boolean).map(line => {
          const parts = line.split('|');
          const name = parts[0];
          const short = parts[1];
          const isCurrent = parts[2]?.trim() === '*';
          const message = parts[3] || '';
          const date = parseInt(parts[4], 10) || 0;
          const author = parts[5] || '';
          const tracking = parts[6] || '';
          const trackInfo = parts.slice(7).join('|') || '';
          let ahead = 0, behind = 0;
          const aheadMatch = trackInfo.match(/ahead (\d+)/);
          const behindMatch = trackInfo.match(/behind (\d+)/);
          if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
          if (behindMatch) behind = parseInt(behindMatch[1], 10);
          const isRemote = name.includes('/') && !name.startsWith('refs/') && /^[^/]+\//.test(name) && !isCurrent && !tracking;
          const entry = { name, short, current: isCurrent, message, date, author };
          if (isRemote) {
            entry.remote = true;
          } else {
            if (tracking) entry.tracking = tracking;
            entry.ahead = ahead;
            entry.behind = behind;
          }
          return entry;
        });
        const current = branches.find(b => b.current)?.name || '';
        jsonReply(200, { current, branches });
        return;
      }

      // POST /git/checkout
      if (action === 'checkout' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const branch = (body.branch || '').trim();
        if (!branch || !BRANCH_RE.test(branch)) {
          jsonReply(400, { error: 'Invalid branch name' });
          return;
        }
        await runGit(['checkout', branch], folderPath);
        jsonReply(200, { ok: true });
        return;
      }

      // POST /git/pull
      if (action === 'pull' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req).catch(() => '{}'));
        const args = ['pull'];
        if (body.rebase) args.push('--rebase');
        else args.push('--no-rebase');
        const output = await runGit(args, folderPath, { timeout: 30000 });
        jsonReply(200, { ok: true, output: output.trim() });
        return;
      }

      // POST /git/push
      if (action === 'push' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req).catch(() => '{}'));
        const args = ['push'];
        if (body.force) args.push('--force-with-lease');
        const output = await runGit(args, folderPath, { timeout: 30000 });
        jsonReply(200, { ok: true, output: output.trim() });
        return;
      }

      // GET /git/remote
      if (action === 'remote' && req.method === 'GET') {
        const output = await runGit(['remote', '-v'], folderPath);
        const seen = new Set();
        const remotes = output.split('\n').filter(Boolean).reduce((acc, line) => {
          const parts = line.split(/\s+/);
          const key = parts[0];
          if (!seen.has(key)) { seen.add(key); acc.push({ name: parts[0], url: parts[1] }); }
          return acc;
        }, []);
        jsonReply(200, { remotes });
        return;
      }

      jsonReply(404, { error: `Unknown git action: ${action}` });
    } catch (err) {
      console.error(`[router] git ${action} error:`, err.message);
      jsonReply(500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = getAvailableTools();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const tool = parsedUrl.query.tool || '';
    if (tool === 'codex') {
      try {
        const cacheFile = join(homedir(), '.codex', 'models_cache.json');
        const configFile = join(homedir(), '.codex', 'config.toml');
        const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
        const models = (cache.models || [])
          .filter(m => m.visibility !== 'hidden')
          .map(m => ({ id: m.slug, name: m.display_name }));
        // Read default model from config.toml
        let defaultModel = models[0]?.id;
        if (existsSync(configFile)) {
          const configText = readFileSync(configFile, 'utf8');
          const match = configText.match(/^model\s*=\s*"([^"]+)"/m);
          if (match) defaultModel = match[1];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models, default: defaultModel }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
    }
    return;
  }

  if (pathname === '/api/sidebar' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSidebarState()));
    return;
  }

  // ---- Reports API ----

  if (pathname === '/api/reports' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listReports()));
    return;
  }

  // Report sub-routes: /api/reports/{id}, /api/reports/{id}/html, /api/reports/{id}/read
  const reportMatch = pathname.match(/^\/api\/reports\/([a-f0-9]+)(\/(\w+))?$/);
  if (reportMatch) {
    const id = reportMatch[1];
    const sub = reportMatch[3];

    if (!sub && req.method === 'GET') {
      const report = getReport(id);
      if (!report) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Report not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
      return;
    }

    if (sub === 'html' && req.method === 'GET') {
      const html = getReportHtml(id);
      if (html === null) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Report not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob:"
      });
      const injected = html.replace(/(<head\b[^>]*>)/i, '$1<base target="_blank">');
      res.end(injected);
      return;
    }

    if (sub === 'read' && req.method === 'PATCH') {
      const updated = markAsRead(id);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Report not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
      return;
    }

    if (!sub && req.method === 'DELETE') {
      const ok = deleteReport(id);
      if (!ok) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Report not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
  }

  // Quick replies per folder
  if (pathname === '/api/quick-replies' && req.method === 'GET') {
    const folder = parsedUrl.query.folder || '';
    let data = {};
    try { data = JSON.parse(readFileSync(QUICK_REPLIES_FILE, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') console.warn('[router] Failed to parse config file:', err.message); }
    const buttons = data[folder] || data.__default__ || ['Continue', 'Agree', 'Commit this', 'Run tests', 'Show diff'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ buttons, isDefault: !data[folder] }));
    return;
  }

  if (pathname === '/api/quick-replies' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const { folder, buttons } = JSON.parse(body);
      if (!folder || !Array.isArray(buttons)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder and buttons[] required' }));
        return;
      }
      let data = {};
      try { data = JSON.parse(readFileSync(QUICK_REPLIES_FILE, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') console.warn('[router] Failed to parse config file:', err.message); }
      data[folder] = buttons.map(b => String(b).slice(0, 100)).slice(0, 20);
      writeFileSync(QUICK_REPLIES_FILE, JSON.stringify(data, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
    return;
  }

  if (pathname === '/api/ui-settings' && req.method === 'GET') {
    let data = {};
    try { data = JSON.parse(readFileSync(UI_SETTINGS_FILE, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') console.warn('[router] Failed to parse config file:', err.message); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (pathname === '/api/ui-settings' && req.method === 'PATCH') {
    let body;
    try { body = await readBody(req, 65536); } catch { body = '{}'; }
    try {
      const patch = JSON.parse(body);
      let data = {};
      try { data = JSON.parse(readFileSync(UI_SETTINGS_FILE, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') console.warn('[router] Failed to parse config file:', err.message); }
      Object.assign(data, patch);
      writeFileSync(UI_SETTINGS_FILE, JSON.stringify(data, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid body' }));
    }
    return;
  }

  if (pathname === '/api/autocomplete' && req.method === 'GET') {
    const query = parsedUrl.query.q || '';
    const suggestions = [];
    try {
      const resolvedQuery = query.startsWith('~') ? join(homedir(), query.slice(1)) : query;
      const parentDir = dirname(resolvedQuery);
      const prefix = basename(resolvedQuery);
      if (existsSync(parentDir) && statSync(parentDir).isDirectory()) {
        for (const entry of readdirSync(parentDir)) {
          if (!prefix.startsWith('.') && entry.startsWith('.')) continue;
          const fullPath = join(parentDir, entry);
          if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
            if (entry.toLowerCase().startsWith(prefix.toLowerCase())) {
              suggestions.push(fullPath);
            }
          }
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions: suggestions.slice(0, 20) }));
    return;
  }

  if (pathname === '/api/browse' && req.method === 'GET') {
    const pathQuery = parsedUrl.query.path || '~';
    try {
      const resolvedPath = pathQuery === '~' || pathQuery === ''
        ? homedir()
        : pathQuery.startsWith('~')
          ? join(homedir(), pathQuery.slice(1))
          : resolve(pathQuery);
      const children = [];
      let parent = null;
      if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
        const parentPath = dirname(resolvedPath);
        parent = parentPath !== resolvedPath ? parentPath : null;
        for (const entry of readdirSync(resolvedPath)) {
          if (entry.startsWith('.')) continue;
          const fullPath = join(resolvedPath, entry);
          try {
            if (statSync(fullPath).isDirectory()) children.push({ name: entry, path: fullPath });
          } catch {}
        }
        children.sort((a, b) => a.name.localeCompare(b.name));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: resolvedPath, parent, children }));
    } catch (err) {
      console.error(`[router] 500 GET /api/browse path=${pathQuery}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to browse directory' }));
    }
    return;
  }

  // Serve uploaded images
  if (pathname.startsWith('/api/images/') && req.method === 'GET') {
    const filename = pathname.slice('/api/images/'.length);
    // Sanitize: only allow alphanumeric, dash, underscore, dot
    if (!/^[a-zA-Z0-9_-]+\.[a-z]+$/.test(filename)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid filename');
      return;
    }
    const filepath = join(CHAT_IMAGES_DIR, filename);
    if (!existsSync(filepath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = filename.split('.').pop();
    const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(readFileSync(filepath));
    return;
  }

  // File upload — saves to {session.folder}/shared/{filename}
  if (pathname === '/api/upload' && req.method === 'POST') {
    const sessionId = parsedUrl.query.sessionId;
    const rawName = parsedUrl.query.name || 'upload';

    const session = getSession(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    // Sanitize: strip directory components, replace unsafe chars
    const safeName = basename(rawName).replace(/[^\w.\- ]/g, '_').slice(0, 255);
    if (!safeName || safeName === '.' || safeName === '..') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid filename' }));
      return;
    }

    const uploadDir = join(session.folder, 'shared');
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });
    const targetPath = join(uploadDir, safeName);

    // Path traversal guard: resolved target must stay inside session.folder
    const resolvedTarget = resolve(targetPath);
    const resolvedFolder = resolve(session.folder);
    if (!resolvedTarget.startsWith(resolvedFolder + '/') && resolvedTarget !== resolvedFolder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid path' }));
      return;
    }

    let body;
    try {
      body = await readBodyBinary(req, 52428800); // 50 MB limit
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large (max 50 MB)' }));
        return;
      }
      throw err;
    }

    writeFileSync(targetPath, body);
    console.log(`[router] upload saved: ${resolvedTarget} (${body.length} bytes)`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: resolvedTarget, filename: safeName }));
    return;
  }

  // Reports list page
  if (pathname === '/reports') {
    try {
      let reportsPage = readFileSync(reportsTemplatePath, 'utf8');
      reportsPage = reportsPage.replace(/\{\{NONCE\}\}/g, nonce);
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(reportsPage);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load reports page');
    }
    return;
  }

  // Single report page — serve full HTML with injected nav bar
  const reportPageMatch = pathname.match(/^\/reports\/([a-f0-9]+)$/);
  if (reportPageMatch) {
    const id = reportPageMatch[1];
    const report = getReport(id);
    if (!report) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Report not found');
      return;
    }
    let html = getReportHtml(id);
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Report file not found');
      return;
    }
    // Mark as read
    markAsRead(id);
    // Inject sticky nav bar after <body>
    const title = report.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const navHtml = `<div id="report-nav" style="position:sticky;top:0;z-index:9999;background:#ffffff;border-bottom:1px solid #dfe6e9;padding:10px 20px;display:flex;align-items:center;gap:16px;font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;color:#2d3436;"><a href="/reports" style="color:#002fa7;text-decoration:none;font-weight:500;">← Reports</a><span style="color:#636e72;">|</span><span style="color:#636e72;">${title}</span></div>`;
    html = html.replace(/(<body\b[^>]*>)/i, `$1${navHtml}`);
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data: blob:",
    });
    res.end(html);
    return;
  }

  // Main page (chat UI) — read from disk each time for hot-reload
  if (pathname === '/') {
    try {
      let chatPage = readFileSync(chatTemplatePath, 'utf8');
      // Inject content hash into JS src for cache-busting
      const chatJs = readFileSync(join(staticDir, 'chat.js'));
      const jsHash = createHash('md5').update(chatJs).digest('hex').slice(0, 8);
      chatPage = chatPage
        .replace(/\{\{NONCE\}\}/g, nonce)
        .replace('/chat.js"', `/chat.js?v=${jsHash}"`);
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(chatPage);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load chat page');
    }
    return;
  }

  // ---- Workflow / Scheduler API ----

  // GET /api/workflows — list workflow definitions
  if (pathname === '/api/workflows' && req.method === 'GET') {
    try {
      const workflowsDir = join(__dirname, '..', 'workflows');
      const files = existsSync(workflowsDir)
        ? readdirSync(workflowsDir).filter(f => f.endsWith('.json') && f !== 'schedules.json')
        : [];
      const workflows = files.map(f => {
        try { return JSON.parse(readFileSync(join(workflowsDir, f), 'utf8')); } catch (err) { console.error('[router] Failed to parse workflow file:', f, err.message); return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ workflows }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/schedules — list schedules with lastRun
  if (pathname === '/api/schedules' && req.method === 'GET') {
    try {
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/workflow-runs — list recent 10 run records
  if (pathname === '/api/workflow-runs' && req.method === 'GET') {
    const runs = listWorkflowRuns(10);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runs }));
    return;
  }

  // GET /api/workflow-runs/:runId — read a single run's meta.json
  const runDetailMatch = pathname.match(/^\/api\/workflow-runs\/([a-f0-9]+)$/);
  if (runDetailMatch && req.method === 'GET') {
    const [, runId] = runDetailMatch;
    const runsDir = join(homedir(), '.config', 'claude-web', 'workflow-runs');
    const metaFile = join(runsDir, runId, 'meta.json');
    if (!existsSync(metaFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Run not found' }));
      return;
    }
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(meta));
    return;
  }

  // GET /api/workflow-runs/:runId/task/:taskId — read task output text
  const taskOutputMatch = pathname.match(/^\/api\/workflow-runs\/([a-f0-9]+)\/task\/([^/]+)$/);
  if (taskOutputMatch && req.method === 'GET') {
    const [, runId, taskId] = taskOutputMatch;
    const runsDir = join(homedir(), '.config', 'claude-web', 'workflow-runs');
    const taskFile = join(runsDir, runId, `${taskId}.txt`);
    if (!existsSync(taskFile)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task output not found' }));
      return;
    }
    const text = readFileSync(taskFile, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
    return;
  }

  // POST /api/schedules/:id/trigger — manually trigger a workflow
  const triggerMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/trigger$/);
  if (triggerMatch && req.method === 'POST') {
    const scheduleId = triggerMatch[1];
    try {
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      const schedule = data.schedules.find(s => s.id === scheduleId);
      if (!schedule) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Schedule not found' }));
        return;
      }
      // Update lastRun immediately (same behavior as auto cron trigger)
      updateLastRun(scheduleId);
      // Pre-generate runId so we can return it immediately before the workflow finishes
      const runId = randomBytes(8).toString('hex');
      const runPromise = executeWorkflow(schedule.workflow, {
        schedule,
        runId,
        inlineWorkflow: schedule.inlineWorkflow || null,
      });
      runPromise
        .then(() => console.log(`[router] Manual trigger run=${runId} completed`))
        .catch(err => console.error(`[router] Manual trigger failed: ${err.message}`));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, runId, workflow: schedule.workflow, status: 'triggered' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/schedules/:id/reload — tell scheduler to pick up a new/changed schedule
  const scheduleReloadMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/reload$/);
  if (scheduleReloadMatch && req.method === 'POST') {
    reloadSchedule(scheduleReloadMatch[1]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // PATCH /api/schedules/:id — update schedule attributes
  const schedulePatchMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
  if (schedulePatchMatch && req.method === 'PATCH') {
    const scheduleId = schedulePatchMatch[1];
    let body;
    try { body = await readBody(req, 4096); } catch { body = '{}'; }
    try {
      const updates = JSON.parse(body);
      const schedulesFile = join(__dirname, '..', 'workflows', 'schedules.json');
      const data = existsSync(schedulesFile)
        ? JSON.parse(readFileSync(schedulesFile, 'utf8'))
        : { schedules: [] };
      const schedule = data.schedules.find(s => s.id === scheduleId);
      if (!schedule) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Schedule not found' }));
        return;
      }
      // Allow updating only specific fields
      const ALLOWED = ['enabled', 'maxRuns', 'disposable', 'intervalMs'];
      for (const key of ALLOWED) {
        if (updates[key] !== undefined) schedule[key] = updates[key];
      }
      // Atomic write
      const tmp = schedulesFile + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, schedulesFile);

      // If enabled changed, reload this schedule's timer
      if (updates.enabled !== undefined) {
        reloadSchedule(scheduleId);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schedule }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Invalid request body' }));
    }
    return;
  }

  // ---- Task API ----

  // GET /api/tasks — list tasks (filter: ?status=&assigned_session_id=)
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const filters = {};
    if (parsedUrl.query.status) filters.status = parsedUrl.query.status;
    if (parsedUrl.query.assigned_session_id) filters.assigned_session_id = parsedUrl.query.assigned_session_id;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks: listTasks(filters) }));
    return;
  }

  // POST /api/tasks — create task
  if (pathname === '/api/tasks' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req, 16384)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    if (!body.subject) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'subject is required' }));
      return;
    }
    const task = createTask({
      subject: body.subject,
      description: body.description,
      assigned_session_id: body.assigned_session_id,
      blocked_by: Array.isArray(body.blocked_by) ? body.blocked_by : [],
      report_to: body.report_to || null,
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task }));
    return;
  }

  // GET /api/tasks/:id
  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskIdMatch && req.method === 'GET') {
    const task = getTask(taskIdMatch[1]);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task }));
    return;
  }

  // PATCH /api/tasks/:id — update task
  if (taskIdMatch && req.method === 'PATCH') {
    let body;
    try { body = JSON.parse(await readBody(req, 16384)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    const ALLOWED_UPDATES = ['subject', 'description', 'status', 'assigned_session_id', 'blocked_by'];
    const updates = {};
    for (const key of ALLOWED_UPDATES) {
      if (body[key] !== undefined) updates[key] = body[key];
    }
    const task = updateTask(taskIdMatch[1], updates);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task }));
    return;
  }

  // DELETE /api/tasks/:id
  if (taskIdMatch && req.method === 'DELETE') {
    const deleted = deleteTask(taskIdMatch[1]);
    if (!deleted) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Task not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  console.warn(`[router] 404 ${req.method} ${pathname}`);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
