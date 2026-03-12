import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-system-prompt-'));
process.env.HOME = tempHome;

const { buildSystemContext } = await import('../chat/system-prompt.mjs');

const context = await buildSystemContext();

assert.match(context, /Template-Session-First Routing/);
assert.match(context, /reusable template\/base session likely exists/);
assert.match(context, /clean, comprehensive project-task context/);
assert.match(context, /improve it or derive a better template\/base/);
assert.match(context, /fresh working child\/fork/);
assert.match(context, /approximate the behavior by loading the best matching template context/);

console.log('test-system-prompt: ok');
