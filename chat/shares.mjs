import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CHAT_IMAGES_DIR, CHAT_SHARE_SNAPSHOTS_DIR } from '../lib/config.mjs';

function ensureSharesDir() {
  if (!existsSync(CHAT_SHARE_SNAPSHOTS_DIR)) {
    mkdirSync(CHAT_SHARE_SNAPSHOTS_DIR, { recursive: true });
  }
}

function shareSnapshotPath(id) {
  return join(CHAT_SHARE_SNAPSHOTS_DIR, `${id}.json`);
}

function generateShareId() {
  return 'snap_' + randomBytes(24).toString('hex');
}

function readImageBase64(image) {
  if (!image || typeof image !== 'object') return null;
  if (typeof image.data === 'string' && image.data) return image.data;

  const filename = typeof image.filename === 'string' ? image.filename : null;
  const candidates = [];
  if (typeof image.savedPath === 'string' && image.savedPath) {
    candidates.push(image.savedPath);
  }
  if (filename) {
    candidates.push(join(CHAT_IMAGES_DIR, filename));
  }

  for (const filepath of candidates) {
    try {
      if (existsSync(filepath)) {
        return readFileSync(filepath).toString('base64');
      }
    } catch {}
  }

  return null;
}

function sanitizeImage(image) {
  const data = readImageBase64(image);
  if (!data) return null;
  return {
    filename: typeof image?.filename === 'string' ? image.filename : undefined,
    mimeType: typeof image?.mimeType === 'string' && image.mimeType ? image.mimeType : 'image/png',
    data,
  };
}

function sanitizeMessageEvent(event) {
  const snapshot = {
    type: 'message',
    id: event.id,
    timestamp: event.timestamp,
    role: event.role,
    content: typeof event.content === 'string' ? event.content : '',
  };
  if (Array.isArray(event.images) && event.images.length > 0) {
    const images = event.images.map(sanitizeImage).filter(Boolean);
    if (images.length > 0) snapshot.images = images;
  }
  return snapshot;
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;

  switch (event.type) {
    case 'message':
      return sanitizeMessageEvent(event);
    case 'tool_use':
      return {
        type: 'tool_use',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
        toolInput: typeof event.toolInput === 'string' ? event.toolInput : '',
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        toolName: typeof event.toolName === 'string' ? event.toolName : '',
        output: typeof event.output === 'string' ? event.output : '',
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : undefined,
      };
    case 'file_change':
      return {
        type: 'file_change',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        filePath: typeof event.filePath === 'string' ? event.filePath : '',
        changeType: typeof event.changeType === 'string' ? event.changeType : '',
      };
    case 'reasoning':
    case 'status':
      return {
        type: event.type,
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        content: typeof event.content === 'string' ? event.content : '',
      };
    case 'usage':
      return {
        type: 'usage',
        id: event.id,
        timestamp: event.timestamp,
        role: event.role,
        inputTokens: Number.isFinite(event.inputTokens) ? event.inputTokens : 0,
        outputTokens: Number.isFinite(event.outputTokens) ? event.outputTokens : 0,
      };
    default:
      return null;
  }
}

function sanitizeSession(session) {
  return {
    name: typeof session?.name === 'string' ? session.name : '',
    tool: typeof session?.tool === 'string' ? session.tool : '',
    created: typeof session?.created === 'string' ? session.created : null,
  };
}

export function createShareSnapshot(session, history) {
  ensureSharesDir();

  const id = generateShareId();
  const createdAt = new Date().toISOString();
  const events = Array.isArray(history)
    ? history.map(sanitizeEvent).filter(Boolean)
    : [];

  const snapshot = {
    version: 1,
    id,
    createdAt,
    session: sanitizeSession(session),
    events,
  };

  writeFileSync(shareSnapshotPath(id), JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshot;
}

export function getShareSnapshot(id) {
  if (!id || typeof id !== 'string' || !/^snap_[a-f0-9]{48}$/.test(id)) return null;
  try {
    const filepath = shareSnapshotPath(id);
    if (!existsSync(filepath)) return null;
    const snapshot = JSON.parse(readFileSync(filepath, 'utf8'));
    if (!snapshot || snapshot.id !== id || !Array.isArray(snapshot.events)) return null;
    return snapshot;
  } catch {
    return null;
  }
}
