import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { CHAT_HISTORY_DIR } from '../lib/config.mjs';

function ensureDir() {
  if (!existsSync(CHAT_HISTORY_DIR)) {
    mkdirSync(CHAT_HISTORY_DIR, { recursive: true });
  }
}

function historyPath(sessionId) {
  return join(CHAT_HISTORY_DIR, `${sessionId}.json`);
}

export function loadHistory(sessionId) {
  try {
    const p = historyPath(sessionId);
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

export function saveHistory(sessionId, events) {
  ensureDir();
  writeFileSync(historyPath(sessionId), JSON.stringify(events, null, 2), 'utf8');
}

export function appendEvent(sessionId, event) {
  const events = loadHistory(sessionId);
  events.push(event);
  saveHistory(sessionId, events);
  return events;
}

export function clearHistory(sessionId) {
  ensureDir();
  writeFileSync(historyPath(sessionId), '[]', 'utf8');
}
