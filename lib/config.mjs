import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, renameSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

function validPort(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function validMs(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export const LISTEN_PORT = validPort(process.env.LISTEN_PORT, 7681);
export const TTYD_PORT = validPort(process.env.TTYD_PORT, 7682); // legacy, kept for reference
export const TTYD_PORT_RANGE_START = validPort(process.env.TTYD_PORT_RANGE_START, 7700);
export const TTYD_PORT_RANGE_END = validPort(process.env.TTYD_PORT_RANGE_END, 7799);
export const SESSION_EXPIRY = validMs(
  process.env.SESSION_EXPIRY,
  60 * 1000,          // min: 1 minute
  30 * 24 * 60 * 60 * 1000, // max: 30 days
  24 * 60 * 60 * 1000  // default: 24 hours
);
export const SECURE_COOKIES = process.env.SECURE_COOKIES !== '0';

const oldConfigDir = join(homedir(), '.config', 'claude-web');
const newConfigDir = join(homedir(), '.config', 'remotelab');

// One-time migration: rename old config dir to new
if (existsSync(oldConfigDir) && !existsSync(newConfigDir)) {
  try {
    renameSync(oldConfigDir, newConfigDir);
    console.log(`[config] Migrated ${oldConfigDir} → ${newConfigDir}`);
  } catch (err) {
    console.error(`[config] Migration failed: ${err.message}, using old path`);
  }
}

const configDir = existsSync(newConfigDir) ? newConfigDir : (existsSync(oldConfigDir) ? oldConfigDir : newConfigDir);
if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

export const CHAT_PORT = validPort(process.env.CHAT_PORT, 7690);

export const AUTH_FILE = join(configDir, 'auth.json');
export const SESSIONS_FILE = join(configDir, 'sessions.json');
export const TOOLS_FILE = join(configDir, 'tools.json');
export const AUTH_SESSIONS_FILE = join(configDir, 'auth-sessions.json');
export const SOCKET_DIR = join(configDir, 'sockets');
export const CHAT_SESSIONS_FILE = join(configDir, 'chat-sessions.json');
export const CHAT_HISTORY_DIR = join(configDir, 'chat-history');
export const CHAT_IMAGES_DIR = join(configDir, 'images');
export const CHAT_SHARE_SNAPSHOTS_DIR = join(configDir, 'shared-snapshots');
export const SIDEBAR_STATE_FILE = join(configDir, 'sidebar-state.json');
export const VAPID_KEYS_FILE = join(configDir, 'vapid-keys.json');
export const PUSH_SUBSCRIPTIONS_FILE = join(configDir, 'push-subscriptions.json');
export const CHAT_SETTINGS_FILE = join(configDir, 'chat-settings.json');
export const APPS_FILE = join(configDir, 'apps.json');

// RemoteLab memory directories (model-managed persistent storage)
// User-level: private to this machine (preferences, local paths, personal habits)
export const MEMORY_DIR = join(homedir(), '.remotelab', 'memory');
// System-level: universal learnings stored in the code repo (shared across deployments)
export const SYSTEM_MEMORY_DIR = join(PROJECT_ROOT, 'memory');
