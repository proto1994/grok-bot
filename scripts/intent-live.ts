/**
 * The two behaviours a real model has to get right.
 *
 * 1. A bot that has only been named opens by introducing itself and asking what
 *    to take on, with buttons.
 * 2. "Do this every day at 9" becomes a routine rather than a promise to
 *    remember.
 *
 * The unit tests prove the machinery. These prove the model reaches for it.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/intent-live.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/intent-live.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/sessions', { recursive: true, force: true });

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

const OWNER = 'intent';
const settle = async (botId: string) => {
  for (let i = 0; i < 400; i++) {
    if (!isBusy(botId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('run did not settle');
};
const steps = (runId: string) => store.listSteps(runId);
const said = (runId: string) =>
  steps(runId).filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');

/* ---------- 1. the opening question ---------- */

console.log('a newly named bot asks what it is for');
{
  // Exactly what the create sheet produces: a name and the default job.
  const bot = store.createBot(
    OWNER, '测试测试', '按用户说的做事。第一次对话会说明你负责什么。',
    null, 'full',
  );
  const runId = await startRun(
    bot.id,
    '这是你和用户的第一次对话。用一两句话介绍你能做什么（可以用沙箱里的命令行和文件、' +
      '也能通过已连接的工具做事），然后用 ask_choice 问他想先让你做哪方面的事，' +
      '给 4 到 5 个具体的方向，最后一项留个「只是先随便试试」这类出口。' +
      '不要说这是系统提示，像正常打招呼一样。',
    () => {},
  );
  await settle(bot.id);

  await check('it used the choice tool rather than listing options in prose', () => {
    const used = steps(runId).some((s) => s.kind === 'tool_call' && s.tool === 'ask_choice');
    assert.ok(used, `tools: ${steps(runId).filter((s) => s.kind === 'tool_call').map((s) => s.tool).join(',') || 'none'}`);
  });

  await check('the question and options were recorded for replay', () => {
    const note = steps(runId).find((s) => s.body.startsWith('ask_choice '));
    assert.ok(note, 'no ask_choice note');
    const q = JSON.parse(note!.body.slice('ask_choice '.length));
    assert.ok(q.question.length > 2, `question was "${q.question}"`);
    assert.ok(q.options.length >= 3, `only ${q.options.length} options`);
  });

  await check('it introduced itself in the reply', () => {
    assert.ok(said(runId).trim().length > 10, `said: ${said(runId)}`);
  });

  await check('it did not leak the instruction it was given', () => {
    // The prompt is scaffolding; repeating it breaks the illusion and confuses.
    assert.equal(/系统提示|system prompt|first conversation/i.test(said(runId)), false,
      `said: ${said(runId).slice(0, 160)}`);
  });

  await check('answering a choice carries on normally', async () => {
    const note = steps(runId).find((s) => s.body.startsWith('ask_choice '))!;
    const q = JSON.parse(note.body.slice('ask_choice '.length));
    const second = await startRun(bot.id, q.options[0], () => {});
    await settle(bot.id);
    assert.equal(store.getRun(second)!.status, 'done');
    assert.ok(said(second).trim().length > 0, 'it said nothing after the pick');
  });

  await dropSession(bot.id);
}

/* ---------- 2. scheduling ---------- */

console.log('recurring work becomes a routine');
{
  const bot = store.createBot(
    OWNER, '日程', '你负责按日程做事。需要定期做的事就排进日程。', null, 'full',
  );

  const runId = await startRun(
    bot.id,
    '从今天起，每天早上 9 点看一下昨天的数据并给我两三句话总结，' +
      '另外每天下午 4 点 45 分检查一次有没有需要处理的事。这两件都排成固定日程。',
    () => {},
  );
  await settle(bot.id);

  await check('it scheduled rather than promising to remember', () => {
    const calls = steps(runId).filter((s) => s.kind === 'tool_call' && s.tool === 'schedule_routine');
    assert.ok(calls.length >= 1, `schedule calls: ${calls.length}`);
  });

  await check('both jobs were scheduled, at the times asked for', () => {
    const rs = store.listRoutines(bot.id);
    assert.ok(rs.length >= 2, `${rs.length} routines: ${rs.map((r) => describe(r)).join(' | ')}`);
    const times = rs.map((r) => r.minuteOfDay);
    assert.ok(times.includes(9 * 60), `no 9:00 routine; got ${times.map(String).join(',')}`);
    assert.ok(times.includes(16 * 60 + 45), `no 16:45 routine; got ${times.map(String).join(',')}`);
  });

  await check('each routine has a title a person can read', () => {
    for (const r of store.listRoutines(bot.id)) {
      assert.ok(r.title.length >= 2 && r.title.length < 40, `title: "${r.title}"`);
    }
  });

  await check('the stored prompt stands on its own', () => {
    // It arrives with no conversation around it, so it cannot say "as we
    // discussed" and expect that to mean anything.
    for (const r of store.listRoutines(bot.id)) {
      assert.ok(r.prompt.length > 10, `prompt too thin: "${r.prompt}"`);
      assert.equal(/刚才|as discussed|上面说的/.test(r.prompt), false,
        `prompt leans on context that will not be there: "${r.prompt}"`);
    }
  });

  await check('it told the user what it scheduled', () => {
    assert.match(said(runId), /9|复盘|日程|例行/, `said: ${said(runId).slice(0, 200)}`);
  });

  await check('a scheduled routine can be switched off and stays off', () => {
    const r = store.listRoutines(bot.id)[0]!;
    store.setRoutineEnabled(OWNER, r.id, false);
    assert.equal(store.getRoutine(OWNER, r.id)!.enabled, false);
  });

  await dropSession(bot.id);
}

console.log(`\n${passed} checks passed`);
