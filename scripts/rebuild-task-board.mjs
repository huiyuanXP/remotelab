#!/usr/bin/env node
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { AUTH_FILE, CHAT_PORT } from '../lib/config.mjs';
import { readJson } from '../chat/fs-utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  const trimmed = trimString(value);
  if (!trimmed) {
    return `http://127.0.0.1:${CHAT_PORT}`;
  }
  return trimmed.replace(/\/+$/, '');
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: '',
    sessionId: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--base-url' && argv[index + 1]) {
      parsed.baseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--session' && argv[index + 1]) {
      parsed.sessionId = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

async function requestJson(baseUrl, pathname, { method = 'GET', cookie = '', body } = {}) {
  const headers = {
    Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  };
  let payload;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(new URL(pathname, normalizeBaseUrl(baseUrl)).toString(), {
    method,
    headers,
    body: payload,
    redirect: 'manual',
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { response, text, json };
}

async function authenticateOwner(baseUrl) {
  const auth = await readJson(AUTH_FILE, null);
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`Missing owner token in ${AUTH_FILE}`);
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    method: 'GET',
    redirect: 'manual',
  });
  const cookie = trimString(response.headers.get('set-cookie'))
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('session_token='));
  if (!cookie) {
    throw new Error(`Owner auth failed (${response.status})`);
  }
  return cookie;
}

function printTaskBoardSummary(result, mode) {
  const taskBoard = result?.taskBoard || {};
  const columns = Array.isArray(taskBoard.columns) ? taskBoard.columns : [];
  const tasks = Array.isArray(taskBoard.tasks) ? taskBoard.tasks : [];
  console.log(`task board rebuild mode: ${mode}`);
  console.log(`ok: ${result?.ok === true}`);
  if (result?.sourceSessionId) {
    console.log(`source session: ${result.sourceSessionId}`);
  }
  if (result?.skipped) {
    console.log(`skipped: ${result.skipped}`);
  }
  if (result?.error) {
    console.log(`error: ${result.error}`);
  }
  if (columns.length === 0) {
    console.log('columns: (none)');
  } else {
    console.log('columns:');
    for (const column of columns) {
      console.log(`- ${column.label} [${column.key}]`);
    }
  }
  if (tasks.length === 0) {
    console.log('tasks: (none)');
    return;
  }
  console.log('tasks:');
  for (const task of tasks) {
    console.log(`- ${task.title} [${task.id}]${task.projectLabel ? ` — ${task.projectLabel}` : ''}`);
  }
}

async function rebuildViaApi(baseUrl, sessionId = '') {
  const cookie = await authenticateOwner(baseUrl);
  const result = await requestJson(baseUrl, '/api/task-board/rebuild', {
    method: 'POST',
    cookie,
    body: sessionId ? { sessionId } : {},
  });
  if (!result.response.ok || !result.json) {
    throw new Error(result.json?.error || result.text || `Task board rebuild failed (${result.response.status})`);
  }
  return result.json;
}

async function rebuildDirectly(sessionId = '') {
  const sessionManager = await import(
    pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
  );
  try {
    return await sessionManager.rebuildTaskBoardState({ sessionId });
  } finally {
    if (typeof sessionManager.killAll === 'function') {
      sessionManager.killAll();
    }
  }
}

try {
  const { baseUrl, sessionId } = parseArgs(process.argv);
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);

  try {
    const result = await rebuildViaApi(resolvedBaseUrl, sessionId);
    printTaskBoardSummary(result, 'api');
  } catch (error) {
    console.warn(`api rebuild failed, falling back to direct mode: ${error.message}`);
    const result = await rebuildDirectly(sessionId);
    printTaskBoardSummary(result, 'direct');
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
