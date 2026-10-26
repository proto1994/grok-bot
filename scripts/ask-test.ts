/**
 * The choice tool: what it accepts, and what it refuses.
 *
 *   pnpm tsx scripts/ask-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test/ask-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;

const { store } = await import('../src/agent/store.ts');
const { askTool, pendingQuestion, clearQuestion, MAX_CHOICES } =
  await import('../src/pi/ask.ts');
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

const bot = store.createBot('ask', '问询', 'ask the user things');
const ctx = { botId: bot.id, ownerId: 'ask' };
const run = store.createRun(bot.id);

console.log('asking');
let seen: { question: string; options: string[] } | null = null;
const tool = askTool(ctx, (q) => { seen = q; });

await check('a question with options is recorded and announced', async () => {
  const out = await tool.run(
    { question: '先做哪方面？', options: ['查资料', '写代码', '随便试试'] }, ctx,
  );
  assert.match(out, /Asked the user/);
  // The model has to stop here, or it answers its own question.
  assert.match(out, /Stop here and wait/);
  assert.ok(seen, 'the ui was not told');
  assert.equal(seen!.options.length, 3);
});

await check('it survives a reload, because it is in the step log', () => {
  const note = store.listSteps(run.id).find((s) => s.body.startsWith('ask_choice '));
  assert.ok(note, 'no step recorded');
  const parsed = JSON.parse(note!.body.slice('ask_choice '.length));
  assert.equal(parsed.question, '先做哪方面？');
});

await check('too many options are trimmed rather than refused', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `选项 ${i}`);
  await tool.run({ question: 'q', options: many }, ctx);
  assert.equal(seen!.options.length, MAX_CHOICES);
});

await check('blank options are dropped', async () => {
  await tool.run({ question: 'q', options: ['a', '  ', 'b'] }, ctx);
  assert.deepEqual(seen!.options, ['a', 'b']);
});

console.log('refusing');
await check('one option is not a choice', async () => {
  const out = await tool.run({ question: 'q', options: ['only one'] }, ctx);
  assert.match(out, /at least two/);
});
await check('no question is an error the model can fix', async () => {
  await assert.rejects(() => tool.run({ question: ' ', options: ['a', 'b'] }, ctx), /required/);
});

console.log('state');
await check('the pending question is readable and clearable', async () => {
  await tool.run({ question: '还在等？', options: ['是', '否'] }, ctx);
  assert.equal(pendingQuestion(bot.id)?.question, '还在等？');
  clearQuestion(bot.id);
  assert.equal(pendingQuestion(bot.id), undefined);
});
await check('one question at a time per bot', async () => {
  await tool.run({ question: '第一个', options: ['a', 'b'] }, ctx);
  await tool.run({ question: '第二个', options: ['c', 'd'] }, ctx);
  // A second question replaces the first: two live question cards would leave
  // the person answering something the bot has moved on from.
  assert.equal(pendingQuestion(bot.id)?.question, '第二个');
});

console.log('the gate');
await check('asking is read-only, so it does not interrupt for approval', () => {
  // Nothing happens until the person picks, and the pick is just a message.
  assert.equal(riskOf('ask_choice'), 'read');
  assert.equal(evaluate('ask_choice', 'read').decision, 'allow');
});

console.log(`\n${passed} checks passed`);
