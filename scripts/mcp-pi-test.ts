/**
 * MCP tools must be callable by the model, not merely listed.
 *
 * Before the bridge existed, /api/tools advertised MCP tools the model had no
 * way to invoke. This is the test that notices if that regresses.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/mcp-pi-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/mcp-pi.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

const { store } = await import('../src/agent/store.ts');
const { loadMcpServers, stopMcpServers } = await import('../src/mcp/registry.ts');
const { sessionFor, dropSession } = await import('../src/pi/runner.ts');
const { mcpToolNames } = await import('../src/pi/mcp-bridge.ts');

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
};

// The fixture server exposes add/ping/explode; `ping` is declared read-only so
// it needs no approval, which keeps this test about reachability.
const dir = mkdtempSync(path.join(tmpdir(), 'mcp-pi-'));
const cfg = path.join(dir, 'mcp.json');
writeFileSync(cfg, JSON.stringify({
  servers: {
    fixture: {
      command: process.execPath,
      args: [path.resolve('scripts/fixture-mcp-server.mjs')],
      readOnlyTools: ['ping', 'add'],
    },
  },
}));

const loaded = await loadMcpServers(cfg);
console.log('mcp tools reachable by the model');
await check('the fixture server registered', () => {
  assert.equal(loaded.length, 1);
  assert.ok(mcpToolNames().includes('fixture__add'), mcpToolNames().join(','));
});

const OWNER = 'mcppi';
const bot = store.createBot(OWNER, 'M', 'use the tools you have to answer');
const run = store.createRun(bot.id);
const session = await sessionFor(bot);

const approve = setInterval(() => {
  for (const a of store.openApprovals(OWNER)) store.resolveApproval(a.id, true);
}, 200);
await session.prompt(
  'Use the fixture__add tool to add 17 and 25. Report only the number it returns. ' +
    'Do not compute it yourself and do not use the shell.',
  run.id, () => {},
);
clearInterval(approve);

const steps = store.listSteps(run.id);
const said = steps.filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');

await check('the model called the MCP tool', () => {
  const called = steps.filter((s) => s.kind === 'tool_call' && s.tool === 'fixture__add');
  assert.ok(called.length > 0, `tool calls: ${steps.filter((s) => s.kind === 'tool_call').map((s) => s.tool).join(',') || 'none'}`);
});

await check('the result came back from the server', () => {
  const results = steps.filter((s) => s.kind === 'tool_result' && s.tool === 'fixture__add');
  assert.ok(results.length > 0, 'expected a result from fixture__add');
  assert.match(results[0]!.body, /42/, `got: ${results[0]!.body.slice(0, 80)}`);
});

await check('the answer reached the user', () => {
  assert.match(said, /42/, `said: ${said.slice(0, 150)}`);
});

await check('the run completed', () => {
  assert.equal(store.getRun(run.id)!.status, 'done');
});

await dropSession(bot.id);
stopMcpServers();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
