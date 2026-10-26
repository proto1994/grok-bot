/**
 * A turn cannot hang forever, and waiting for a person is not hanging.
 *
 * One turn stalled for 7281 seconds in testing — the approval it needed came
 * back in a second, then the model call never returned. Nothing bounded it, so
 * the bot stayed busy and every queued message sat behind it.
 *
 * The two things worth proving: the ceiling fires, and an approval that takes
 * longer than the ceiling does not trip it.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/budget-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/budget-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/sessions', { recursive: true, force: true });
rmSync('./data/test/workspaces/budget', { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';
// Short enough to observe, long enough for a real turn to finish inside it.
process.env.MAX_WALLCLOCK_MS = '25000';

const { store } = await import('../src/agent/store.ts');
const { startRun, isBusy } = await import('../src/server/runtime.ts');
const { dropSession } = await import('../src/pi/runner.ts');

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

const OWNER = 'budget';
const settle = async (botId: string, limitMs = 180_000) => {
  const t0 = Date.now();
  while (isBusy(botId)) {
    if (Date.now() - t0 > limitMs) throw new Error('did not settle');
    await new Promise((r) => setTimeout(r, 500));
  }
};

console.log('an ordinary turn finishes well inside the budget');
{
  const bot = store.createBot(OWNER, '快', 'answer briefly', null, 'full');
  const runId = await startRun(bot.id, '只回一个字：好', () => {});
  await settle(bot.id);

  await check('it completed rather than being cut off', () => {
    const run = store.getRun(runId)!;
    assert.equal(run.status, 'done', run.error ?? '');
  });
  await check('nothing was recorded as a stall', () => {
    const notes = store.listSteps(runId).filter((s) => s.kind === 'note').map((s) => s.body).join(' ');
    assert.equal(/先停下来了/.test(notes), false, notes);
  });
  await dropSession(bot.id);
}

console.log('a slow decision does not count against the budget');
{
  // balanced, so the write parks; nobody answers for longer than the ceiling.
  const bot = store.createBot(OWNER, '等人', 'write files when asked', null, 'balanced');
  const task = startRun(bot.id, '用 write 工具建一个文件 slow.txt，内容是 ok。', () => {});

  let approval;
  for (let i = 0; i < 120; i++) {
    approval = store.openApprovals(OWNER)[0];
    if (approval) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(approval, 'the write should have parked');

  // Sit on it for longer than the whole budget.
  await new Promise((r) => setTimeout(r, 32_000));

  await check('the turn is still alive after a long wait', () => {
    assert.ok(isBusy(bot.id), 'the bot gave up while waiting for a person');
  });

  store.resolveApproval(approval!.id, true);
  const runId = await task;
  await settle(bot.id);

  await check('approving late still completes the work', async () => {
    const run = store.getRun(runId)!;
    assert.equal(run.status, 'done', run.error ?? '');
    const { getSandbox } = await import('../src/sandbox/index.ts');
    const sb = await getSandbox(OWNER, null);
    const r = await sb.exec('cat slow.txt 2>/dev/null || echo MISSING');
    assert.match(r.stdout, /ok/, r.stdout.slice(0, 80));
  });

  await dropSession(bot.id);
}

console.log('a turn that will not end gets cut off');
{
  // full mode, so the sleep runs unattended: no approval, nothing parked, the
  // working clock just runs past the 25s ceiling.
  const bot = store.createBot(OWNER, '卡住', 'run exactly what you are told', null, 'full');
  const runId = await startRun(bot.id, '用 bash 执行：sleep 120', () => {});
  const t0 = Date.now();
  await settle(bot.id, 120_000);
  const elapsed = Date.now() - t0;

  await check('it stopped near the ceiling, not at the command length', () => {
    assert.ok(elapsed < 90_000, `took ${Math.round(elapsed / 1000)}s`);
  });
  await check('the run is marked failed with a reason a person can read', () => {
    const run = store.getRun(runId)!;
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /先停下来了/, run.error ?? '(no error)');
  });
  await check('the bot is free for the next message', () => {
    assert.equal(isBusy(bot.id), false);
  });
  await check('a follow-up message runs normally afterwards', async () => {
    const next = await startRun(bot.id, '只回一个字：好', () => {});
    await settle(bot.id);
    assert.equal(store.getRun(next)!.status, 'done', store.getRun(next)!.error ?? '');
  });

  await dropSession(bot.id);
}

console.log(`\n${passed} checks passed`);
