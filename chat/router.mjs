import { existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { parse as parseUrl, fileURLToPath } from 'url';
import { SESSION_EXPIRY, CHAT_IMAGES_DIR } from '../lib/config.mjs';
import {
  sessions, saveAuthSessions,
  verifyToken, verifyPassword, generateToken,
  parseCookies, setCookie, clearCookie,
} from '../lib/auth.mjs';
import { getAvailableTools } from '../lib/tools.mjs';
import { listSessions, getSession, createSession, deleteSession, receiveHookRequest } from './session-manager.mjs';
import { getSidebarState } from './summarizer.mjs';
import { readBody, readBodyBinary } from '../lib/utils.mjs';
import {
  getClientIp, isRateLimited, recordFailedAttempt, clearFailedAttempts,
  setSecurityHeaders, generateNonce, requireAuth,
} from './middleware.mjs';

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
      res.writeHead(200, { 'Content-Type': staticMimeTypes[staticName], 'Cache-Control': 'no-cache' });
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
    res.writeHead(200, { 'Content-Type': 'text/html' });
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
    const sessionList = listSessions();
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
      const { folder, tool } = JSON.parse(body);
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
      const session = createSession(resolvedFolder, tool);
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

  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = getAvailableTools();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools }));
    return;
  }

  if (pathname === '/api/sidebar' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSidebarState()));
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
      const chatPage = readFileSync(chatTemplatePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(chatPage.replace(/\{\{NONCE\}\}/g, nonce));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load chat page');
    }
    return;
  }

  console.warn(`[router] 404 ${req.method} ${pathname}`);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}
