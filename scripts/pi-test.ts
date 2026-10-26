/**
 * The PI runner end to end: tools execute in the sandbox, the gate parks a
 * write and only releases it on approval.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/pi-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test/pi-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = process.env.SANDBOX_DRIVER ?? 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const { store } = await import('../src/agent/store.ts');
const { sessionFor, dropSession } = await import('../src/pi/runner.ts');
const { getSandbox } = await import('../src/sandbox/index.ts');

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

const bot = store.createBot('pitest', 'PI', 'run the task the user gives you');
const sandbox = await getSandbox('pitest', null);
await sandbox.exec('rm -f gate-probe.txt readable.txt');
await sandbox.writeFile('readable.txt', 'sandbox content\n');

const session = await sessionFor(bot);
const events: unknown[] = [];
const emit = (e: unknown) => events.push(e);

console.log('read-only tool runs without approval');
{
  const run = store.createRun(bot.id);
  // Deny anything that asks for approval here: this case is about the read
  // path, and the model is free to propose extra verification steps.
  const autoDeny = setInterval(() => {
    for (const a of store.openApprovals('pitest')) store.resolveApproval(a.id, false);
  }, 250);
  await session.prompt(
    'Use the read tool on readable.txt and quote its contents. Do not run any shell command.',
    run.id, emit,
  );
  clearInterval(autoDeny);

  await check('the run completed', () => {
    assert.equal(store.getRun(run.id)!.status, 'done');
  });
  await check('the model saw the sandbox file, not a host file', () => {
    const texts = store.listSteps(run.id).filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');
    assert.match(texts, /sandbox content/i, `steps: ${texts.slice(0, 200)}`);
  });
  await check('the read itself needed no approval', () => {
    const reads = store.listSteps(run.id).filter((s) => s.kind === 'tool_result' && s.tool === 'read');
    assert.ok(reads.length > 0, 'the read tool should have produced a result without being parked');
  });
}

console.log('a write is parked, then approved');
{
  const run = store.createRun(bot.id);
  const task = session.prompt(
    'Create a file named gate-probe.txt containing exactly: approved. Use the write tool.',
    run.id, emit,
  );

  // Wait for the gate to park the call.
  let approval: ReturnType<typeof store.openApprovals>[number] | undefined;
  for (let i = 0; i < 160; i++) {
    approval = store.openApprovals('pitest')[0];
    if (approval) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  await check('the write was parked for approval', () => {
    assert.ok(approval, 'expected an open approval');
    assert.ok(['write', 'bash', 'edit'].includes(approval!.tool), `tool was ${approval?.tool}`);
  });

  await check('nothing was written while parked', async () => {
    const r = await sandbox.exec('test -f gate-probe.txt && echo EXISTS || echo missing');
    assert.match(r.stdout, /missing/, 'the file must not exist before approval');
  });

  store.resolveApproval(approval!.id, true);
  await task;

  await check('the file exists after approval', async () => {
    const r = await sandbox.exec('cat gate-probe.txt 2>/dev/null || echo MISSING');
    assert.match(r.stdout, /approved/i, `got: ${r.stdout.slice(0, 120)}`);
  });
  await check('the run finished', () => {
    assert.equal(store.getRun(run.id)!.status, 'done');
  });
  await check('an approval.requested event reached the UI channel', () => {
    assert.ok(events.some((e) => (e as { type?: string }).type === 'approval.requested'));
  });
}

console.log('a denial blocks execution');
{
  await sandbox.exec('rm -f denied-probe.txt');
  const run = store.createRun(bot.id);
  const task = session.prompt(
    'Create a file named denied-probe.txt containing: nope. Use the write tool.',
    run.id, emit,
  );

  let approval: ReturnType<typeof store.openApprovals>[number] | undefined;
  for (let i = 0; i < 160; i++) {
    approval = store.openApprovals('pitest')[0];
    if (approval) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(approval, 'expected an open approval to deny');
  store.resolveApproval(approval.id, false);
  await task;

  await check('the denied file was never created', async () => {
    const r = await sandbox.exec('test -f denied-probe.txt && echo EXISTS || echo missing');
    assert.match(r.stdout, /missing/);
  });
  await check('the denial is visible in the step log', () => {
    const bodies = store.listSteps(run.id).map((s) => s.body).join(' | ');
    assert.match(bodies, /denied/i, bodies.slice(0, 200));
  });
}

console.log('search tools run in the sandbox');
{
  await sandbox.exec('mkdir -p nested && printf "needle here\\n" > nested/haystack.txt');
  const run = store.createRun(bot.id);
  const autoDeny = setInterval(() => {
    for (const a of store.openApprovals('pitest')) store.resolveApproval(a.id, false);
  }, 250);
  // grep and find are not offered as tools (they would run on the host), so
  // searching goes through bash — which does execute in the sandbox.
  await session.prompt(
    'Find which file under the workspace contains the word "needle" and report its path.',
    run.id, emit,
  );
  clearInterval(autoDeny);

  await check('searching finds the file inside the sandbox', () => {
    const said = store.listSteps(run.id).filter((s) => s.kind === 'assistant_text')
      .map((s) => s.body).join(' ');
    assert.match(said, /haystack/, `said: ${said.slice(0, 160)}`);
  });
  await check('the search ran in the sandbox, not on the host', () => {
    const results = store.listSteps(run.id).filter((s) => s.kind === 'tool_result');
    assert.ok(results.length > 0, 'expected at least one tool result');
    // A host-side search would have found the repo's own files.
    const leaked = results.some((s) => /package\.json|src\/pi\//.test(s.body));
    assert.equal(leaked, false, 'the search reached outside the workspace');
  });
}

console.log('full permission bypasses the gate');
{
  const full = store.createBot('pitest', 'Full', 'do what the user asks', null, 'full');
  const fullSession = await sessionFor(full);
  const run = store.createRun(full.id);

  // Nothing resolves approvals here: if the gate parks anything, this hangs and
  // the file never appears — which is exactly what the assertions check.
  await sandbox.exec('rm -f full-mode.txt');
  await fullSession.prompt(
    'Create a file named full-mode.txt containing exactly: unattended. Use the write tool.',
    run.id, emit,
  );

  await check('no approval was requested', () => {
    assert.equal(store.openApprovals('pitest').length, 0, 'full mode must not park anything');
  });
  await check('the write happened without anyone approving it', async () => {
    const r = await sandbox.exec('cat full-mode.txt 2>/dev/null || echo MISSING');
    assert.match(r.stdout, /unattended/, `got: ${r.stdout.slice(0, 120)}`);
  });
  await check('the call is still visible in the step log', () => {
    const calls = store.listSteps(run.id).filter((s) => s.kind === 'tool_call');
    assert.ok(calls.length > 0, 'bypassing approval must not hide what ran');
  });
  await check('the run completed', () => {
    assert.equal(store.getRun(run.id)!.status, 'done');
  });

  await dropSession(full.id);
}

await dropSession(bot.id);
console.log(`\n${passed} checks passed`);
