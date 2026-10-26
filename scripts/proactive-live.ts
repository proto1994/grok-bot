/**
 * A bot schedules the recurring work its job implies, unasked.
 *
 * intent-live covers the easy half: the user says "每天早上 9 点" and a routine
 * appears. This covers the half that actually matters — nobody says a time, or
 * the word 定时, or anything else to trigger on. The bot is told what it is for
 * and has to work out on its own that the job is not a one-off.
 *
 * Also covers the restraint, which is the same prompt's other edge: a job that
 * is genuinely one-off must not get a schedule, and a bot must not re-schedule
 * something it already runs.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/proactive-live.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/proactive-live.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/sessions', { recursive: true, force: true });
rmSync('./data/test/workspaces/proactive', { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

const { store } = await import('../src/agent/store.ts');
const { startRun, isBusy } = await import('../src/server/runtime.ts');
const { dropSession } = await import('../src/pi/runner.ts');
const { describe } = await import('../src/agent/routines.ts');

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

/*
 * A workspace per section.
 *
 * Sandboxes are keyed by owner, so reusing one owner gave every bot the same
 * files — the balanced bot found an earlier section's note.txt, went to read
 * it, and parked on that instead of ever reaching its own schedule.
 */
const OWNER = 'proactive';
const OWNER_ONEOFF = 'proactive-oneoff';
const OWNER_BALANCED = 'proactive-balanced';

