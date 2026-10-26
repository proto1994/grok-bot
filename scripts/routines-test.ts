/**
 * Routines: parsing, due-ness, and the scheduler's restraint.
 *
 * The parsing cases matter because the model writes times and days in whatever
 * mixture of Chinese and English it feels like. The due-ness cases matter more:
 * getting them wrong means either silence or a burst of unasked-for work.
 *
 *   pnpm tsx scripts/routines-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test/routines-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;

const { store } = await import('../src/agent/store.ts');
const {
  describe, isDue, parseDays, parseTime, formatTime, MAX_ROUTINES_PER_BOT,
} = await import('../src/agent/routines.ts');
const { tick } = await import('../src/server/scheduler.ts');
const { scheduleTool, listRoutinesTool } = await import('../src/pi/schedule-tool.ts');
const { riskOf } = await import('../src/pi/gate.ts');
const { evaluate } = await import('../src/agent/policy.ts');

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

console.log('reading a time');
await check('common forms parse', () => {
  assert.equal(parseTime('9:00'), 540);
  assert.equal(parseTime('09:00'), 540);
  assert.equal(parseTime('16:45'), 1005);
  assert.equal(parseTime('0'), 0);
  assert.equal(parseTime(' 23:59 '), 1439);
  assert.equal(parseTime('9：30'), 570); // full-width colon
});
await check('nonsense is rejected rather than guessed', () => {
  for (const bad of ['', 'soon', '25:00', '9:70', 'abc', '-1']) {
    assert.equal(parseTime(bad), null, `"${bad}" should not parse`);
  }
});
await check('formatting round-trips', () => {
  for (const m of [0, 540, 1005, 1439]) assert.equal(parseTime(formatTime(m)), m);
});

console.log('reading days');
await check('every day is the empty set', () => {
  for (const t of ['每天', 'daily', 'every day', '', undefined]) {
    assert.deepEqual(parseDays(t), []);
  }
});
await check('weekdays and weekends', () => {
  assert.deepEqual(parseDays('工作日'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('weekday'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('周末'), [0, 6]);
});
await check('a list of named days, in either language', () => {
  assert.deepEqual(parseDays('周一、周三'), [1, 3]);
  assert.deepEqual(parseDays('mon, wed'), [1, 3]);
  assert.deepEqual(parseDays(['周二', 5]), [2, 5]);
});
await check('duplicates collapse and order is stable', () => {
  assert.deepEqual(parseDays('周一,周一,周三'), [1, 3]);
});
await check('something unreadable means every day, not no days', () => {
  // "regularly" with an unparseable qualifier should still run.
  assert.deepEqual(parseDays('whenever'), []);
});

console.log('describing a schedule');
await check('it reads the way a person would say it', () => {
  assert.equal(describe({ minuteOfDay: 540, days: [] }), '每天 9:00');
  assert.equal(describe({ minuteOfDay: 1005, days: [1, 2, 3, 4, 5] }), '工作日 16:45');
  assert.equal(describe({ minuteOfDay: 600, days: [0, 6] }), '周末 10:00');
  assert.equal(describe({ minuteOfDay: 600, days: [1, 3] }), '周一、周三 10:00');
});

console.log('when a routine is due');
const base = {
  id: 'r', botId: 'b', title: 't', prompt: 'p',
  minuteOfDay: 9 * 60, days: [] as number[], enabled: true,
  createdAt: 0, lastRunAt: null as number | null, lastRunId: null,
};
const at = (h: number, m = 0, day = 3) => {
  const d = new Date(2026, 0, 7, h, m); // a Wednesday
  assert.equal(d.getDay(), day);
  return d;
};

await check('due inside its window', () => {
  assert.equal(isDue(base, at(9, 0)), true);
  assert.equal(isDue(base, at(9, 25)), true);
});
await check('not due before its time', () => {
  assert.equal(isDue(base, at(8, 59)), false);
});
await check('not due long after, so a late start does not fire everything', () => {
  // The case this exists for: a laptop opened at noon should not set the
  // morning's jobs running at once.
  assert.equal(isDue(base, at(12, 0)), false);
});
await check('switched off never fires', () => {
  assert.equal(isDue({ ...base, enabled: false }, at(9, 0)), false);
});
await check('a day it is not scheduled for is skipped', () => {
  assert.equal(isDue({ ...base, days: [1] }, at(9, 0)), false);
  assert.equal(isDue({ ...base, days: [3] }, at(9, 0)), true);
});
await check('it does not fire twice in one day', () => {
  const ranToday = { ...base, lastRunAt: at(9, 1).getTime() };
  assert.equal(isDue(ranToday, at(9, 20)), false);
});
await check('it fires again the next day', () => {
  const yesterday = new Date(2026, 0, 6, 9, 1).getTime();
  assert.equal(isDue({ ...base, lastRunAt: yesterday }, at(9, 5)), true);
});

console.log('the scheduler');
const bot = store.createBot('sched', '定时', 'do scheduled work', null, 'full');
const r1 = store.createRoutine(bot.id, {
  title: '每日复盘', prompt: '看一下昨天的数据', minuteOfDay: 9 * 60, days: [],
});

await check('a due routine starts a run', async () => {
  const started: string[] = [];
  const fired = await tick({
    ownerId: 'sched',
    startRun: async (botId, text) => { started.push(text); return 'run-1'; },
    isBusy: () => false,
  }, at(9, 2));
  assert.equal(fired.length, 1);
  assert.match(started[0]!, /例行任务：每日复盘/);
  assert.match(started[0]!, /看一下昨天的数据/);
});

await check('firing is recorded, so it does not repeat', async () => {
  const r = store.getRoutine('sched', r1.id)!;
  assert.ok(r.lastRunAt, 'lastRunAt should be set');
  const again = await tick({
    ownerId: 'sched', startRun: async () => 'run-2', isBusy: () => false,
  }, at(9, 10));
  assert.equal(again.length, 0, 'it should not fire twice in a day');
});

await check('a busy bot is skipped rather than queued', async () => {
  store.createRoutine(bot.id, {
    title: '下午检查', prompt: '看看进度', minuteOfDay: 14 * 60, days: [],
  });
  const fired = await tick({
    ownerId: 'sched', startRun: async () => 'run-3', isBusy: () => true,
  }, at(14, 1));
  // Mid-conversation, a surprise second task is worse than a late report.
  assert.equal(fired.length, 0);
});

await check('a switched-off routine is left alone', async () => {
  const r = store.listRoutines(bot.id).find((x) => x.title === '下午检查')!;
  store.setRoutineEnabled('sched', r.id, false);
  const fired = await tick({
    ownerId: 'sched', startRun: async () => 'run-4', isBusy: () => false,
  }, at(14, 2));
  assert.equal(fired.length, 0);
});

console.log('the tool');
const ctx = { botId: bot.id, ownerId: 'sched' };
await check('scheduling works and reports the schedule back', async () => {
  const out = await scheduleTool(ctx, () => {}).run(
    { title: '晚间汇总', prompt: '汇总今天', time: '21:30', days: '每天' }, ctx,
  );
  assert.match(out, /每天 21:30/);
  assert.ok(store.listRoutines(bot.id).some((r) => r.title === '晚间汇总'));
});
await check('an unreadable time is refused with an example', async () => {
  const out = await scheduleTool(ctx, () => {}).run(
    { title: 'x', prompt: 'y', time: 'sometime' }, ctx,
  );
  assert.match(out, /Could not read/);
});
await check('two routines at the same time are refused', async () => {
  const out = await scheduleTool(ctx, () => {}).run(
    { title: '另一个', prompt: 'z', time: '21:30', days: '每天' }, ctx,
  );
  assert.match(out, /already runs at the same time/);
});
await check('the per-bot limit holds', async () => {
  for (let i = 0; i < MAX_ROUTINES_PER_BOT; i++) {
    await scheduleTool(ctx, () => {}).run(
      { title: `t${i}`, prompt: 'p', time: `${(i % 12) + 1}:0${i % 10}` }, ctx,
    );
  }
  const out = await scheduleTool(ctx, () => {}).run(
    { title: 'one too many', prompt: 'p', time: '23:59' }, ctx,
  );
  assert.match(out, /which is the limit/);
});
await check('listing shows what is scheduled and what is off', async () => {
  const out = await listRoutinesTool(ctx).run({}, ctx);
  assert.match(out, /每日复盘/);
  assert.match(out, /switched off/);
});

console.log('the gate still governs scheduling');
await check('scheduling asks, listing does not', () => {
  // Committing a bot to act unprompted is a change like any other.
  assert.equal(riskOf('schedule_routine'), 'write');
  assert.equal(evaluate('schedule_routine', 'write').decision, 'ask');
  assert.equal(riskOf('list_routines'), 'read');
  assert.equal(evaluate('list_routines', 'read').decision, 'allow');
});

console.log('ownership');
await check("another owner cannot see or change a routine", () => {
  assert.equal(store.getRoutine('someone-else', r1.id), undefined);
  assert.equal(store.setRoutineEnabled('someone-else', r1.id, false), undefined);
  assert.equal(store.deleteRoutine('someone-else', r1.id), false);
  assert.ok(store.getRoutine('sched', r1.id), 'it must still be there');
});
await check('deleting a bot takes its routines', () => {
  const temp = store.createBot('sched', '临时', 'x');
  store.createRoutine(temp.id, { title: 'gone', prompt: 'p', minuteOfDay: 60, days: [] });
  store.deleteBot('sched', temp.id);
  assert.equal(store.listRoutines(temp.id).length, 0);
});

console.log(`\n${passed} checks passed`);
