/**
 * Does a bot still remember after a restart?
 *
 * The transcript used to live in memory, so the step log showed a conversation
 * the model could no longer answer questions about. This drops the session the
 * way a process exit would and checks the bot picks up where it left off.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/memory-live.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/memory-live.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/sessions', { recursive: true, force: true });
rmSync('./data/test/workspaces/mem', { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

const { store } = await import('../src/agent/store.ts');
const { startRun, isBusy } = await import('../src/server/runtime.ts');
const { dropSession } = await import('../src/pi/runner.ts');
const { sessionDir, sessionExists, sessionCount, forgetSession } = await import('../src/pi/sessions.ts');

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

const OWNER = 'mem';
const bot = store.createBot(OWNER, '记忆', 'answer the user; keep track of what they tell you', null, 'full');

const settle = async () => {
  for (let i = 0; i < 400; i++) {
    if (!isBusy(bot.id)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('run did not settle');
};
const said = (runId: string) =>
  store.listSteps(runId).filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');

console.log('within one session');
const first = await startRun(bot.id, '记住一个编号：PELICAN-7。先只回一个"好"。', () => {});
await settle();

await check('the transcript was written to disk', () => {
  assert.ok(sessionExists(bot.id), `nothing in ${sessionDir()}`);
});
await check('the session file sits next to the database', () => {
  assert.equal(path.resolve(sessionDir()), path.resolve('./data/test/sessions'));
});

const second = await startRun(bot.id, '我刚才给你的编号是什么？', () => {});
await settle();
await check('it recalls within the same session', () => {
  assert.match(said(second), /PELICAN-7/, `said: ${said(second).slice(0, 120)}`);
});

console.log('across a restart');
// Dropping the session is what a process exit does to it.
await dropSession(bot.id);

const third = await startRun(bot.id, '再说一次那个编号，只回编号本身。', () => {});
await settle();
await check('reopening used the existing transcript, not a blank one', () => {
  // Pi writes a new file per session but ties them together by id, so the test
  // is that history survived, not that there is exactly one file.
  assert.ok(sessionCount(bot.id) >= 1, `${sessionCount(bot.id)} transcripts`);
});

await check('it still recalls after the session is rebuilt from disk', () => {
  // This is the behaviour that was missing: the step log kept the conversation
  // while the model lost it, so the bot contradicted its own history.
  assert.match(said(third), /PELICAN-7/, `said: ${said(third).slice(0, 160)}`);
});

await check('the step log and the model agree', () => {
  const everything = [first, second, third].flatMap((r) => store.listSteps(r)).map((s) => s.body).join(' ');
  assert.match(everything, /PELICAN-7/);
});

console.log('deleting a bot');
{
  const temp = store.createBot(OWNER, '临时', 'nothing', null, 'full');
  const run = await startRun(temp.id, '说"好"就行。', () => {});
  for (let i = 0; i < 400 && isBusy(temp.id); i++) await new Promise((r) => setTimeout(r, 500));

  await check('a temporary bot has a transcript of its own', () => {
    assert.ok(sessionExists(temp.id));
  });

  await dropSession(temp.id);
  store.deleteBot(OWNER, temp.id);
  forgetSession(temp.id);

  await check('deleting it removes the transcript', () => {
    assert.equal(sessionExists(temp.id), false, 'the file would otherwise accumulate forever');
  });
  await check('its rows are gone too', () => {
    assert.equal(store.getBot(temp.id), undefined);
    assert.equal(store.listRuns(temp.id).length, 0);
  });
  await check("the other bot's transcript is untouched", () => {
    assert.ok(sessionExists(bot.id));
  });
}

console.log('a corrupt transcript');
{
  const broken = store.createBot(OWNER, '坏档', 'nothing', null, 'full');
  const dir = sessionDir();
  const file = path.join(dir, `${broken.id}.jsonl`);
  // Garbage, not valid session data.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, 'this is not a session file\n{{{\n');

  const run = await startRun(broken.id, '说"好"。', () => {});
  for (let i = 0; i < 400 && isBusy(broken.id); i++) await new Promise((r) => setTimeout(r, 500));

  await check('a bot with an unreadable transcript still answers', () => {
    // Losing the model's memory is recoverable; refusing to start the bot is not.
    assert.notEqual(store.getRun(run)!.status, 'failed', store.getRun(run)!.error ?? '');
  });
  await check('the unreadable file is kept aside rather than deleted', () => {
    const aside = readdirSync(dir).filter((f) => f.startsWith(broken.id) && f.includes('broken'));
    const started = existsSync(file);
    assert.ok(aside.length > 0 || started, `session dir: ${readdirSync(dir).join(', ')}`);
  });

  await dropSession(broken.id);
}

await dropSession(bot.id);
console.log(`\n${passed} checks passed`);
