/**
 * A group chat with real models: a handoff chain that completes, and one that
 * is stopped.
 *
 * The unit tests cover who speaks. This covers whether a group actually gets
 * work done, and whether the guards fire against a model that is genuinely
 * trying to pass work around.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/group-live.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/group-live.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/workspaces/glive', { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

const { store } = await import('../src/agent/store.ts');
const { sendToGroup } = await import('../src/server/runtime.ts');
const { dropSession } = await import('../src/pi/runner.ts');
const { getSandbox } = await import('../src/sandbox/index.ts');
const { MAX_GROUP_HOPS } = await import('../src/server/group.ts');

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

const OWNER = 'glive';

// Two members with complementary jobs and 'full' mode, so the only thing that
// stops the exchange is the orchestration being tested.
const counter = store.createBot(
  OWNER, '统计',
  'You count things in files using the shell. You report the number and nothing else. ' +
    'You never write files.',
  null, 'full',
);
const writer = store.createBot(
  OWNER, '记录',
  'You write short files when asked. You never count anything yourself: if a number ' +
    'is needed, ask @统计 for it.',
  null, 'full',
);

const sandbox = await getSandbox(OWNER, null);
await sandbox.writeFile('items.txt', 'alpha\nbeta\ngamma\ndelta\n');
await sandbox.exec('rm -f count.txt');

const group = store.createGroup(OWNER, '清点小组', [counter.id, writer.id]);

const lines = () => store.groupMessages(group.id);
const transcript = () => lines().map((m) => {
  const who = m.botId === counter.id ? '统计' : m.botId === writer.id ? '记录' : '用户/系统';
  return `${who}: ${m.body.replace(/\n/g, ' ').slice(0, 90)}`;
}).join('\n    ');

console.log('a chain that completes');
await sendToGroup(OWNER, group.id, '@记录 把 items.txt 里的条数写进 count.txt，只写数字。');
console.log('    ' + transcript());

await check('the person’s message is in the transcript', () => {
  assert.equal(lines()[0]!.botId, null);
});
await check('the addressed bot spoke first', () => {
  const firstBot = lines().find((m) => m.botId !== null);
  assert.equal(firstBot?.botId, writer.id, 'the @ should decide who starts');
});
await check('it handed the count to the other member', () => {
  const spoke = new Set(lines().filter((m) => m.botId).map((m) => m.botId));
  assert.ok(spoke.has(counter.id), `only these spoke: ${[...spoke].join(',')}`);
});
await check('the work actually landed', async () => {
  const r = await sandbox.exec('cat count.txt 2>/dev/null || echo MISSING');
  assert.match(r.stdout, /4/, `count.txt said: ${r.stdout.trim()}`);
});
await check('each bot has its own run behind its line', () => {
  const withRun = lines().filter((m) => m.botId && m.runId);
  assert.ok(withRun.length >= 2, 'every bot line should point at the run that produced it');
  for (const m of withRun) {
    const steps = store.listSteps(m.runId!);
    assert.ok(steps.some((s) => s.kind === 'note' && s.body.includes('Group')), 'the run should say it was a group turn');
  }
});

console.log('a chain that has to be stopped');
{
  // Both bots are told to always hand back, so left alone this never settles.
  const pingBot = store.createBot(
    OWNER, '甲', 'Whatever you are asked, reply briefly and then ask @乙 to check it.',
    null, 'full',
  );
  const pongBot = store.createBot(
    OWNER, '乙', 'Whatever you are asked, reply briefly and then ask @甲 to confirm.',
    null, 'full',
  );
  const loop = store.createGroup(OWNER, '互推小组', [pingBot.id, pongBot.id]);

  await sendToGroup(OWNER, loop.id, '@甲 随便说一句话');

  const msgs = store.groupMessages(loop.id);
  const botLines = msgs.filter((m) => m.botId !== null);
  const systemNote = msgs.find((m) => m.botId === null && m.body.startsWith('（'));

  await check('the exchange stopped on its own', () => {
    assert.ok(botLines.length <= MAX_GROUP_HOPS, `${botLines.length} bot turns, limit is ${MAX_GROUP_HOPS}`);
  });
  await check('the reason it stopped is on the record', () => {
    /*
     * Two acceptable outcomes, and the first one happened in practice: the
     * model noticed the loop itself and declined to continue. Asserting only
     * that the guard fired would have failed a better result than the one it
     * was written for.
     */
    const guardFired = systemNote && /绕圈|来回/.test(systemNote.body);
    const modelDeclined = botLines.some((m) => /loop|循环|绕|no point|pointless/i.test(m.body));
    assert.ok(
      guardFired || modelDeclined,
      `neither the guard nor the model explained the stop. lines:\n${
        msgs.map((m) => m.body.replace(/\n/g, ' ').slice(0, 70)).join('\n')}`,
    );
  });

  await dropSession(pingBot.id);
  await dropSession(pongBot.id);
}

await dropSession(counter.id);
await dropSession(writer.id);
console.log(`\n${passed} checks passed`);
