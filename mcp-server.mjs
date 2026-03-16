#!/usr/bin/env node
/**
 * RemoteLab MCP Server
 *
 * Exposes RemoteLab session management as MCP tools over stdio transport.
 * Communicates with the chat-server via HTTP API on localhost.
 *
 * Usage:
 *   node mcp-server.mjs
 *
 * Environment variables:
 *   CHAT_PORT  — chat-server port (default: 7690)
 *
 * The server reads the auth token from ~/.config/claude-web/auth.json automatically.
 */

import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import http from 'http';

const AUTH_FILE = join(homedir(), '.config', 'claude-web', 'auth.json');
const CHAT_PORT = parseInt(process.env.CHAT_PORT, 10) || 7690;
const BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const MY_SESSION_ID = process.env.REMOTELAB_SESSION_ID || null;

// ---- Auth token ----

let authToken;
try {
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  authToken = auth.token;
} catch (err) {
  process.stderr.write(`[mcp] Failed to read auth token from ${AUTH_FILE}: ${err.message}\n`);
  process.exit(1);
}

// ---- HTTP client ----

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---- MCP stdio transport (newline-delimited JSON-RPC 2.0) ----

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleMessage(msg).catch(err => {
      process.stderr.write(`[mcp] handleMessage error: ${err.message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[mcp] Failed to parse: ${err.message}\n`);
  }
});

rl.on('close', () => {
  process.exit(0);
});

function sendResponse(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

/**
 * Send an MCP logging notification (server → client).
 * Used to report async session completion.
 */
function sendNotification(level, data) {
  sendResponse({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level, logger: 'remotelab', data },
  });
}

// ---- Background session watchers ----

// sessionId → { eventCountBefore, sessionName }
const activeWatchers = new Map();

async function watchSession(sessionId, eventCountBefore, sessionName, reportToSessionId = null) {
  if (activeWatchers.has(sessionId)) return; // already watching
  activeWatchers.set(sessionId, { eventCountBefore, sessionName });

  const maxWait = 30 * 60 * 1000; // 30 minutes
  const pollInterval = 3000;
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      if (!activeWatchers.has(sessionId)) return; // was cancelled

      const statusRes = await apiRequest('GET', `/api/sessions/${sessionId}`);
      if (statusRes.status !== 200) continue;
      if (statusRes.data.session?.status !== 'idle') continue;

      // Session finished — build compact notification
      const label = sessionName || sessionId.slice(0, 8);
      const firstMsg = await getOriginalFirstMessage(sessionId);
      const lastMsg = await getLastAssistantMessage(sessionId);

      const parts = [`[Session "${label}" completed]`];
      if (firstMsg) parts.push(`[Task] ${firstMsg}`);
      if (lastMsg) parts.push(`[Result] ${lastMsg}`);

      sendNotification('info', parts.join('\n'));

      if (reportToSessionId) {
        const reportText = `[子任务完成汇报]\n${parts.join('\n')}`;
        try {
          await apiRequest('POST', `/api/sessions/${reportToSessionId}/messages`, { text: reportText });
        } catch (err) {
          sendNotification('error', `[report_to failed] ${err.message}`);
        }
      }

      break;
    }
  } catch (err) {
    sendNotification('error', `[Session watcher error] ${sessionId.slice(0, 8)}: ${err.message}`);
  } finally {
    activeWatchers.delete(sessionId);
  }
}

/**
 * Trace back through compact chain to find the original first user message.
 */
async function getOriginalFirstMessage(sessionId) {
  let currentId = sessionId;
  const visited = new Set();

  // Follow continuedFrom chain to the root session
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const sessRes = await apiRequest('GET', `/api/sessions/${currentId}`);
    if (sessRes.status !== 200) break;
    const prev = sessRes.data.session?.continuedFrom;
    if (!prev) break;
    currentId = prev;
  }

  // Get the first user message from the root session
  const histRes = await apiRequest('GET', `/api/sessions/${currentId}/history`);
  if (histRes.status !== 200) return null;
  const events = histRes.data.events || [];
  const first = events.find(e => e.type === 'message' && e.role === 'user');
  return first?.content || null;
}

/**
 * Get the last assistant message from a session's history.
 */
