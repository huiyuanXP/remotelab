#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { AUTH_FILE } from '../lib/config.mjs';
import {
  APPROVED_QUEUE,
  DEFAULT_ROOT_DIR,
  DEFAULT_AUTOMATION_SETTINGS,
  buildEmailThreadExternalTriggerId,
  buildThreadReferencesHeader,
  decodeMaybeEncodedMailboxText,
  extractNormalizedMailboxContent,
  loadMailboxAutomation,
  listQueue,
  updateQueueItem,
} from '../lib/agent-mailbox.mjs';
import { loadUiRuntimeSelection } from '../lib/runtime-selection.mjs';

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith('--') ? true : nextToken;
    if (value !== true) {
      index += 1;
    }
    options[key] = value;
  }

  return { positional, options };
}

function optionValue(options, key, fallbackValue = undefined) {
  const value = options[key];
  return value === undefined ? fallbackValue : value;
}

function nowIso() {
  return new Date().toISOString();
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function printUsage() {
  console.log(`Usage:
  node scripts/agent-mail-worker.mjs [--root <dir>] [--chat-base-url <url>] [--interval-ms <ms>] [--once]

Examples:
  node scripts/agent-mail-worker.mjs --once
  node scripts/agent-mail-worker.mjs --interval-ms 5000`);
}

function readOwnerToken() {
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  if (!normalized) {
    throw new Error('chat base URL is required');
  }
  return normalized.replace(/\/+$/, '');
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to chat server at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

function createRemoteLabRuntime(baseUrl) {
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    authToken: '',
    authCookie: '',
  };
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (!forceRefresh && runtime.authCookie) {
    return runtime.authCookie;
  }
  if (forceRefresh) {
    runtime.authCookie = '';
    runtime.authToken = '';
  }
  if (!runtime.authToken) {
    runtime.authToken = typeof runtime.readOwnerToken === 'function'
      ? await runtime.readOwnerToken()
      : readOwnerToken();
  }
  const login = typeof runtime.loginWithToken === 'function' ? runtime.loginWithToken : loginWithToken;
  runtime.authCookie = await login(runtime.baseUrl, runtime.authToken);
  return runtime.authCookie;
}

async function requestRemoteLab(runtime, path, options = {}) {
  const request = typeof runtime.requestJson === 'function' ? runtime.requestJson : requestJson;
  const cookie = await ensureAuthCookie(runtime, false);
  let result = await request(runtime.baseUrl, path, { ...options, cookie });
  if ([401, 403].includes(result.response?.status)) {
    const refreshedCookie = await ensureAuthCookie(runtime, true);
    result = await request(runtime.baseUrl, path, { ...options, cookie: refreshedCookie });
  }
  return result;
}

function buildReplySubject(subject) {
  const trimmed = trimString(subject);
  if (!trimmed) return '';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function buildSessionName(item) {
  const subject = trimString(item?.message?.subject);
  const sender = trimString(item?.message?.fromAddress);
  if (subject) return subject;
  if (sender) return sender;
  return '';
}

function buildSessionDescription(item, fallbackDescription) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const fallback = trimString(fallbackDescription);
  return trimString(`Inbound email${sender ? ` from ${sender}` : ''}${subject ? ` about ${subject}` : ''}`) || fallback;
}

function extractReadableBodyFromRaw(item) {
  const rawPath = trimString(item?.storage?.rawPath);
  if (!rawPath) {
    return '';
  }

  try {
    const normalized = extractNormalizedMailboxContent({
      rawMessage: readFileSync(rawPath, 'utf8'),
    });
    return trimString(normalized.messageText) || trimString(normalized.previewText);
  } catch {
    return '';
  }
}

function buildReplyPrompt(item) {
  const sender = trimString(item?.message?.fromAddress);
  const subject = trimString(item?.message?.subject);
  const date = trimString(item?.message?.date);
  const messageId = trimString(item?.message?.messageId);
  const rawDerivedBody = extractReadableBodyFromRaw(item);
  const bodySource = trimString(item?.content?.extractedText) || trimString(item?.content?.preview);
  const decodedStoredBody = decodeMaybeEncodedMailboxText(bodySource, {
    contentType: trimString(item?.message?.headers?.['content-type']) || 'text/plain; charset=UTF-8',
    transferEncoding: trimString(item?.message?.headers?.['content-transfer-encoding']),
  });
  const body = rawDerivedBody || decodedStoredBody;

  return [
    'Inbound email.',
    `- From: ${sender || '(unknown sender)'}`,
    `- Subject: ${subject || '(no subject)'}`,
    `- Date: ${date || '(no date)'}`,
    `- Message-ID: ${messageId || '(no message id)'}`,
    '',
    'User message:',
    body || '(empty body)',
  ].join('\n');
}

function hasExplicitPinnedRuntime(automation) {
  const session = automation?.session || {};
  return trimString(session.tool) && trimString(session.tool) !== DEFAULT_AUTOMATION_SETTINGS.session.tool
    || !!trimString(session.model)
    || !!trimString(session.effort)
    || session.thinking === true;
}

function resolveReplyRuntimeSelection(automation, uiSelection) {
  const session = automation?.session || {};
  const pinned = hasExplicitPinnedRuntime(automation);
  const selectedTool = trimString(uiSelection?.selectedTool);
  const selectedModel = trimString(uiSelection?.selectedModel);
  const selectedEffort = trimString(uiSelection?.selectedEffort);
  const reasoningKind = trimString(uiSelection?.reasoningKind).toLowerCase();
  const defaultTool = trimString(DEFAULT_AUTOMATION_SETTINGS.session.tool) || 'codex';
  const fallbackTool = trimString(session.tool) || defaultTool;
  const effectiveTool = pinned
    ? fallbackTool
    : selectedTool || fallbackTool || defaultTool;
  const uiMatchesEffectiveTool = !!selectedTool && selectedTool === effectiveTool;

  return {
    tool: effectiveTool || defaultTool,
    model: pinned
      ? trimString(session.model)
      : (uiMatchesEffectiveTool ? selectedModel : ''),
    effort: pinned
      ? trimString(session.effort)
      : (uiMatchesEffectiveTool && reasoningKind === 'enum' ? selectedEffort : ''),
    thinking: pinned
      ? session.thinking === true
      : (uiMatchesEffectiveTool && reasoningKind === 'toggle' && uiSelection?.thinkingEnabled === true),
  };
}

function buildCompletionTarget(item, rootDir, requestId) {
  const messageId = trimString(item?.message?.messageId);
  const inReplyTo = trimString(item?.message?.inReplyTo);
  const references = trimString(item?.message?.replyReferences)
    || buildThreadReferencesHeader({
      messageId,
      inReplyTo,
      references: trimString(item?.message?.references),
    });
  return {
    id: `mailbox_email_${item.id}`,
    type: 'email',
    requestId,
    to: trimString(item?.message?.fromAddress),
    subject: buildReplySubject(item?.message?.subject),
    inReplyTo: messageId,
    references,
    mailboxRoot: rootDir,
    mailboxItemId: item.id,
  };
}

function shouldProcessItem(item) {
  const status = trimString(item?.status);
  const automationStatus = trimString(item?.automation?.status);
  if (!trimString(item?.message?.fromAddress)) return false;
  if (status === 'reply_sent' || automationStatus === 'reply_sent') return false;
  if (status === 'processing_for_reply' || automationStatus === 'processing_for_reply') return false;
  if (status === 'reply_failed' || automationStatus === 'reply_failed') return false;
  return true;
}

async function submitApprovedItem(item, rootDir, automation, runtime) {
  const requestId = trimString(item?.automation?.requestId) || `mailbox_reply_${item.id}`;
  const externalTriggerId = trimString(item?.message?.externalTriggerId)
    || buildEmailThreadExternalTriggerId({
      messageId: trimString(item?.message?.messageId),
      inReplyTo: trimString(item?.message?.inReplyTo),
      references: trimString(item?.message?.references),
    })
    || `mailbox:${item.id}`;
  const completionTarget = buildCompletionTarget(item, rootDir, requestId);
  const uiSelection = await loadUiRuntimeSelection();
  const runtimeSelection = resolveReplyRuntimeSelection(automation, uiSelection);
  const sessionPayload = {
    folder: automation.session.folder,
    tool: runtimeSelection.tool,
    name: buildSessionName(item),
    appId: 'email',
    appName: 'Email',
    sourceId: 'email',
    sourceName: 'Email',
    group: automation.session.group,
    description: buildSessionDescription(item, automation.session.description),
    systemPrompt: automation.session.systemPrompt,
    completionTargets: [completionTarget],
    externalTriggerId,
  };

  const createResult = await requestRemoteLab(runtime, '/api/sessions', {
    method: 'POST',
    body: sessionPayload,
  });
  if (!createResult.response.ok || !createResult.json?.session?.id) {
    throw new Error(createResult.json?.error || createResult.text || `Failed to create session (${createResult.response.status})`);
  }

  const session = createResult.json.session;
  const messagePayload = {
    requestId,
    text: buildReplyPrompt(item),
    tool: runtimeSelection.tool,
  };
  if (runtimeSelection.thinking) {
    messagePayload.thinking = true;
  }
  if (runtimeSelection.model) {
    messagePayload.model = runtimeSelection.model;
  }
  if (runtimeSelection.effort) {
    messagePayload.effort = runtimeSelection.effort;
  }

  const submitResult = await requestRemoteLab(runtime, `/api/sessions/${session.id}/messages`, {
    method: 'POST',
    body: messagePayload,
  });
  if (![200, 202].includes(submitResult.response.status) || !submitResult.json?.run?.id) {
    throw new Error(submitResult.json?.error || submitResult.text || `Failed to submit session message (${submitResult.response.status})`);
  }

  const run = submitResult.json.run;
  updateQueueItem(item.id, rootDir, (draft) => {
    draft.status = 'processing_for_reply';
    draft.automation = {
      ...(draft.automation || {}),
      status: 'processing_for_reply',
      sessionId: session.id,
      runId: run.id,
      requestId,
      externalTriggerId,
      submittedAt: draft.automation?.submittedAt || nowIso(),
      duplicate: submitResult.json?.duplicate === true,
      lastError: null,
      updatedAt: nowIso(),
    };
    return draft;
  });

  return {
    itemId: item.id,
    sessionId: session.id,
    runId: run.id,
    duplicate: submitResult.json?.duplicate === true,
  };
}

async function runSweep({ rootDir, baseUrl, runtime = createRemoteLabRuntime(baseUrl) }) {
  const automation = loadMailboxAutomation(rootDir);
  if (automation.enabled === false) {
    return {
      processed: 0,
      skipped: 0,
      failures: [],
      reason: 'automation_disabled',
    };
  }

  const approvedItems = listQueue(APPROVED_QUEUE, rootDir).filter(shouldProcessItem);
  const successes = [];
  const failures = [];

  for (const item of approvedItems) {
    try {
      successes.push(await submitApprovedItem(item, rootDir, automation, runtime));
    } catch (error) {
      updateQueueItem(item.id, rootDir, (draft) => {
        draft.status = 'reply_failed';
        draft.automation = {
          ...(draft.automation || {}),
          status: 'reply_failed',
          requestId: trimString(draft.automation?.requestId) || `mailbox_reply_${item.id}`,
          lastError: error.message,
          updatedAt: nowIso(),
        };
        return draft;
      });
      failures.push({ itemId: item.id, error: error.message });
    }
  }

  return {
    processed: successes.length,
    skipped: listQueue(APPROVED_QUEUE, rootDir).length - approvedItems.length,
    successes,
    failures,
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (positional[0] === 'help' || options.help || options.h) {
    printUsage();
    return;
  }

  const rootDir = optionValue(options, 'root', DEFAULT_ROOT_DIR);
  const automation = loadMailboxAutomation(rootDir);
  const baseUrl = optionValue(options, 'chat-base-url', automation.chatBaseUrl);
  const intervalMs = Math.max(1000, parseInt(optionValue(options, 'interval-ms', '5000'), 10) || 5000);
  const once = optionValue(options, 'once', false) === true;
  const runtime = createRemoteLabRuntime(baseUrl);

  if (once) {
    console.log(JSON.stringify(await runSweep({ rootDir, baseUrl, runtime }), null, 2));
    return;
  }

  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runSweep({ rootDir, baseUrl, runtime });
      if (summary.processed > 0 || summary.failures.length > 0) {
        console.log(JSON.stringify(summary, null, 2));
      }
    } catch (error) {
      console.error(`[agent-mail-worker] ${error.message}`);
    } finally {
      running = false;
    }
  };

  await loop();
  setInterval(loop, intervalMs);
}

export {
  createRemoteLabRuntime,
  ensureAuthCookie,
  requestRemoteLab,
  runSweep,
};

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
