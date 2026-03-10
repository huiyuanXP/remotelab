#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-usage-context-'));

process.env.HOME = tempHome;

const { createClaudeAdapter } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'adapters', 'claude.mjs')).href
);
const { createCodexAdapter } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'adapters', 'codex.mjs')).href
);
const { createShareSnapshot } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'shares.mjs')).href
);
const { CHAT_SHARE_SNAPSHOTS_DIR } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'config.mjs')).href
);

try {
  const claude = createClaudeAdapter();
  claude.parseLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'Done.' }],
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 450,
      },
    },
  }));

  const claudeUsageEvents = claude.parseLine(JSON.stringify({
    type: 'result',
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 450,
      output_tokens: 80,
    },
  }));
  const claudeUsage = claudeUsageEvents.find((event) => event.type === 'usage');

  assert.ok(claudeUsage, 'Claude adapter should emit a usage event');
  assert.equal(claudeUsage.contextTokens, 1950, 'Claude context size should include cached tokens');
  assert.equal(claudeUsage.inputTokens, 1200, 'Claude inputTokens should preserve raw provider input');
  assert.equal(claudeUsage.outputTokens, 80, 'Claude outputTokens should be preserved');

  const codex = createCodexAdapter();
  const codexUsageEvents = codex.parseLine(JSON.stringify({
    type: 'turn.completed',
    usage: {
      input_tokens: 8068,
      cached_input_tokens: 7040,
      output_tokens: 31,
    },
  }));
  const codexUsage = codexUsageEvents.find((event) => event.type === 'usage');

  assert.ok(codexUsage, 'Codex adapter should emit a usage event');
  assert.equal(codexUsage.contextTokens, 8068, 'Codex context size should use input_tokens directly');
  assert.equal(codexUsage.inputTokens, 8068, 'Codex inputTokens should preserve raw provider input');
  assert.equal(codexUsage.outputTokens, 31, 'Codex outputTokens should be preserved');

  const snapshot = createShareSnapshot(
    { name: 'Usage test', tool: 'codex', created: new Date().toISOString() },
    [
      {
        type: 'usage',
        id: 'evt_legacy',
        timestamp: 1,
        role: 'system',
        inputTokens: 321,
        outputTokens: 12,
      },
      {
        type: 'usage',
        id: 'evt_new',
        timestamp: 2,
        role: 'system',
        contextTokens: 654,
        inputTokens: 111,
        outputTokens: 22,
      },
    ],
  );

  const stored = JSON.parse(
    readFileSync(join(CHAT_SHARE_SNAPSHOTS_DIR, `${snapshot.id}.json`), 'utf8'),
  );
  const [legacyUsage, newUsage] = stored.events;

  assert.equal(legacyUsage.contextTokens, 321, 'legacy usage events should fall back to inputTokens');
  assert.equal(newUsage.contextTokens, 654, 'new usage events should preserve explicit contextTokens');

  console.log('test-usage-context-metric: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
