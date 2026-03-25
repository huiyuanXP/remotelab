#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-apps-builtins-'));
process.env.HOME = tempHome;
process.env.CHAT_PORT = '7692';
process.env.REMOTELAB_CONFIG_DIR = join(tempHome, 'instance-config');

const appsModule = await import(pathToFileURL(join(repoRoot, 'chat', 'apps.mjs')).href);

const {
  BASIC_CHAT_APP_ID,
  CREATE_APP_APP_ID,
  DEFAULT_APP_ID,
  EMAIL_APP_ID,
  WELCOME_APP_ID,
  createApp,
  deleteApp,
  getApp,
  getAppByShareToken,
  isBuiltinAppId,
  listApps,
  updateApp,
} = appsModule;

try {
  const initial = await listApps();
  assert.deepEqual(
    initial.map((app) => app.id),
    ['chat', 'email', 'app_welcome', 'app_basic_chat', 'app_create_app'],
    'built-in apps should include connector scopes plus shipped starter apps',
  );
  assert.equal(DEFAULT_APP_ID, 'chat');
  assert.equal(EMAIL_APP_ID, 'email');
  assert.equal(WELCOME_APP_ID, 'app_welcome');
  assert.equal(BASIC_CHAT_APP_ID, 'app_basic_chat');
  assert.equal(CREATE_APP_APP_ID, 'app_create_app');
  assert.equal(isBuiltinAppId('Chat'), true);
  assert.equal(isBuiltinAppId('Email'), true);
  assert.equal(isBuiltinAppId('app_welcome'), true);
  assert.equal(isBuiltinAppId('app_basic_chat'), true);
  assert.equal(isBuiltinAppId('app_create_app'), true);
  assert.equal(isBuiltinAppId('app_video_cut'), false);
  assert.equal(isBuiltinAppId('github'), false);
  assert.equal(isBuiltinAppId('custom-app'), false);

  const chatApp = await getApp('chat');
  assert.equal(chatApp?.id, 'chat');
  assert.equal(chatApp?.name, 'Chat');
  assert.equal(chatApp?.builtin, true);
  assert.equal(chatApp?.templateSelectable, false);

  const emailApp = await getApp('email');
  assert.equal(emailApp?.id, 'email');
  assert.equal(emailApp?.name, 'Email');
  assert.equal(emailApp?.builtin, true);
  assert.equal(emailApp?.templateSelectable, false);
  assert.equal(emailApp?.showInSidebarWhenEmpty, false);

  const welcomeApp = await getApp(WELCOME_APP_ID);
  assert.equal(welcomeApp?.id, WELCOME_APP_ID);
  assert.equal(welcomeApp?.builtin, true);
  assert.equal(welcomeApp?.templateSelectable, true);
  assert.equal(welcomeApp?.shareEnabled, false);
  assert.equal(welcomeApp?.shareToken, undefined);
  assert.match(welcomeApp?.systemPrompt || '', /raw materials|files, screenshots|PowerPoints/i);
  assert.match(welcomeApp?.systemPrompt || '', /fixed intake form|rigid template|prompt-writing lesson/i);
  assert.match(welcomeApp?.systemPrompt || '', /new assistant receiving a handoff|report or spreadsheet cleanup|exports and imports/i);
  assert.match(welcomeApp?.systemPrompt || '', /project mechanics|project structure|folders, notes/i);
  assert.match(welcomeApp?.systemPrompt || '', /durable knowledge|repeat themselves/i);
  assert.match(welcomeApp?.systemPrompt || '', /internal task frame|backend-owned hidden state|concrete materials/i);
  assert.match(welcomeApp?.systemPrompt || '', /execution surface|local paths|complete handoff/i);
  assert.doesNotMatch(welcomeApp?.systemPrompt || '', /task_card|hidden <private>|mode, summary, goal/i);
  assert.match(welcomeApp?.welcomeMessage || '', /我是 Rowan|聊天工具|先接手、再梳理、再推进执行/u);
  assert.match(welcomeApp?.welcomeMessage || '', /报表\/表格整理|导出导入|文件批处理/u);
  assert.match(welcomeApp?.welcomeMessage || '', /prompt 想清楚|一次说齐|进入执行/u);
  assert.match(welcomeApp?.welcomeMessage || '', /可读\/可下载内容|某个路径里找/u);
  assert.match(welcomeApp?.welcomeMessage || '', /最关键的一两个问题|现在就把这次的事和材料发来/u);

  const basicChatApp = await getApp(BASIC_CHAT_APP_ID);
  assert.equal(basicChatApp?.id, BASIC_CHAT_APP_ID);
  assert.equal(basicChatApp?.builtin, true);
  assert.equal(basicChatApp?.templateSelectable, true);
  assert.equal(basicChatApp?.shareEnabled, false);
  assert.equal(basicChatApp?.shareToken, undefined);

  const createAppStarter = await getApp(CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.id, CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.builtin, true);
  assert.equal(createAppStarter?.templateSelectable, true);
  assert.equal(createAppStarter?.tool, 'codex');
  assert.equal(createAppStarter?.shareEnabled, false);
  assert.equal(createAppStarter?.shareToken, undefined);
  assert.match(createAppStarter?.systemPrompt || '', /POST \/api\/apps|PATCH \/api\/apps/i);
  assert.match(createAppStarter?.systemPrompt || '', /share link|\/app\/\{shareToken\}|other people/i);
  assert.match(createAppStarter?.systemPrompt || '', /visitors interact only through RemoteLab|local-path-based handoff/i);
  assert.match(createAppStarter?.systemPrompt || '', /chat attachments|share links|user-reachable channel/i);
  assert.match(createAppStarter?.systemPrompt || '', /http:\/\/127\.0\.0\.1:7692/);
  assert.match(
    createAppStarter?.systemPrompt || '',
    new RegExp(`${join(tempHome, 'instance-config', 'auth.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(createAppStarter?.welcomeMessage || '', /SOP|工作流|RemoteLab App/i);
  assert.match(createAppStarter?.welcomeMessage || '', /SOP|工作流/i);
  assert.match(createAppStarter?.welcomeMessage || '', /交付方式一起设计进去|会话里直接拿到|宿主机上找路径/u);
  assert.match(createAppStarter?.welcomeMessage || '', /分享给别人的链接|分享方式|share/i);

  assert.equal(await getApp('feishu'), null);
  assert.equal(await getApp('app_video_cut'), null, 'Video Cut should no longer ship as a built-in app');

  const custom = await createApp({
    name: 'Docs Portal',
    systemPrompt: 'Help with docs only.',
    welcomeMessage: 'Welcome!',
    skills: [],
    tool: 'codex',
  });
  assert.match(custom.id, /^app_[0-9a-f]+$/);

  const defaultToolApp = await createApp({
    name: 'Default Tool App',
    systemPrompt: 'Use the product default.',
    welcomeMessage: '',
    skills: [],
  });
  assert.equal(defaultToolApp.tool, 'codex', 'new apps should default to CodeX');

  const afterCreate = await listApps();
  assert.equal(afterCreate.some((app) => app.id === custom.id), true);
  assert.equal(afterCreate.some((app) => app.id === defaultToolApp.id), true);

  assert.equal(await updateApp('chat', { name: 'Owner Console' }), null);
  assert.equal(await updateApp('email', { name: 'Mailbox' }), null);
  assert.equal(await deleteApp('chat'), false);
  assert.equal(await deleteApp('email'), false);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-apps-builtins: ok');
