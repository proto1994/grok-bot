/**
 * Smoke test for everything that does not need a model: store durability,
 * the policy engine's stricter-wins rule, and the sandbox seam.
 *
 *   SANDBOX_DRIVER=local SANDBOX_ALLOW_LOCAL=1 DB_PATH=./data/test/smoke.db pnpm tsx src/smoke.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

// Start from an empty database. Relying on the caller to delete it made the
// result depend on whether this file had been run before — a claim already in
// the journal replays instead of running.
const DB = process.env.DB_PATH ?? './data/test/smoke.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/workspaces/smoke-owner', { recursive: true, force: true });

const { store } = await import('./agent/store.ts');
const { evaluate } = await import('./agent/policy.ts');
const { getSandbox } = await import('./sandbox/index.ts');
type Rule = import('./agent/policy.ts').Rule;

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    });

console.log('policy');
await check('read-only tools are allowed by default', () => {
  assert.equal(evaluate('read_file', 'read').decision, 'allow');
});
await check('writing tools ask by default', () => {
  assert.equal(evaluate('write_file', 'write').decision, 'ask');
});
await check('external tools ask by default', () => {
  assert.equal(evaluate('send_email', 'external').decision, 'ask');
});
await check('a permissive rule cannot loosen the risk floor', () => {
  const loose: Rule[] = [{ tool: '*', decision: 'allow', reason: 'try to loosen' }];
  assert.equal(evaluate('write_file', 'write', loose, loose).decision, 'ask');
});
await check('member rules can tighten a read-only tool', () => {
  const tighter: Rule[] = [{ tool: 'read_file', decision: 'ask', reason: 'sensitive repo' }];
  assert.equal(evaluate('read_file', 'read', [], tighter).decision, 'ask');
});

console.log('store');
const bot = store.createBot('smoke-owner', 'Smoke', 'verify the wiring');
await check('bots round-trip', () => {
  assert.equal(store.getBot(bot.id)?.name, 'Smoke');
});
const run = store.createRun(bot.id);
await check('runs start running', () => {
  assert.equal(store.getRun(run.id)?.status, 'running');
});
await check('in-flight runs are resumable', () => {
  assert.ok(store.resumableRuns().some((r) => r.id === run.id));
});
await check('steps keep their order', () => {
  store.appendStep(run.id, 'user_message', 'first');
  store.appendStep(run.id, 'assistant_text', 'second');
  assert.deepEqual(store.listSteps(run.id).map((s) => s.body), ['first', 'second']);
});
await check('transcript round-trips content blocks', () => {
  store.appendMessage(bot.id, run.id, 'user', [{ type: 'text', text: 'hello' }]);
  const t = store.transcript(bot.id);
  assert.deepEqual(t.at(-1)?.content, [{ type: 'text', text: 'hello' }]);
});
await check('approvals park and settle', () => {
  const a = store.createApproval({
    runId: run.id, botId: bot.id, tool: 'shell',
    args: '{"command":"ls"}', reason: 'test', risk: 'write',
  });
  assert.equal(store.pendingApprovals(run.id).length, 1);
  store.resolveApproval(a.id, true);
  assert.equal(store.getApproval(a.id)?.approved, 1);
  store.settleApproval(a.id);
  assert.equal(store.pendingApprovals(run.id).length, 0);
});
console.log('execution journal');
await check('a fresh call is claimed for execution', () => {
  assert.equal(store.claimTool('tu-1', run.id, 'shell', '{}').kind, 'run');
});
await check('a finished call replays its recorded result', () => {
  store.finishTool('tu-1', 'exit=0', false);
  const c = store.claimTool('tu-1', run.id, 'shell', '{}');
  assert.equal(c.kind, 'replay');
  assert.equal(c.kind === 'replay' && c.result, 'exit=0');
});
await check('an error result replays as an error', () => {
  store.claimTool('tu-err', run.id, 'shell', '{}');
  store.finishTool('tu-err', 'Error: boom', true);
  const c = store.claimTool('tu-err', run.id, 'shell', '{}');
  assert.ok(c.kind === 'replay' && c.isError);
});
await check('a claimed but unfinished call is reported as orphaned', () => {
  store.claimTool('tu-2', run.id, 'shell', '{}'); // never finished: simulates a crash
  assert.equal(store.claimTool('tu-2', run.id, 'shell', '{}').kind, 'orphaned');
});
await check('an orphan is only reported once', () => {
  store.abandonTool('tu-2', 'interrupted');
  assert.equal(store.claimTool('tu-2', run.id, 'shell', '{}').kind, 'replay');
});

console.log('store (cont.)');
await check('memory round-trips', () => {
  store.remember(bot.id, 'never contact a customer without approval');
  assert.ok(store.memories(bot.id).includes('never contact a customer without approval'));
});

console.log('sandbox');
await check('exec returns stdout and an exit code', async () => {
  const s = await getSandbox('smoke-owner');
  const r = await s.exec('echo hi && exit 3');
  assert.equal(r.exitCode, 3);
  assert.match(r.stdout, /hi/);
});
await check('files round-trip through the sandbox', async () => {
  const s = await getSandbox('smoke-owner');
  await s.writeFile('note.txt', 'durable');
  assert.equal(await s.readFile('note.txt'), 'durable');
});
await check('a command with no timeout is not killed by a default one', async () => {
  // Regression: a 120s default here killed long commands and reported exit -1,
  // which the model read as the command being cut off and retried in pieces.
  const s = await getSandbox('smoke-owner');
  const r = await s.exec('sleep 2; echo survived');
  assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /survived/);
});

await check('an explicit timeout stops the command and says so', async () => {
  const s = await getSandbox('smoke-owner');
  const r = await s.exec('sleep 30; echo never', { timeoutMs: 1000 });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /sandbox timeout|killed by/, `stderr was: ${r.stderr}`);
});

await check('the sandbox reports the working directory it really uses', async () => {
  const s = await getSandbox('smoke-owner');
  assert.ok(s.workdir, 'workdir must be set');
  const r = await s.exec('pwd');
  assert.equal(r.stdout.trim(), s.workdir, 'pwd must match what the model is told');
});

await check('file tools stay inside the workspace', async () => {
  const s = await getSandbox('smoke-owner');
  await assert.rejects(() => s.readFile('../../etc/passwd'), /escapes the workspace/);
});

console.log(`\n${passed} checks passed`);
