#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { TOOLS_FILE } from '../lib/config.mjs';

const HOME = homedir();
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = join(HOME, '.config', 'remotelab', 'doubao-fast-agent.json');
const DEFAULT_AIDER_ENV_PATH = join(HOME, '.config', 'aider', 'doubao.env');
const DEFAULT_MODEL = 'doubao-seed-2-0-pro-260215';
const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_TOOL_ID = 'doubao-fast';
const DEFAULT_TOOL_NAME = 'Doubao Fast Agent';
const COMMAND_PATH = join(REPO_ROOT, 'scripts', 'doubao-fast-agent.mjs');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printUsage(exitCode = 0, errorMessage = '') {
  const output = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }
  output(`Usage:
  node scripts/install-doubao-fast-agent.mjs [options]

Options:
  --api-key <key>          Doubao / Ark API key
  --base-url <url>         OpenAI-compatible Ark base URL (default: ${DEFAULT_BASE_URL})
  --model <id>             Model id or endpoint id (default: ${DEFAULT_MODEL})
  --config <path>          Config output path (default: ${DEFAULT_CONFIG_PATH})
  --tool-id <id>           RemoteLab tool id (default: ${DEFAULT_TOOL_ID})
  --tool-name <name>       RemoteLab tool label (default: ${DEFAULT_TOOL_NAME})
  -h, --help               Show this help

If no api key is passed, the installer checks env vars and then:
  ${DEFAULT_AIDER_ENV_PATH}
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const result = {
    apiKey: '',
    baseUrl: '',
    model: '',
    configPath: '',
    toolId: DEFAULT_TOOL_ID,
    toolName: DEFAULT_TOOL_NAME,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--api-key':
        result.apiKey = argv[index + 1] || '';
        index += 1;
        break;
      case '--base-url':
        result.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--model':
        result.model = argv[index + 1] || '';
        index += 1;
        break;
      case '--config':
        result.configPath = argv[index + 1] || '';
        index += 1;
        break;
      case '--tool-id':
        result.toolId = argv[index + 1] || DEFAULT_TOOL_ID;
        index += 1;
        break;
      case '--tool-name':
        result.toolName = argv[index + 1] || DEFAULT_TOOL_NAME;
        index += 1;
        break;
      case '-h':
      case '--help':
        printUsage(0);
        break;
      default:
        break;
    }
  }
  return result;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseEnvLine(rawValue) {
  const trimmed = trimString(rawValue);
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadAiderEnvFallback() {
  if (!(await pathExists(DEFAULT_AIDER_ENV_PATH))) return {};
  const raw = await readFile(DEFAULT_AIDER_ENV_PATH, 'utf8');
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = trimString(line);
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = trimString(trimmed.slice(0, separatorIndex));
    const value = parseEnvLine(trimmed.slice(separatorIndex + 1));
    values[key] = value;
  }
  return values;
}

async function loadToolsFile() {
  try {
    const raw = await readFile(TOOLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveToolsFile(tools) {
  await mkdir(dirname(TOOLS_FILE), { recursive: true });
  await writeFile(TOOLS_FILE, `${JSON.stringify(tools, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const aiderEnv = await loadAiderEnvFallback();
  const configPath = trimString(args.configPath) || DEFAULT_CONFIG_PATH;
  const apiKey = trimString(args.apiKey)
    || trimString(process.env.DOUBAO_API_KEY)
    || trimString(process.env.ARK_API_KEY)
    || trimString(aiderEnv.DOUBAO_API_KEY);
  const baseUrl = trimString(args.baseUrl)
    || trimString(process.env.DOUBAO_API_BASE)
    || trimString(process.env.ARK_API_BASE)
    || trimString(aiderEnv.DOUBAO_API_BASE)
    || DEFAULT_BASE_URL;
  const model = trimString(args.model)
    || trimString(process.env.DOUBAO_MODEL)
    || trimString(process.env.ARK_MODEL)
    || trimString(aiderEnv.DOUBAO_MODEL)
    || DEFAULT_MODEL;

  if (!apiKey) {
    printUsage(1, 'Missing api key. Pass --api-key or configure ~/.config/aider/doubao.env first.');
  }

  const config = {
    apiKey,
    baseUrl,
    model,
    maxIterations: 2,
    requestTimeoutMs: 20000,
    bashTimeoutMs: 12000,
    maxToolOutputChars: 12000,
    maxDirectoryEntries: 200,
    maxToolCallsPerTurn: 4,
    tools: {
      bash: true,
      list_dir: true,
      read_file: true,
      clipboard_read: true,
      clipboard_write: true,
      open_app: true,
      notify: true,
    },
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await chmod(configPath, 0o600);
  await chmod(COMMAND_PATH, 0o755).catch(() => {});

  const tools = await loadToolsFile();
  const record = {
    id: trimString(args.toolId) || DEFAULT_TOOL_ID,
    name: trimString(args.toolName) || DEFAULT_TOOL_NAME,
    visibility: 'private',
    command: COMMAND_PATH,
    runtimeFamily: 'claude-stream-json',
    promptMode: 'bare-user',
    flattenPrompt: true,
    models: [
      {
        id: model,
        label: 'Doubao Seed 2.0 Pro',
      },
    ],
    reasoning: {
      kind: 'toggle',
      label: 'Thinking',
    },
  };

  const existingIndex = tools.findIndex((tool) => tool?.id === record.id || tool?.command === record.command);
  if (existingIndex >= 0) {
    tools[existingIndex] = record;
  } else {
    tools.push(record);
  }
  await saveToolsFile(tools);

  console.log('Installed Doubao Fast Agent.');
  console.log(`- Config: ${configPath}`);
  console.log(`- Tool id: ${record.id}`);
  console.log(`- Command: ${record.command}`);
  console.log(`- Model: ${model}`);
}

await main();
