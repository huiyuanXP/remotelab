#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const { selectAssistantReplyEvent } = await import(pathToFileURL(join(repoRoot, 'lib', 'reply-selection.mjs')).href);

const {
  DEFAULT_SESSION_SYSTEM_PROMPT,
  createRuntimeContext,
  buildRemoteLabMessage,
  compileFeishuReplyText,
  ensureAuthCookie,
  ensureAllowedSendersFile,
  extractLocalCommand,
  generateRemoteLabReply,
  handleChatMemberUserAdded,
  handleMessage,
  isAllowedByPolicy,
  loadConfig,
  loadPersistedAccessState,
  normalizeReplyText,
  summarizeChatMemberUserAddedEvent,
  summarizeEvent,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'feishu-connector.mjs')).href);

const runtime = {
  processingMessageIds: new Set(),
  storagePaths: {
    handledMessagesPath: '/tmp/remotelab-feishu-connector-test-handled.json',
  },
};

const summary = {
  messageId: 'msg_test_1',
  chatId: 'chat_test_1',
  messageType: 'text',
  sender: {
    senderType: 'user',
  },
};

let sendCalls = 0;
const handled = [];

await handleMessage(runtime, summary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_test_1',
    runId: 'run_test_1',
    requestId: 'request_test_1',
    duplicate: false,
    replyText: '',
  }),
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 0, 'empty assistant replies should not be sent to Feishu');
assert.equal(handled.length, 1, 'empty assistant replies should still be marked handled');
assert.equal(handled[0].messageId, summary.messageId);
assert.equal(handled[0].metadata.status, 'silent_no_reply');
assert.equal(handled[0].metadata.reason, 'empty_assistant_reply');
assert.equal(handled[0].metadata.sessionId, 'session_test_1');
assert.equal(runtime.processingMessageIds.size, 0, 'message processing state should always be cleaned up');

const imageSummary = summarizeEvent({
  event_id: 'evt_image_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_image_1',
  sender: {
    sender_id: { open_id: 'ou_image_1' },
    sender_type: 'user',
    tenant_key: 'tenant_image_1',
  },
  message: {
    chat_id: 'chat_image_1',
    chat_type: 'group',
    message_id: 'msg_image_1',
    message_type: 'image',
    content: JSON.stringify({ image_key: 'img_v2_1' }),
  },
});

assert.equal(imageSummary.textPreview, '', 'image payloads should not fake a text preview');
assert.equal(imageSummary.contentSummary, 'Image attachment');
assert.deepEqual(imageSummary.contentKeys, ['image_key']);

const richPostSummary = summarizeEvent({
  event_id: 'evt_post_1',
  event_type: 'im.message.receive_v1',
  tenant_key: 'tenant_post_1',
  sender: {
    sender_id: { open_id: 'ou_post_1' },
    sender_type: 'user',
    tenant_key: 'tenant_post_1',
  },
  message: {
    chat_id: 'chat_post_1',
    chat_type: 'group',
    message_id: 'msg_post_1',
    message_type: 'post',
    content: JSON.stringify({
      title: 'Weekly update',
      content: [[
        { tag: 'text', text: 'Alpha milestone' },
        { tag: 'text', text: 'Beta follow-up' },
      ]],
    }),
  },
});

assert.match(richPostSummary.contentSummary, /Rich text post/i);
assert.match(richPostSummary.contentSummary, /Weekly update/i);

sendCalls = 0;
handled.length = 0;
let unsupportedInvokedRemoteLab = false;