const settle = async (botId: string) => {
  for (let i = 0; i < 400; i++) {
    if (!isBusy(botId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('run did not settle');
};
const said = (runId: string) =>
  store.listSteps(runId).filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');
const routinesOf = (botId: string) =>
  store.listRoutines(botId).map((r) => `${describe(r)} ${r.title}`).join(' | ');

/* ---------- 1. standing work gets scheduled with nobody asking ---------- */

console.log('a watching job puts itself on a schedule');
{
  const bot = store.createBot(
    OWNER, '盯梢', '盯着 AI 行业的新进展，有值得知道的就告诉我。', null, 'full',
  );

  // Not a time, not a cadence, not the word 定时. Just the job.
  const runId = await startRun(
    bot.id,
    '你就负责这个。我不想每次都来问你有没有新东西，你自己安排。',
    () => {},
  );
  await settle(bot.id);

  await check('it scheduled something without being given a time', () => {
    const rs = store.listRoutines(bot.id);
    assert.ok(rs.length >= 1, `no routines; tools used: ${
      store.listSteps(runId).filter((s) => s.kind === 'tool_call').map((s) => s.tool).join(',') || 'none'
    }`);
  });

  await check('it showed restraint rather than filling the list', () => {
    const n = store.listRoutines(bot.id).length;
    assert.ok(n <= 3, `${n} routines on a first exchange: ${routinesOf(bot.id)}`);
  });

  await check('the cadence is plausible for the thing being watched', () => {
    for (const r of store.listRoutines(bot.id)) {
      // Not 3am: a digest nobody is awake for is a digest nobody reads.
      assert.ok(r.minuteOfDay >= 6 * 60 && r.minuteOfDay <= 23 * 60,
        `scheduled at ${describe(r)}`);
    }
  });

  await check('each routine prompt stands on its own', () => {
    for (const r of store.listRoutines(bot.id)) {
      assert.ok(r.prompt.length > 10, `prompt too thin: "${r.prompt}"`);
      assert.equal(/刚才|上面说的|as discussed|我们说的/.test(r.prompt), false,
        `leans on absent context: "${r.prompt}"`);
    }
  });

  await check('it told the user what it set up and why', () => {
    assert.match(said(runId), /日程|安排|每天|定期|例行/, `said: ${said(runId).slice(0, 200)}`);
  });

  /* ---------- 2. it does not schedule the same thing twice ---------- */

  const before = store.listRoutines(bot.id).length;
  const again = await startRun(bot.id, '继续保持。', () => {});
  await settle(bot.id);

  await check('a nudge does not duplicate what it already runs', () => {
    const after = store.listRoutines(bot.id).length;
    assert.ok(after <= before, `${before} -> ${after}: ${routinesOf(bot.id)}`);
  });

  await check('it checked its own schedule before adding to it', () => {
    const tools = store.listSteps(again).filter((s) => s.kind === 'tool_call').map((s) => s.tool);
    // Either it listed first, or it added nothing at all. Both are right.
    assert.ok(
      tools.includes('list_routines') || !tools.includes('schedule_routine'),
      `tools: ${tools.join(',') || 'none'}`,
    );
  });

  await dropSession(bot.id);
}

/* ---------- 3. a one-off stays a one-off ---------- */

console.log('a one-off job does not get a schedule');
{
  const bot = store.createBot(
    OWNER_ONEOFF, '一次性', '按用户说的做事。', null, 'full',
  );
  const runId = await startRun(
    bot.id,
    '在工作区建一个 note.txt，里面写一行 hello。做完就行。',
    () => {},
  );
  await settle(bot.id);

  await check('it did the work', async () => {
    const { getSandbox } = await import('../src/sandbox/index.ts');
    const sb = await getSandbox(OWNER_ONEOFF, null);
    const r = await sb.exec('cat note.txt 2>/dev/null || echo MISSING');
    assert.match(r.stdout, /hello/i, r.stdout.slice(0, 80));
  });

  await check('it did not invent a schedule for it', () => {
    assert.equal(store.listRoutines(bot.id).length, 0, routinesOf(bot.id));
  });

  await dropSession(bot.id);
}

/* ---------- 4. unasked still means approved ---------- */

console.log('scheduling itself still goes through approval');
{
  /*
   * balanced is what the create sheet produces, so this is the real default.
   *
   * The job has to be concrete. An earlier version said "盯着一个数据源" and the
   * bot quite rightly asked which one instead of scheduling — restraint the
   * prompt asks for, but it left this section measuring nothing.
   */
  const bot = store.createBot(
    OWNER_BALANCED, '默认档', '盯着 AI 行业的新进展，有值得知道的就告诉我。', null, 'balanced',
  );

  /*
   * Everything except scheduling is waved through, in the background.
   *
   * A balanced bot parks on its first write of any kind. Waiting only for a
   * schedule_routine approval meant an earlier bash call sat unanswered and the
   * bot never got far enough to schedule anything — the gate was working and
   * the test read it as the gate failing.
   */
  let waved = 0;
  const approver = setInterval(() => {
    for (const a of store.openApprovals(OWNER_BALANCED)) {
      if (a.tool !== 'schedule_routine') {
        store.resolveApproval(a.id, true);
        waved++;
      }
    }
  }, 300);

  const task = startRun(bot.id, '你自己安排着来，不用每次等我问。', () => {});

  try {
    let parked;
    for (let i = 0; i < 400; i++) {
      parked = store.openApprovals(OWNER_BALANCED).find((a) => a.tool === 'schedule_routine');
      if (parked) break;
      if (!isBusy(bot.id)) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    await check('a routine it chose itself parks for approval', () => {
      assert.ok(parked,
        `nothing parked; a bot scheduled unprompted work unattended (${waved} other calls waved through)`);
    });

    await check('the approval card says what it wants to commit to', () => {
      assert.ok((parked!.reason ?? '').length > 4, `reason: "${parked?.reason}"`);
    });

    await check('nothing it was refused ends up on the schedule', async () => {
      /*
       * Every schedule_routine gets denied, not just the first.
       *
       * A bot planning a daily digest and a weekly round-up asks twice, and
       * denying one does not withdraw the other — the second parked with nobody
       * answering and the turn never ended. The property is that no routine
       * lands without approval, so refuse all of them and let the turn finish.
       */
      let denied = 0;
      const denier = setInterval(() => {
        for (const a of store.openApprovals(OWNER_BALANCED)) {
          if (a.tool === 'schedule_routine') {
            store.resolveApproval(a.id, false);
            denied++;
          }
        }
      }, 300);
      try {
        await task;
        await settle(bot.id);
      } finally {
        clearInterval(denier);
      }
      assert.ok(denied >= 1, 'nothing was denied');
      assert.equal(store.listRoutines(bot.id).length, 0, routinesOf(bot.id));
    });
  } finally {
    clearInterval(approver);
    await dropSession(bot.id);
  }
}

console.log(`\n${passed} checks passed`);
