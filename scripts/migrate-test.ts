/**
 * Schema migration against an OLD database.
 *
 * This exists because every other test starts from an empty file, so a column
 * added to a CREATE TABLE statement looks fine in CI and then fails on the
 * first real database. Here the old schema is built by hand first.
 *
 *   pnpm tsx scripts/migrate-test.ts
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const DB = './data/test/migrate-test.db';
mkdirSync('./data', { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

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

// ---- build a database the way an earlier version of the app did ----
{
  const old = new DatabaseSync(DB);
  old.exec(`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
      job TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, botId TEXT NOT NULL, status TEXT NOT NULL,
      startedAt INTEGER NOT NULL, endedAt INTEGER,
      steps INTEGER NOT NULL DEFAULT 0,
      tokensIn INTEGER NOT NULL DEFAULT 0, tokensOut INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, runId TEXT NOT NULL, seq INTEGER NOT NULL,
      kind TEXT NOT NULL, tool TEXT, body TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, botId TEXT NOT NULL, runId TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    -- note: no 'settled' column, as in the first version
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, runId TEXT NOT NULL, botId TEXT NOT NULL, tool TEXT NOT NULL,
      args TEXT NOT NULL, reason TEXT NOT NULL, risk TEXT NOT NULL,
      createdAt INTEGER NOT NULL, resolvedAt INTEGER, approved INTEGER
    );
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, botId TEXT NOT NULL,
      text TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
  `);

  // Pre-existing data that must survive.
  const botId = randomUUID();
  old.prepare('INSERT INTO bots VALUES (?,?,?,?,?)').run(botId, 'local', '旧 Bot', 'existing work', Date.now());
  const runId = randomUUID();
  old.prepare('INSERT INTO runs (id,botId,status,startedAt) VALUES (?,?,?,?)').run(runId, botId, 'done', Date.now());
  old.prepare('INSERT INTO steps (runId,seq,kind,tool,body,createdAt) VALUES (?,?,?,?,?,?)')
    .run(runId, 1, 'assistant_text', null, '旧消息', Date.now());
  old.close();
}

process.env.DB_PATH = DB;
const { store } = await import('../src/agent/store.ts');

console.log('migration of an existing database');
await check('the new column is added to an old table', () => {
  const db = new DatabaseSync(DB);
  const cols = (db.prepare("SELECT name FROM pragma_table_info('bots')").all() as { name: string }[])
    .map((c) => c.name);
  db.close();
  assert.ok(cols.includes('sandboxTarget'), `columns: ${cols.join(',')}`);
  assert.ok(cols.includes('providerId'), `columns: ${cols.join(',')}`);
  assert.ok(cols.includes('modelId'), `columns: ${cols.join(',')}`);
});

await check('inserting a bot works after migration', () => {
  const b = store.createBot('local', '新 Bot', 'job');
  assert.equal(store.getBot(b.id)!.sandboxTarget, null);
});

await check('a target can be set on a migrated database', () => {
  const b = store.createBot('local', '带 target', 'job', 'somewhere');
  assert.equal(store.getBot(b.id)!.sandboxTarget, 'somewhere');
});

await check('the approvals.settled column is added too', () => {
  const db = new DatabaseSync(DB);
  const cols = (db.prepare("SELECT name FROM pragma_table_info('approvals')").all() as { name: string }[])
    .map((c) => c.name);
  db.close();
  assert.ok(cols.includes('settled'), `columns: ${cols.join(',')}`);
});

await check('the approval journal works on a migrated database', () => {
  const b = store.createBot('local', 'A', 'job');
  const r = store.createRun(b.id);
  const a = store.createApproval({
    runId: r.id, botId: b.id, tool: 'shell', args: '{}', reason: 'test', risk: 'write',
  });
  assert.equal(store.pendingApprovals(r.id).length, 1);
  store.settleApproval(a.id);
  assert.equal(store.pendingApprovals(r.id).length, 0);
});

console.log('existing data survives');
await check('the old bot is still there', () => {
  const bots = store.listBots('local');
  assert.ok(bots.some((b) => b.name === '旧 Bot'), 'the pre-existing bot must not be lost');
});

await check('the old conversation is still readable', () => {
  const old = store.listBots('local').find((b) => b.name === '旧 Bot')!;
  const runs = store.listRuns(old.id);
  assert.equal(runs.length, 1);
  assert.equal(store.listSteps(runs[0]!.id)[0]!.body, '旧消息');
});

await check('tables added later are created, not migrated', () => {
  // digests and tool_executions did not exist in the old schema at all.
  store.putDigest(store.listBots('local')[0]!.id, 'summary', 7);
  assert.equal(store.claimTool('tu-x', 'r', 'shell', '{}').kind, 'run');
});

await check('the sidebar preview query runs on a migrated database', () => {
  const lines = store.lastLines('local');
  assert.ok(typeof lines === 'object');
  const old = store.listBots('local').find((b) => b.name === '旧 Bot')!;
  assert.equal(lines[old.id]?.body, '旧消息');
});

console.log('idempotency');
await check('a second open does not re-run or fail', async () => {
  const mod = await import(`../src/agent/store.ts?again=${Math.random()}`);
  assert.equal(mod.store.listBots('local').length, store.listBots('local').length);
});

console.log('providers on a migrated database');
await check('a provider can be stored without disturbing old bots', () => {
  const secret = 'sk-migrate-secret-value';
  const p = store.createProvider({
    name: 'DeepSeek', preset: 'deepseek', apiStyle: 'openai-chat-completions',
    baseUrl: 'https://api.deepseek.com', apiKey: secret,
    models: [{
      modelId: 'deepseek-chat', name: 'DeepSeek Chat',
      contextWindow: 128000, maxTokens: 8192, reasoning: false,
    }],
  });
  assert.equal(store.getProvider(p.id)?.apiKey, secret);
  const old = store.listBots('local').find((b) => b.name === '旧 Bot')!;
  assert.equal(old.providerId, null);
  assert.equal(old.modelId, null);
});

console.log(`\n${passed} checks passed`);