await handleMessage(runtime, imageSummary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => {
    unsupportedInvokedRemoteLab = true;
    throw new Error('unsupported messages should not invoke RemoteLab');
  },
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_image' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(unsupportedInvokedRemoteLab, false, 'unsupported non-text payloads should stop before RemoteLab submission');
assert.equal(sendCalls, 0, 'unsupported non-text payloads should not send fallback replies');
assert.equal(handled.length, 1, 'unsupported non-text payloads should still be marked handled');
assert.equal(handled[0].messageId, 'msg_image_1');
assert.equal(handled[0].metadata.status, 'silent_no_reply');
assert.equal(handled[0].metadata.reason, 'unsupported_message_type');
assert.equal(handled[0].metadata.messageType, 'image');
assert.equal(handled[0].metadata.contentSummary, 'Image attachment');
assert.equal(runtime.processingMessageIds.size, 0, 'unsupported payload processing state should always be cleaned up');

const authRefreshRuntime = {
  authCookie: 'session_token=stale-cookie',
  authToken: 'stale-token',
  config: { chatBaseUrl: 'http://127.0.0.1:7690' },
  readOwnerToken: async () => 'fresh-token',
  loginWithToken: async (_baseUrl, token) => `session_token=${token}`,
};

assert.equal(
  await ensureAuthCookie(authRefreshRuntime, false),
  'session_token=stale-cookie',
  'cached auth cookies should be reused when no refresh is needed',
);

assert.equal(
  await ensureAuthCookie(authRefreshRuntime, true),
  'session_token=fresh-token',
  'forced auth refresh should re-read the current owner token before logging in again',
);
assert.equal(authRefreshRuntime.authToken, 'fresh-token');
assert.equal(authRefreshRuntime.authCookie, 'session_token=fresh-token');

assert.equal(normalizeReplyText('  \n\n  '), '');
assert.equal(normalizeReplyText('  hello\r\n'), 'hello');
assert.equal(normalizeReplyText(' <private>internal only</private> '), '');

sendCalls = 0;
handled.length = 0;

await handleMessage(runtime, { ...summary, messageId: 'msg_test_hidden_only' }, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => ({
    sessionId: 'session_test_hidden',
    runId: 'run_test_hidden',
    requestId: 'request_test_hidden',
    duplicate: false,
    replyText: '  <private>internal only</private>  ',
  }),
  sendFeishuText: async () => {
    sendCalls += 1;
    return { message_id: 'out_test_hidden' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    handled.push({ messageId, metadata });
  },
});

assert.equal(sendCalls, 0, 'hidden-only assistant replies should not be sent to Feishu');
assert.equal(handled.length, 1, 'hidden-only assistant replies should still be marked handled');
assert.equal(handled[0].messageId, 'msg_test_hidden_only');
assert.equal(handled[0].metadata.status, 'silent_no_reply');
assert.equal(handled[0].metadata.reason, 'empty_assistant_reply');

const explicitArtifactReply = await selectAssistantReplyEvent([
  {
    seq: 2,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_2',
    requestId: 'request_test_2',
    content: 'The real summary reply.',
  },
  {
    seq: 3,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_2',
    requestId: 'request_test_2',
    content: '[x] Inspect\n[x] Reply',
    messageKind: 'todo_list',
  },
], {
  match: (event) => event.runId === 'run_test_2',
});
assert.equal(explicitArtifactReply?.seq, 2, 'reply selection should skip explicit todo artifacts');

const hydratedLegacyReply = await selectAssistantReplyEvent([
  {
    seq: 2,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_3',
    requestId: 'request_test_3',
    content: '',
    bodyAvailable: true,
    bodyLoaded: false,
  },
  {
    seq: 3,
    type: 'message',
    role: 'assistant',
    runId: 'run_test_3',
    requestId: 'request_test_3',
    content: '[x] Inspect\n[x] Reply',
  },
], {
  match: (event) => event.runId === 'run_test_3',
  hydrate: async (event) => ({
    ...event,
    content: 'Hydrated substantive reply.',
    bodyLoaded: true,
  }),
});
assert.equal(hydratedLegacyReply?.seq, 2, 'reply selection should fall back past a trailing legacy checklist');

const mentionSummary = {
  chatType: 'group',
  chatId: 'chat_group_1',
  messageId: 'msg_group_1',
  textPreview: '厉害不，@_user_1 你发一条消息',
  mentions: [{
    key: '@_user_1',
    name: '江虹',
    openId: 'ou_mention_1',
    unionId: 'on_mention_1',
  }],
};

const mentionPrompt = buildRemoteLabMessage(mentionSummary);
assert.match(mentionPrompt, /厉害不，@江虹 你发一条消息/);
assert.match(mentionPrompt, /Mention map:\n- @_user_1 => @江虹 \| open_id=ou_mention_1 \| union_id=on_mention_1/);
assert.match(mentionPrompt, /Original message tokens: 厉害不，@_user_1 你发一条消息/);
assert.match(mentionPrompt, /use their exact mention token/);
assert.doesNotMatch(mentionPrompt, /Write the exact plain-text Feishu reply to send back/);

assert.match(DEFAULT_SESSION_SYSTEM_PROMPT, /Keep connector-specific overrides minimal/i);

const tempConfigDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-config-'));
const tempConfigPath = join(tempConfigDir, 'config.json');
await writeFile(tempConfigPath, `${JSON.stringify({
  appId: 'cli_test',
  appSecret: 'secret_test',
  region: 'feishu-cn',
  chatBaseUrl: 'http://127.0.0.1:7690',
}, null, 2)}\n`, 'utf8');

const loadedConfig = await loadConfig(tempConfigPath);
assert.equal(loadedConfig.systemPrompt, '', 'default config should rely on backend-owned source prompt logic');

assert.equal(
  compileFeishuReplyText('@_user_1 这是一条消息。', mentionSummary.mentions),
  '<at user_id="ou_mention_1">江虹</at> 这是一条消息。',
  'reply mention tokens should compile into Feishu mention tags before sending',
);

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-whitelist-'));
const whitelistPath = join(tempDir, 'allowed-senders.json');
const whitelistPolicy = {
  mode: 'whitelist',
  allowedSendersPath: whitelistPath,
  allowedSenders: {
    openIds: ['ou_bootstrap_only'],
    userIds: [],
    unionIds: [],
    tenantKeys: [],
  },
};

await ensureAllowedSendersFile(whitelistPath, whitelistPolicy.allowedSenders);

await writeFile(whitelistPath, `${JSON.stringify({
  openIds: ['ou_dynamic_first'],
  userIds: [],
  unionIds: [],
  tenantKeys: [],
}, null, 2)}\n`, 'utf8');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_first' },
}), true, 'whitelist file should allow the current openId');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_bootstrap_only' },
}), false, 'once the whitelist file exists, it should be the live source of truth');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_second' },
}), false, 'unknown openIds should still be blocked');