async function getLastAssistantMessage(sessionId) {
  const histRes = await apiRequest('GET', `/api/sessions/${sessionId}/history`);
  if (histRes.status !== 200) return null;
  const events = histRes.data.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'message' && events[i].role === 'assistant') {
      return events[i].content;
    }
  }
  return null;
}

// ---- MCP Tool definitions ----

const TOOLS = [
  {
    name: 'list_folders',
    description: 'List all project folders that have RemoteLab sessions, with session counts and session details for each folder.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_sessions',
    description: 'List all sessions, optionally filtered by folder path.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Filter by folder path (exact match). If omitted, returns all sessions.' },
      },
      required: [],
    },
  },
  {
    name: 'get_session',
    description: 'Get details of a specific session including its id, folder, tool, name, status, and creation time.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID (hex string).' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_session_history',
    description: 'Get the full message/event history of a session. Events include user messages, assistant messages, tool uses, tool results, file changes, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'create_session',
    description: 'Create a new session in a project folder with a specific CLI tool (e.g. "claude", "codex").',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Project folder path. Supports ~ for home directory.' },
        tool: { type: 'string', description: 'CLI tool to use (e.g. "claude", "codex").' },
        name: { type: 'string', description: 'Session name/label for easy identification.' },
      },
      required: ['folder', 'tool'],
    },
  },
  {
    name: 'delete_session',
    description: 'Delete a session. If the session has a running process, it will be cancelled first.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to delete.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to an AI session (fire-and-forget). The message is dispatched to the CLI tool and this returns immediately. When the session finishes, a notification is automatically sent back with the results. Set wait=true to block until the response is ready instead. Optionally set report_to to automatically send results back to another session when done.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to send the message to.' },
        text: { type: 'string', description: 'The message text to send.' },
        wait: { type: 'boolean', description: 'If true, block until session finishes and return results directly. Default: false (async with notification).' },
        tool: { type: 'string', description: 'Override the CLI tool for this message (e.g. "claude", "codex").' },
        thinking: { type: 'boolean', description: 'Enable extended thinking mode.' },
        model: { type: 'string', description: 'Override the model to use.' },
        report_to: { type: 'string', description: 'Session ID to report back to when this session completes. The result will be sent as a chat message to that session, waking it up if idle or interrupting if busy.' },
      },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'list_tools',
    description: 'List available CLI tools that can be used when creating sessions (e.g. claude, codex).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_label',
    description: 'Set a custom label/status on a session (e.g. "planned", "pending-review", "done"). If session_id is omitted, sets the label on the current session (self). Set label to null or omit it to clear.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session ID to label. If omitted, labels the current session (self).' },
        label: { type: 'string', description: 'Label ID to set (e.g. "planned", "pending-review", "done"). Omit or set to null to clear the label.' },
      },
      required: [],
    },
  },
  {
    name: 'list_labels',
    description: 'List all available session labels with their names and colors.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---- Tool execution ----

async function executeTool(name, args) {
  switch (name) {
    case 'list_folders': {
      const res = await apiRequest('GET', '/api/folders');
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'list_sessions': {
      const path = args.folder ? `/api/sessions?folder=${encodeURIComponent(args.folder)}` : '/api/sessions';
      const res = await apiRequest('GET', path);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'get_session': {
      const res = await apiRequest('GET', `/api/sessions/${args.session_id}`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'get_session_history': {
      const res = await apiRequest('GET', `/api/sessions/${args.session_id}/history`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'create_session': {
      const body = { folder: args.folder, tool: args.tool };
      if (args.name) body.name = args.name;
      const res = await apiRequest('POST', '/api/sessions', body);
      if (res.status !== 201) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'delete_session': {
      const res = await apiRequest('DELETE', `/api/sessions/${args.session_id}`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'send_message': {
      const wait = args.wait === true; // default false (async)

      // Snapshot current event count before sending
      let eventCountBefore = 0;
      const histRes = await apiRequest('GET', `/api/sessions/${args.session_id}/history`);
      if (histRes.status === 200 && histRes.data.events) {
        eventCountBefore = histRes.data.events.length;
      }

      // Get session name for notification label
      let sessionName = '';
      const sessRes = await apiRequest('GET', `/api/sessions/${args.session_id}`);
      if (sessRes.status === 200) {
        sessionName = sessRes.data.session?.name || '';
      }

      // Send the message (include report_to so chat-server handles the callback server-side)
      const body = { text: args.text };
      if (args.tool) body.tool = args.tool;
      if (args.thinking) body.thinking = true;
      if (args.model) body.model = args.model;
      const effectiveReportTo = args.report_to || MY_SESSION_ID;
      if (effectiveReportTo) body.report_to = effectiveReportTo;

      const res = await apiRequest('POST', `/api/sessions/${args.session_id}/messages`, body);
      if (res.status !== 202) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };

      if (!wait) {
        // Async: start background watcher, return immediately
        watchSession(args.session_id, eventCountBefore, sessionName, args.report_to || MY_SESSION_ID);
        return { content: [{ type: 'text', text: `Message dispatched to session "${sessionName || args.session_id.slice(0, 8)}". You will receive a notification when it completes.` }] };
      }

      // Sync: poll until session goes idle (max 10 minutes)
      const maxWait = 10 * 60 * 1000;
      const pollInterval = 2000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        const statusRes = await apiRequest('GET', `/api/sessions/${args.session_id}`);
        if (statusRes.status !== 200) continue;
        if (statusRes.data.session?.status === 'idle') break;
      }

      // Fetch new events
      const finalHist = await apiRequest('GET', `/api/sessions/${args.session_id}/history`);
      if (finalHist.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${finalHist.status}: ${JSON.stringify(finalHist.data)}` }] };

      const newEvents = finalHist.data.events.slice(eventCountBefore);
      const summary = formatEvents(newEvents);
      return { content: [{ type: 'text', text: summary }] };
    }

    case 'list_tools': {
      const res = await apiRequest('GET', '/api/tools');
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'set_label': {
      const targetId = args.session_id || MY_SESSION_ID;
      if (!targetId) return { isError: true, content: [{ type: 'text', text: 'No session_id provided and no current session ID available (REMOTELAB_SESSION_ID not set).' }] };
      const res = await apiRequest('PATCH', `/api/sessions/${targetId}/label`, { label: args.label || null });
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'list_labels': {
      const res = await apiRequest('GET', '/api/session-labels');
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
}

/**
 * Format events into a readable summary for the MCP client.
 */
function formatEvents(events) {
  if (!events || events.length === 0) return '(no new events)';

  const parts = [];
  for (const evt of events) {
    switch (evt.type) {
      case 'message':
        parts.push(`[${evt.role}] ${evt.content}`);
        break;
      case 'toolUse':
        parts.push(`[tool_use: ${evt.toolName}] ${(evt.content || '').slice(0, 500)}`);
        break;
      case 'toolResult':
        parts.push(`[tool_result: ${evt.toolName}] ${(evt.content || '').slice(0, 1000)}`);
        break;
      case 'fileChange':
        parts.push(`[file_change: ${evt.filePath}] ${evt.changeType || ''}`);
        break;
      case 'status':
        parts.push(`[status] ${evt.content}`);
        break;
      case 'usage':
        parts.push(`[usage] input=${evt.inputTokens || 0} output=${evt.outputTokens || 0} cache_read=${evt.cacheReadTokens || 0}`);
        break;
      default:
        parts.push(`[${evt.type}] ${evt.content || JSON.stringify(evt).slice(0, 200)}`);
    }
  }
  return parts.join('\n');
}

// ---- MCP message handler ----

async function handleMessage(msg) {
  // Notifications (no id) — just acknowledge
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  switch (msg.method) {
    case 'initialize': {
      sendResult(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
          logging: {},
        },
        serverInfo: {
          name: 'remotelab',
          version: '1.0.0',
        },
      });
      break;
    }

    case 'tools/list': {
      sendResult(msg.id, { tools: TOOLS });
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      try {
        const result = await executeTool(name, args || {});
        sendResult(msg.id, result);
      } catch (err) {
        process.stderr.write(`[mcp] tool error: ${err.message}\n`);
        sendResult(msg.id, {
          isError: true,
          content: [{ type: 'text', text: `Tool execution failed: ${err.message}` }],
        });
      }
      break;
    }

    case 'ping': {
      sendResult(msg.id, {});
      break;
    }

    default: {
      sendError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
}

process.stderr.write(`[mcp] RemoteLab MCP server started (chat-server: ${BASE_URL})\n`);
