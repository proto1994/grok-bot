/**
 * Group chat: mention parsing, turn planning, and the loop guards.
 *
 * The orchestration decides who speaks and when to stop. Getting "when to stop"
 * wrong is what turns a group into a bill, so most of this is about stopping.
 *
 *   pnpm tsx scripts/group-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test/group-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;

const { store } = await import('../src/agent/store.ts');
const {
  groupPrompt, MAX_GROUP_HOPS, parseMentions, planTurns, renderTranscript, routeToMember,
} = await import('../src/server/group.ts');
const { GROUP_MAX, GROUP_MIN } = await import('../src/protocol.ts');

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

const OWNER = 'grp';
const researcher = store.createBot(OWNER, '研究员', 'gather sources and link every claim');
const writer = store.createBot(OWNER, '撰稿', 'turn findings into a draft');
const reviewer = store.createBot(OWNER, '审核', 'check a draft against its sources');
const reviewer2 = store.createBot(OWNER, '审核员', 'a second reviewer with a longer name');
const members = [researcher, writer, reviewer];

console.log('mentions');
await check('a named member is the target', () => {
  const m = parseMentions('@撰稿 把这些写成草稿', members);
  assert.deepEqual(m.targets.map((b) => b.name), ['撰稿']);
  assert.equal(m.everyone, false);
});
await check('several mentions are all captured', () => {
  const m = parseMentions('@研究员 找资料，然后 @撰稿 写', members);
  assert.deepEqual(m.targets.map((b) => b.name).sort(), ['撰稿', '研究员']);
});
await check('a longer name wins over a prefix of it', () => {
  // "@审核员" must not be read as "@审核" plus stray text.
  const both = [reviewer, reviewer2];
  const m = parseMentions('@审核员 看一下', both);
  assert.deepEqual(m.targets.map((b) => b.name), ['审核员']);
});
await check('@everyone addresses the group', () => {
  for (const text of ['@everyone 汇报进度', '@所有人 汇报进度', '@全体 汇报']) {
    assert.equal(parseMentions(text, members).everyone, true, text);
  }
});
await check('an unaddressed message has no target', () => {
  const m = parseMentions('这个项目进展怎么样', members);
  assert.equal(m.targets.length, 0);
  assert.equal(m.everyone, false);
});
await check('a name that is not a member is reported, not silently ignored', () => {
  const m = parseMentions('@张三 帮个忙', members);
  assert.equal(m.targets.length, 0);
  assert.deepEqual(m.unknown, ['张三']);
});
await check('@everyone is not mistaken for an unknown member', () => {
  assert.deepEqual(parseMentions('@everyone go', members).unknown, []);
});

console.log('turn planning');
await check('a mention plans that one turn', () => {
  const turns = planTurns(parseMentions('@撰稿 写', members), members);
  assert.deepEqual(turns.map((t) => t.bot.name), ['撰稿']);
});
await check('@everyone plans one turn each, in member order', () => {
  const turns = planTurns(parseMentions('@everyone 汇报', members), members);
  assert.deepEqual(turns.map((t) => t.bot.name), ['研究员', '撰稿', '审核']);
});
await check('no mention plans nothing, leaving it to routing', () => {
  assert.deepEqual(planTurns(parseMentions('进展？', members), members), []);
});

console.log('routing an unaddressed message');
await check('it picks the member a router names', async () => {
  const picked = await routeToMember('帮我核对草稿和来源', members, async () => '3');
  assert.equal(picked?.name, '审核');
});
await check('0 means nobody fits, and that is surfaced', async () => {
  // Guessing would be worse: the wrong bot answering is harder to notice than
  // being asked who should.
  assert.equal(await routeToMember('今天天气', members, async () => '0'), null);
});
await check('a number out of range is treated as no answer', async () => {
  assert.equal(await routeToMember('x', members, async () => '99'), null);
});
await check('prose around the number still parses', async () => {
  const picked = await routeToMember('x', members, async () => '应该是 2 号');
  assert.equal(picked?.name, '撰稿');
});
await check('a single-member group needs no routing call', async () => {
  let asked = false;
  const picked = await routeToMember('x', [writer], async () => { asked = true; return '1'; });
  assert.equal(picked?.name, '撰稿');
  assert.equal(asked, false, 'with one member there is nothing to decide');
});

console.log('the group transcript');
const group = store.createGroup(OWNER, '发布小组', members.map((b) => b.id));
await check('members come back in a stable order', () => {
  assert.deepEqual(store.groupMembers(group.id).map((b) => b.name), ['研究员', '撰稿', '审核']);
});
await check('messages are stored with their author', () => {
  store.addGroupMessage(group.id, null, '开始吧');
  store.addGroupMessage(group.id, researcher.id, '我找到了三份资料');
  const msgs = store.groupMessages(group.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.botId, null, 'the person is stored as null');
  assert.equal(msgs[1]!.botId, researcher.id);
});
await check('the transcript names each speaker', () => {
  const t = renderTranscript(group, members);
  assert.match(t, /用户: 开始吧/);
  assert.match(t, /研究员: 我找到了三份资料/);
});
await check('a bot is told who else is in the group and what they do', () => {
  const p = groupPrompt(group, members, writer, 1);
  assert.match(p, /@研究员 — gather sources/);
  assert.match(p, /@审核 — check a draft/);
  assert.equal(p.includes('@撰稿 —'), false, 'it should not be listed to itself');
});
await check('it is told to hand off to one bot, not several', () => {
  const p = groupPrompt(group, members, writer, 1);
  assert.match(p, /Mention one, not several/);
});
await check('it is warned when the exchange is nearly out of budget', () => {
  const early = groupPrompt(group, members, writer, 1);
  const late = groupPrompt(group, members, writer, MAX_GROUP_HOPS - 1);
  assert.equal(/already gone back and forth/.test(early), false);
  assert.match(late, /already gone back and forth/);
});

console.log('group size');
await check('the bounds are two to six', () => {
  assert.equal(GROUP_MIN, 2);
  assert.equal(GROUP_MAX, 6);
});
await check('groups are scoped to their owner', () => {
  assert.equal(store.getGroup('someone-else', group.id), undefined);
  assert.ok(store.getGroup(OWNER, group.id));
});
await check('deleting a group takes its messages with it', () => {
  const temp = store.createGroup(OWNER, '临时', [writer.id, reviewer.id]);
  store.addGroupMessage(temp.id, null, 'hello');
  assert.equal(store.deleteGroup(OWNER, temp.id), true);
  assert.equal(store.getGroup(OWNER, temp.id), undefined);
  assert.equal(store.groupMessages(temp.id).length, 0);
});
await check("another owner cannot delete a group", () => {
  assert.equal(store.deleteGroup('someone-else', group.id), false);
  assert.ok(store.getGroup(OWNER, group.id), 'it must still be there');
});

console.log(`\n${passed} checks passed`);