await writeFile(whitelistPath, `${JSON.stringify({
  openIds: ['ou_dynamic_second'],
  userIds: [],
  unionIds: [],
  tenantKeys: [],
}, null, 2)}\n`, 'utf8');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_first' },
}), false, 'policy checks should re-read the whitelist file without restart');

assert.equal(await isAllowedByPolicy(whitelistPolicy, {
  tenantKey: 'tenant_test_1',
  sender: { openId: 'ou_dynamic_second' },
}), true, 'newly written whitelist entries should take effect immediately');

const accessStateDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-access-state-'));
const accessStatePath = join(accessStateDir, 'access-state.json');
const accessAllowedSendersPath = join(accessStateDir, 'allowed-senders.json');
const accessPolicy = {
  mode: 'whitelist',
  accessStatePath,
  allowedSendersPath: accessAllowedSendersPath,
  allowedSenders: {
    openIds: ['ou_owner_1'],
    userIds: ['usr_owner_1'],
    unionIds: ['on_owner_1'],
    tenantKeys: [],
  },
};

const accessState = await loadPersistedAccessState(accessPolicy);
const accessRuntime = createRuntimeContext({
  appId: 'cli_test',
  appSecret: 'test-secret',
  region: 'feishu-cn',
  loggerLevel: 'error',
  intakePolicy: accessPolicy,
  storeRawEvents: false,
  chatBaseUrl: 'http://127.0.0.1:7690',
  sessionFolder: repoRoot,
  sessionTool: 'codex',
  systemPrompt: 'Reply with plain text only.',
  thinking: false,
  model: '',
  effort: '',
}, {
  eventsLogPath: join(accessStateDir, 'events.jsonl'),
  knownSendersPath: join(accessStateDir, 'known-senders.json'),
  handledMessagesPath: join(accessStateDir, 'handled-messages.json'),
}, accessState);

const approveSummary = {
  messageId: 'msg_group_approve_1',
  chatId: 'chat_group_approve_1',
  chatType: 'group',
  messageType: 'text',
  textPreview: '@_user_1 授权本群',
  tenantKey: 'tenant_group_1',
  mentions: [{
    key: '@_user_1',
    name: 'rowan',
    openId: 'ou_bot_1',
  }],
  sender: {
    openId: 'ou_owner_1',
    userId: 'usr_owner_1',
    unionId: 'on_owner_1',
    senderType: 'user',
    tenantKey: 'tenant_group_1',
  },
};

assert.equal(extractLocalCommand(approveSummary)?.type, 'approve_current_chat');

let localCommandReply = '';
const localCommandHandled = [];

await handleMessage(accessRuntime, approveSummary, 'test', {
  wasMessageHandled: async () => false,
  generateRemoteLabReply: async () => {
    throw new Error('local group approval should not invoke RemoteLab');
  },
  sendFeishuText: async (_runtime, _summary, text) => {
    localCommandReply = text;
    return { message_id: 'out_group_approve_1' };
  },
  markMessageHandled: async (_pathname, messageId, metadata) => {
    localCommandHandled.push({ messageId, metadata });
  },
});

