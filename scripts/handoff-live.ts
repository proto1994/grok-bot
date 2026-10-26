/**
 * Two bots actually working together, with real models.
 *
 * The unit tests prove the guards hold. This proves the thing is usable: that a
 * bot notices another one owns the context, asks for it, gets a reply, and that
 * the receiver's own gate still applies to what it does.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/handoff-live.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/handoff-live.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/workspaces/hlive', { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

const { store } = await import('../src/agent/store.ts');
const { startRun, isBusy } = await import('../src/server/runtime.ts');
const { dropSession } = await import('../src/pi/runner.ts');
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

const OWNER = 'hlive';

// The archivist owns the file; the asker cannot read it without going through
// it, which is the situation message_bot exists for.
const keeper = store.createBot(
  OWNER, '资料员',
  'You own the archive. When asked, read archive.txt and report exactly what it says. ' +
    'You do not do anything else.',
  null, 'full',
);
const asker = store.createBot(
  OWNER, '协调员',
  'You coordinate. You have no archive access yourself: when a task needs something ' +
    'from the archive, ask the bot that owns it rather than looking for the file.',
  null, 'full',
);

const sandbox = await getSandbox(OWNER, null);
await sandbox.writeFile('archive.txt', 'the archive code is PELICAN-7\n');

const settle = async (botId: string) => {
  for (let i = 0; i < 400; i++) {
    if (!isBusy(botId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the run did not settle in 200s');
};

console.log('one bot asks another for what it owns');
{
  const runId = await startRun(
    asker.id,
    'I need the archive code. Get it from whichever bot owns the archive, then tell it to me.',
    () => {},
  );
  await settle(asker.id);

  const steps = store.listSteps(runId);
  const said = steps.filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');

  await check('it looked at who else is available', () => {
    const used = steps.some((s) => s.kind === 'tool_call' && s.tool === 'list_bots');
    const asked = steps.some((s) => s.kind === 'tool_call' && s.tool === 'message_bot');
    assert.ok(used || asked, `tools used: ${steps.filter((s) => s.kind === 'tool_call').map((s) => s.tool).join(',')}`);
  });

  await check('it asked the other bot rather than reading the file itself', () => {
    const handed = steps.some((s) => s.kind === 'tool_call' && s.tool === 'message_bot');
    assert.ok(handed, 'no message_bot call was made');
  });

  await check('the answer came back through the handoff', () => {
    assert.match(said, /PELICAN-7/, `said: ${said.slice(0, 200)}`);
  });

  await check('the receiving bot has its own run and conversation', () => {
    const keeperRuns = store.listRuns(keeper.id);
    assert.ok(keeperRuns.length > 0, 'the keeper should have a run of its own');
    const keeperSteps = store.listSteps(keeperRuns[0]!.id);
    const note = keeperSteps.find((s) => s.kind === 'note' && s.body.includes('Request from'));
    assert.ok(note, 'the receiving side should record who asked');
    assert.match(note!.body, /协调员/, `note said: ${note!.body}`);
  });

  await check('the chain is visible on the receiving side', () => {
    const keeperRuns = store.listRuns(keeper.id);
    const note = store.listSteps(keeperRuns[0]!.id).find((s) => s.kind === 'note');
    assert.match(note!.body, /协调员 → 资料员/, `note: ${note?.body}`);
  });
}

console.log('the receiver works under its own permissions');
{
  /*
   * A separate bot whose job allows writing.
   *
   * The first attempt reused the archivist, whose job says it does nothing but
   * report — so it refused on those grounds and never reached its gate. That
   * refusal was correct, and it made the test prove nothing about permissions.
   */
  const scribe = store.createBot(
    OWNER, '记录员',
    'You write files when asked. Keep it to exactly what was requested.',
    null, 'balanced',
  );
  await sandbox.exec('rm -f delegated.txt');

  const runId = await startRun(
    asker.id,
    'Ask 记录员 to create a file named delegated.txt containing exactly: via-handoff. ' +
      'Report what it says.',
    () => {},
  );

  // Wait for the keeper's gate to park something.
  let parked = null;
  for (let i = 0; i < 240; i++) {
    parked = store.openApprovals(OWNER).find((a) => a.botId === scribe.id);
    if (parked) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  await check("delegation does not bypass the receiver's gate", async () => {
    assert.ok(parked, 'the receiving bot should have parked its write for approval');
    const r = await sandbox.exec('test -f delegated.txt && echo EXISTS || echo missing');
    assert.match(r.stdout, /missing/, 'the write must not have happened yet');
  });

  await check('the approval is attributed to the bot doing the work', () => {
    assert.equal(parked!.botId, scribe.id, 'the prompt belongs to the writer, not the asker');
    assert.notEqual(parked!.botId, asker.id, 'the asker must not be asked to approve its own delegation');
  });

  if (parked) store.resolveApproval(parked.id, true);
  await settle(asker.id);

  await check('approving lets the delegated work through', async () => {
    const r = await sandbox.exec('cat delegated.txt 2>/dev/null || echo MISSING');
    assert.match(r.stdout, /via-handoff/, `got: ${r.stdout.slice(0, 80)}`);
  });

  await dropSession(scribe.id);
}

await dropSession(asker.id);
await dropSession(keeper.id);
console.log(`\n${passed} checks passed`);
