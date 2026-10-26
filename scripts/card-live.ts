/**
 * A question card is the whole question, and a reply is only what it meant.
 *
 * Two things seen in real use, in one screenshot:
 *
 *   1. The bot asked with ask_choice — buttons on screen — and then wrote the
 *      same question out underneath, re-listing both options it had just
 *      offered as taps. No tool can end a turn, so it carried on talking.
 *   2. Replies opened with a line of English reasoning: "I should keep my
 *      response short and wait for the user to reply." thinkingLevel is 'off',
 *      so this was not a leaked thinking block — the model was writing its
 *      reasoning as prose. 12 of 53 replies in the user's database did it.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/card-live.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const DB = './data/test/card-live.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/sessions', { recursive: true, force: true });
rmSync('./data/test/workspaces/card', { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

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

const OWNER = 'card';
const settle = async (botId: string) => {
  for (let i = 0; i < 400; i++) {
    if (!isBusy(botId)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('run did not settle');
};
const steps = (runId: string) => store.listSteps(runId);
const texts = (runId: string) =>
  steps(runId).filter((s) => s.kind === 'assistant_text').map((s) => s.body);

/* ---------- nothing follows a card ---------- */

console.log('a question card is not followed by the same question in text');
{
  const bot = store.createBot(
    OWNER, '选择', '按用户说的做事。需要用户决定的时候用 ask_choice 问。', null, 'full',
  );

  // Deliberately ambiguous, the shape that produced the screenshot: more than
  // one thing it could mean, so it has to ask which.
  const runId = await startRun(
    bot.id,
    '在工作区建一个文件。叫 a.txt 还是 b.txt 你问我，内容写 hello。',
    () => {},
  );
  await settle(bot.id);

  const idx = steps(runId).findIndex((s) => s.kind === 'tool_call' && s.tool === 'ask_choice');

  await check('it asked with a card', () => {
    assert.ok(idx >= 0, `tools: ${
      steps(runId).filter((s) => s.kind === 'tool_call').map((s) => s.tool).join(',') || 'none'
    }`);
  });

  await check('no reply text was recorded after the card', () => {
    const after = steps(runId).slice(idx).filter((s) => s.kind === 'assistant_text');
    assert.equal(after.length, 0,
      `${after.length} message(s) after the card: ${after.map((s) => s.body.slice(0, 80)).join(' // ')}`);
  });

  await check('what it tried to say afterwards is kept for diagnosis', () => {
    // Not an assertion that it *did* say something — only that if it did, the
    // text was recorded rather than dropped on the floor.
    const withheld = steps(runId).filter((s) => s.body.startsWith('withheld after a question card:'));
    for (const w of withheld) assert.ok(w.kind === 'note', `withheld as ${w.kind}, not a note`);
  });

  await check('the question itself reached the interface', () => {
    const note = steps(runId).find((s) => s.body.startsWith('ask_choice '));
    assert.ok(note, 'no ask_choice note to replay from');
    const q = JSON.parse(note!.body.slice('ask_choice '.length));
    assert.ok(q.options.length >= 2, `${q.options.length} options`);
  });

  await check('answering it carries on and does the work', async () => {
    const note = steps(runId).find((s) => s.body.startsWith('ask_choice '))!;
    const q = JSON.parse(note.body.slice('ask_choice '.length));
    const second = await startRun(bot.id, q.options[0], () => {});
    await settle(bot.id);
    assert.equal(store.getRun(second)!.status, 'done', store.getRun(second)!.error ?? '');

    const { getSandbox } = await import('../src/sandbox/index.ts');
    const sb = await getSandbox(OWNER, null);
    const r = await sb.exec('cat a.txt b.txt 2>/dev/null || echo MISSING');
    assert.match(r.stdout, /hello/i, r.stdout.slice(0, 80));
  });

  await check('a reply after the answer is shown normally', () => {
    // The suppression is per turn. If it leaked into the next one, the bot
    // would go silent for good.
    const second = store.listRuns(bot.id)[0]!;
    assert.ok(texts(second.id).length > 0, 'the bot said nothing after the pick');
  });

  await dropSession(bot.id);
}

/* ---------- replies carry no reasoning ---------- */

console.log('a reply does not narrate its own reasoning');
{
  const bot = store.createBot(OWNER, '干活', '按用户说的做事。', null, 'full');

  /*
   * Three turns, not one.
   *
   * Narration was intermittent — roughly a quarter of replies before the fix.
   * A single turn passing proves very little, and the fix (reasoning: true
   * plus thinkingLevel above 'off') is a change in where reasoning goes, so a
   * regression would show up as it drifting back into the text now and then.
   */
  const runIds: string[] = [];
  for (const msg of [
    '看一下工作区里有什么文件，然后告诉我 a.txt 里写的是什么。',
    '再确认一下 b.txt 存不存在。',
    'Add a line saying done to a.txt.',
  ]) {
    runIds.push(await startRun(bot.id, msg, () => {}));
    await settle(bot.id);
  }
  const runId = runIds[0]!;

  const allTexts = () => runIds.flatMap((r) => texts(r));

  await check('it answered each time', () => {
    for (const r of runIds) {
      assert.ok(texts(r).join('').trim().length > 0, `run ${runIds.indexOf(r) + 1} said nothing`);
    }
  });

  await check('no reply opens with self-narration, in either language', () => {
    /*
     * Checked on the first line only: an English identifier or a path further
     * down is normal, and so is "I" in an ordinary English sentence addressed
     * to the user.
     *
     * Both languages, because narration is not an English problem. A probe
     * against this gateway produced "用户问加法要注意什么，一句话回答即可" —
     * same fault, and an English-only pattern walks straight past it. The tell
     * in Chinese is third person about 用户 or announcing the reply's own
     * shape; in English it is planning out loud.
     */
    const EN = /^(I should|I'll |I need to|I have |Let me |Okay|Good,|Now I|The user |First,|Looking |This (is|looks) )/;
    const ZH = /^(用户(问|想|说|要|让|提|希望|切换)|这(是|个|看起来)|应该用|我(应该|需要|先|得先)|看起来是)/;
    for (const t of allTexts()) {
      const first = (t.trim().split('\n')[0] ?? '').trim();
      assert.equal(EN.test(first), false, `narrates in English: "${first.slice(0, 120)}"`);
      assert.equal(ZH.test(first), false, `narrates in Chinese: "${first.slice(0, 120)}"`);
    }
  });

  await check('it replied in the language each message was written in', () => {
    const zh = texts(runIds[0]!).join(' ');
    assert.match(zh, /[一-龥]/, `asked in Chinese, got: ${zh.slice(0, 160)}`);
    // The third was English, and matching the user is right — what must not
    // come back is an English *explanation of its own plan* above the answer,
    // which the narration check above covers for both languages.
    const en = texts(runIds[2]!).join(' ');
    assert.ok(en.trim().length > 0, 'nothing said in reply to the English message');
  });

  await dropSession(bot.id);
}

console.log(`\n${passed} checks passed`);
