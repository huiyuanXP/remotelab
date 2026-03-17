import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
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
import { listSessions, getSession, createSession, deleteSession, sendMessage, getHistory, waitForIdle, receiveHookRequest, getLabels, addLabel, removeLabel, updateLabel, setSessionLabel, archiveSession, restartServer } from './session-manager.mjs';
import { executeWorkflow, listWorkflowRuns } from './workflow-engine.mjs';
import { getSidebarState } from './summarizer.mjs';
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

// Paths (files are read from disk on each request for hot-reload)
const __dirname = dirname(fileURLToPath(import.meta.url));
const chatTemplatePath = join(__dirname, '..', 'templates', 'chat.html');
const loginTemplatePath = join(__dirname, '..', 'templates', 'login.html');
const staticDir = join(__dirname, '..', 'static');

const staticMimeTypes = {
  'manifest.json': 'application/manifest+json',
  'icon.svg': 'image/svg+xml',
  'apple-touch-icon.png': 'image/png',
  'chat.js': 'application/javascript',
  'marked.min.js': 'application/javascript',
};

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

  // Quick replies per folder
  if (pathname === '/api/quick-replies' && req.method === 'GET') {
    const folder = parsedUrl.query.folder || '';
    let data = {};
    try { data = JSON.parse(readFileSync(QUICK_REPLIES_FILE, 'utf8')); } catch {}
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
      try { data = JSON.parse(readFileSync(QUICK_REPLIES_FILE, 'utf8')); } catch {}
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
    try { data = JSON.parse(readFileSync(UI_SETTINGS_FILE, 'utf8')); } catch {}
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
      try { data = JSON.parse(readFileSync(UI_SETTINGS_FILE, 'utf8')); } catch {}
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
        try { return JSON.parse(readFileSync(join(workflowsDir, f), 'utf8')); } catch { return null; }
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
      // Fire-and-forget; return run ID immediately
      const runPromise = executeWorkflow(schedule.workflow);
      runPromise
        .then(({ runId }) => console.log(`[router] Manual trigger run=${runId} completed`))
        .catch(err => console.error(`[router] Manual trigger failed: ${err.message}`));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, workflow: schedule.workflow, status: 'triggered' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  console.warn(`[router] 404 ${req.method} ${pathname}`);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
