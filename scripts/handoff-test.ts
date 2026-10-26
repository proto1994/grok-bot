/**
 * Bot-to-bot handoff: the guards, without a model.
 *
 * One bot asking another is the first place a bot can spend money and touch
 * systems with nobody watching that step, so the cases that matter are the ones
 * that refuse: cycles, depth, a busy receiver, a bot that does not exist.
 *
 *   pnpm tsx scripts/handoff-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = './data/test/handoff-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;

const { store } = await import('../src/agent/store.ts');
const {
  checkChain, describeChain, listBotsTool, messageBotTool, MAX_HOPS,
} = await import('../src/pi/handoff.ts');
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

const OWNER = 'handoff';
const a = store.createBot(OWNER, '研究员', 'gather source material');
const b = store.createBot(OWNER, '撰稿', 'turn findings into a draft');
const c = store.createBot(OWNER, '审核', 'check a draft against sources');
const other = store.createBot('someone-else', '别人的', 'not reachable');

const ctx = (botId: string) => ({ botId, ownerId: OWNER });

/** A deliver that records calls instead of running a model. */
function spy(busy: string[] = []) {
  const calls: { to: string; text: string; path: string[] }[] = [];
  return {
    calls,
    deps: {
      isBusy: (id: string) => busy.includes(id),
      deliver: async (to: string, text: string, chain: { path: string[] }) => {
        calls.push({ to, text, path: chain.path });
        return `Sent to ${store.getBot(to)?.name}. It is working on this now and its ` +
          `reply will reach you as a new message; you do not need to wait.`;
      },
    },
  };
}

console.log('discovery');
await check('a bot sees its peers and their jobs', async () => {
  const out = await listBotsTool(ctx(a.id)).run({}, ctx(a.id));
  assert.match(out, /撰稿/);
  assert.match(out, /turn findings into a draft/);
});
await check('it does not see itself', async () => {
  const out = await listBotsTool(ctx(a.id)).run({}, ctx(a.id));
  assert.equal(out.includes('研究员'), false, 'a bot listing itself invites self-handoff');
});
await check("it does not see another owner's bots", async () => {
  const out = await listBotsTool(ctx(a.id)).run({}, ctx(a.id));
  assert.equal(out.includes('别人的'), false);
});
await check('a bot running unattended is flagged in the listing', async () => {
  store.setPermissionMode(c.id, 'full');
  const out = await listBotsTool(ctx(a.id)).run({}, ctx(a.id));
  assert.match(out, /审核.*runs unattended/);
  store.setPermissionMode(c.id, 'balanced');
});

console.log('delivery');
await check('a request reaches the named bot', async () => {
  const s = spy();
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  const out = await tool.run({ bot: '撰稿', request: 'draft this' }, ctx(a.id));
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.to, b.id);
  assert.match(out, /撰稿 replied/);
});
await check('the chain grows by one hop', async () => {
  const s = spy();
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  await tool.run({ bot: '撰稿', request: 'x' }, ctx(a.id));
  assert.deepEqual(s.calls[0]!.path, [a.id, b.id]);
});
await check('the name match is case-insensitive', async () => {
  const s = spy();
  const en = store.createBot(OWNER, 'Reviewer', 'review');
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  await tool.run({ bot: 'reviewer', request: 'x' }, ctx(a.id));
  assert.equal(s.calls[0]!.to, en.id);
});

console.log('refusals');
await check('a cycle is refused before any work happens', async () => {
  // A → B → A: the case that would otherwise bill until someone noticed.
  const s = spy();
  const tool = messageBotTool(ctx(b.id), () => ({ path: [a.id, b.id] }), s.deps);
  const out = await tool.run({ bot: '研究员', request: 'back to you' }, ctx(b.id));
  assert.match(out, /Handoff refused/);
  assert.match(out, /would loop/);
  assert.equal(s.calls.length, 0, 'nothing may be delivered');
});
await check('the depth limit stops a long chain', async () => {
  const s = spy();
  const deep = { path: Array.from({ length: MAX_HOPS }, (_, i) => `x${i}`) };
  const tool = messageBotTool(ctx(a.id), () => deep, s.deps);
  const out = await tool.run({ bot: '撰稿', request: 'x' }, ctx(a.id));
  assert.match(out, /passed through/);
  assert.equal(s.calls.length, 0);
});
await check('a busy bot is refused rather than queued', async () => {
  const s = spy([b.id]);
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  const out = await tool.run({ bot: '撰稿', request: 'x' }, ctx(a.id));
  assert.match(out, /already working/);
  assert.equal(s.calls.length, 0, 'a fan-out must not become a backlog');
});
await check('an unknown bot is refused with the list of real ones', async () => {
  const s = spy();
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  const out = await tool.run({ bot: '不存在', request: 'x' }, ctx(a.id));
  assert.match(out, /no bot called/);
  assert.match(out, /撰稿/);
  assert.equal(s.calls.length, 0);
});
await check("another owner's bot is not reachable by name", async () => {
  const s = spy();
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  const out = await tool.run({ bot: '别人的', request: 'x' }, ctx(a.id));
  assert.match(out, /no bot called/);
  assert.equal(s.calls.length, 0);
});
await check('an empty request is rejected', async () => {
  const s = spy();
  const tool = messageBotTool(ctx(a.id), () => ({ path: [a.id] }), s.deps);
  await assert.rejects(() => tool.run({ bot: '撰稿', request: '  ' }, ctx(a.id)), /required/);
});

console.log('replies are not another hop');
await check('a reply carries the path without extending it', () => {
  // An exchange would otherwise exhaust the depth limit on ordinary back and
  // forth, while still needing the path so a reply cannot be answered by asking
  // the same bot again.
  const chain = { path: [a.id, b.id], isReply: true };
  assert.equal(checkChain(chain, c.id), null, 'a fresh bot is still reachable');
  assert.match(String(checkChain(chain, a.id)), /would loop/, 'going back is still a cycle');
});

console.log('chain helpers');
await check('checkChain accepts a fresh hop', () => {
  assert.equal(checkChain({ path: [a.id] }, b.id), null);
});
await check('describeChain names the bots', () => {
  assert.equal(describeChain({ path: [a.id, b.id] }), '研究员 → 撰稿');
});

console.log('the gate still governs a handoff');
await check('message_bot counts as external, so it asks', () => {
  assert.equal(riskOf('message_bot'), 'external');
  assert.equal(evaluate('message_bot', 'external').decision, 'ask');
});
await check('list_bots is read-only and runs freely', () => {
  assert.equal(riskOf('list_bots'), 'read');
  assert.equal(evaluate('list_bots', 'read').decision, 'allow');
});

console.log(`\n${passed} checks passed`);
