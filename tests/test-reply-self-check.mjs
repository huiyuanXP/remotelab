#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-reply-self-check-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isWorkflowPrompt = prompt.includes('You are updating RemoteLab workflow state for a developer session');
const isReplyReviewPrompt = prompt.includes("You are RemoteLab's hidden end-of-turn completion reviewer.");
const isRepairPrompt = prompt.includes('You are continuing the same user-facing reply after a hidden self-check found an avoidable early stop.');

let threadId = 'main-thread';
let text = '我已经分析了机制问题。下一条我可以直接给你那份极短执行守则。';

if (isWorkflowPrompt) {
  threadId = 'workflow-thread';
  text = JSON.stringify({ workflowState: 'done', workflowPriority: 'low', reason: 'done' });
} else if (isReplyReviewPrompt) {
  threadId = 'review-thread';
  text = '<hide>' + JSON.stringify({
    action: 'continue',
    reason: '上一条回复把本轮该直接交付的内容留到了后面。',
    continuationPrompt: '直接给出那份极短执行守则，不要再征求许可，也不要重复前面的机制分析。',
  }) + '</hide>';
} else if (isRepairPrompt) {
  threadId = 'repair-thread';
  text = '极短执行守则：默认先做完再汇报；除非高风险、真歧义、缺关键信息，否则不要停；不要用“如果你愿意我下一条再做”作为结尾。';
}

console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
setTimeout(() => process.exit(0), 20);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;
process.env.REMOTELAB_REPLY_SELF_CHECK = 'all';

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getHistory,
  getSession,
  killAll,
  sendMessage,
} = sessionManager;

async function waitFor(predicate, description, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(tempHome, 'fake-codex', 'Reply Self Check', {
    group: 'RemoteLab',
    description: 'Verify end-of-turn self-check can auto-continue an avoidably unfinished reply.',
  });

  await sendMessage(session.id, '先分析问题，再把极短执行守则真的给出来。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => {
      const history = await getHistory(session.id);
      return history.some((event) => event.type === 'message' && event.role === 'assistant' && (event.content || '').includes('极短执行守则：'));
    },
    'self-check should trigger an automatic follow-up reply',
  );

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'session should become idle after the automatic follow-up reply',
  );

  const history = await getHistory(session.id);
  const statusTexts = history
    .filter((event) => event.type === 'status')
    .map((event) => event.content || '');
  const assistantTexts = history
    .filter((event) => event.type === 'message' && event.role === 'assistant')
    .map((event) => event.content || '');

  assert.ok(
    statusTexts.includes('Assistant self-check: reviewing the latest reply for early stop…'),
    'history should show that the self-check reviewer ran',
  );
  assert.ok(
    statusTexts.some((text) => text.startsWith('Assistant self-check: continuing automatically — ')),
    'history should show that the self-check requested an automatic continuation',
  );
  assert.ok(
    assistantTexts.some((text) => text.includes('下一条我可以直接给你那份极短执行守则')),
    'history should keep the original avoidably unfinished reply',
  );
  assert.ok(
    assistantTexts.some((text) => text.includes('极短执行守则：默认先做完再汇报')),
    'history should include the automatically continued reply',
  );
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-reply-self-check: ok');