assert.match(localCommandReply, /chat_id=chat_group_approve_1/);
assert.equal(localCommandHandled.length, 1, 'local command should still mark the message handled');
assert.equal(localCommandHandled[0].metadata.status, 'approved_chat');

const persistedApproval = JSON.parse(await readFile(accessStatePath, 'utf8'));
assert.equal(persistedApproval.approvedChats.chat_group_approve_1.chatId, 'chat_group_approve_1');
assert.equal(persistedApproval.approvedChats.chat_group_approve_1.autoApproveNewMembers, true);

const joinSummary = summarizeChatMemberUserAddedEvent({
  event_id: 'event_join_1',
  event_type: 'im.chat.member.user.added_v1',
  tenant_key: 'tenant_group_1',
  app_id: 'cli_test',
  chat_id: 'chat_group_approve_1',
  name: 'Family Group',
  users: [{
    name: 'New Member',
    tenant_key: 'tenant_group_1',
    user_id: {
      open_id: 'ou_new_user_1',
      user_id: 'usr_new_user_1',
      union_id: 'on_new_user_1',
    },
  }],
});

const joinResult = await handleChatMemberUserAdded(accessRuntime, joinSummary, { demo: true }, 'im.chat.member.user.added_v1');
assert.equal(joinResult.approved, true);
assert.equal(joinResult.grantedCount, 1, 'approved chats should auto-grant newly joined members');

assert.equal(await isAllowedByPolicy(accessPolicy, {
  tenantKey: 'tenant_group_1',
  sender: { openId: 'ou_new_user_1' },
}, accessRuntime.access), true, 'joined users should be allowed immediately from in-memory cache');

const persistedAfterJoin = JSON.parse(await readFile(accessStatePath, 'utf8'));
assert.ok(persistedAfterJoin.allowedSenders.openIds.includes('ou_new_user_1'));
assert.ok(persistedAfterJoin.membershipGrants['chat_group_approve_1:ou_new_user_1']);
assert.equal(persistedAfterJoin.approvedChats.chat_group_approve_1.name, 'Family Group');

let createdPayload = null;
const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
  });
  await new Promise((resolve) => req.on('end', resolve));

  if (req.method === 'POST' && req.url === '/api/sessions') {
    createdPayload = JSON.parse(body || '{}');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_feishu_1' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_feishu_1/messages') {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_feishu_1' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_feishu_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'run_feishu_1', state: 'completed' } }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_feishu_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [{
        seq: 1,
        type: 'message',
        role: 'assistant',
        runId: 'run_feishu_1',
        requestId: 'feishu:msg_for_scope',
        content: 'Feishu reply ready.',
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  const address = server.address();
  const reply = await generateRemoteLabReply(
    {
      authCookie: 'session_token=test-cookie',
      authToken: 'ignored',
      config: {
        chatBaseUrl: `http://127.0.0.1:${address.port}`,
        sessionFolder: repoRoot,
        sessionTool: 'codex',
        systemPrompt: 'Reply with plain text only.',
        thinking: false,
        model: '',
        effort: '',
      },
    },
    {
      chatType: 'p2p',
      chatId: 'chat_for_scope',
      messageId: 'msg_for_scope',
      textPreview: 'Please confirm the app scope.',
      sender: { openId: 'ou_scope_test' },
    },
  );

  assert.equal(createdPayload?.appId, 'feishu');
  assert.equal(createdPayload?.appName, 'Feishu');
  assert.equal(createdPayload?.sourceId, 'feishu');
  assert.equal(createdPayload?.sourceName, 'Feishu');
  assert.equal(createdPayload?.systemPrompt, 'Reply with plain text only.');
  assert.equal(createdPayload?.externalTriggerId, 'feishu:p2p:chat_for_scope');
  assert.equal(reply.sessionId, 'sess_feishu_1');
  assert.equal(reply.runId, 'run_feishu_1');
  assert.equal(reply.replyText, 'Feishu reply ready.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log('ok - empty assistant replies stay silent');
console.log('ok - non-text Feishu payloads are summarized and ignored silently');
console.log('ok - mention tokens are rendered inbound and compiled outbound');
console.log('ok - whitelist file reloads without restart');
console.log('ok - local group approval commands persist approved chats');
console.log('ok - approved chats auto-grant newly joined members');
console.log('ok - generated Feishu sessions use the feishu app scope');
