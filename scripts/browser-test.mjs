/**
 * Drives the real UI in a real browser.
 *
 * This is the only test that can see what a person sees: that the token
 * injection works without a login step, that approvals render as a card you can
 * click, that tool activity stays folded, and that the layout holds at phone
 * width. Screenshots land in data/screenshots for inspection.
 *
 *   ADA_TOKEN=... node scripts/browser-test.mjs
 *   ADA_TOKEN=... node scripts/browser-test.mjs --headed   # watch it run
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — the browser test needs a real model. Skipping.');
  process.exit(0);
}

const PORT = Number(process.env.PORT ?? 4270);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = `browser-test-${Date.now()}`;
const SHOTS = 'data/screenshots';
const headed = process.argv.includes('--headed');

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
for (const f of ['./data/test/browser.db', './data/test/browser.db-wal', './data/test/browser.db-shm']) {
  rmSync(f, { force: true });
}
rmSync('./data/test/workspaces/browser', { recursive: true, force: true });

let passed = 0;
const fails = [];
const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fails.push(name);
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

// ---- server ----
const server = spawn('pnpm', ['tsx', 'src/server/index.ts'], {
  env: {
    ...process.env,
    AUTH_TOKEN: TOKEN,
    PORT: String(PORT),
    DB_PATH: './data/test/browser.db',
    OWNER_ID: 'browser',
    SANDBOX_DRIVER: 'local',
    SANDBOX_ALLOW_LOCAL: '1',
    LOCAL_SANDBOX_ROOT: './data/test/workspaces',
    MCP_CONFIG: '/dev/null',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const stop = () => { try { server.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);

for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
// Declared out here so the cleanup block can stop it.
let autoApprove = null;
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

// The banner is the user-visible failure channel; record every time it shows so
// a transient one cannot slip past a single sample.
const bannerSightings = [];
const watchBanner = setInterval(async () => {
  try {
    const b = await page.evaluate(() => {
      // Measure what is on screen, not el.hidden: a css `display` rule can
      // leave an element visible while the property reports hidden.
      const el = document.querySelector('#banner');
      if (!el) return null;
      const shown = el.getBoundingClientRect().height > 0
        && getComputedStyle(el).display !== 'none';
      return shown ? document.querySelector('#bannertext').textContent : null;
    });
    if (b && !bannerSightings.includes(b)) bannerSightings.push(b);
  } catch { /* page navigating or closed */ }
}, 300);

const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

try {
  console.log('loading the page');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shot('01-empty');

  const realErrors = () =>
    consoleErrors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|404/i.test(e));

  await check('the page loads with no console errors', () => {
    if (realErrors().length) throw new Error(realErrors().join(' | ').slice(0, 300));
  });

  await check('the token is injected, so there is no login step', async () => {
    const t = await page.evaluate(() => window.__TOKEN__);
    if (!t) throw new Error('window.__TOKEN__ is missing');
  });

  await check('the hidden attribute actually hides, whatever the css says', async () => {
    // Regression: `.banner { display:flex }` beat the attribute, so the error
    // banner sat on screen from page load while el.hidden read true.
    const r = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'banner';
      probe.hidden = true;
      document.body.append(probe);
      const shown = probe.getBoundingClientRect().height > 0;
      probe.remove();
      return shown;
    });
    if (r) throw new Error('an element with [hidden] is still rendered');
  });

  await check('the empty state explains what to do', async () => {
    const text = await page.textContent('.empty');
    if (!text?.includes('新建')) throw new Error(`empty state said: ${text}`);
  });

  console.log('creating a bot');
  await page.click('#newbtn');
  await page.waitForSelector('#newdlg[open]');
  await shot('02-new-bot-dialog');

  await check('the new-bot dialog opens with a target list', async () => {
    const options = await page.$$eval('#btarget option', (els) => els.length);
    if (options < 1) throw new Error('no sandbox targets listed');
  });

  await check('creating a bot needs only a name', async () => {
    // The sheet asks for a name; the job, sandbox and permissions are folded
    // away because naming it is the whole requirement.
    const disabled = await page.evaluate(() => document.querySelector('#bsubmit').disabled);
    if (!disabled) throw new Error('create should be disabled with an empty name');
    const collapsed = await page.evaluate(() => !document.querySelector('.more').open);
    if (!collapsed) throw new Error('the extra settings should start folded away');
  });

  await check('the shape and colour pickers are populated', async () => {
    const counts = await page.evaluate(() => ({
      shapes: document.querySelectorAll('#bshapes button').length,
      colors: document.querySelectorAll('#bcolors button').length,
      preview: !!document.querySelector('#bpreview .botface'),
    }));
    if (counts.shapes < 10) throw new Error(`only ${counts.shapes} shapes`);
    if (counts.colors < 8) throw new Error(`only ${counts.colors} colours`);
    if (!counts.preview) throw new Error('no preview face');
  });

  await check('every shape keeps its eyes inside the body', async () => {
    // A first pass included a thin star whose eyes landed outside the outline.
    const bad = await page.evaluate(() => {
      const out = [];
      for (const btn of document.querySelectorAll('#bshapes button')) {
        const svg = btn.querySelector('.botface');
        const body = svg.querySelector('path');
        const box = body.getBBox();
        for (const eye of svg.querySelectorAll('.boteyes rect')) {
          const e = eye.getBBox();
          const inside = e.x >= box.x && e.y >= box.y
            && e.x + e.width <= box.x + box.width
            && e.y + e.height <= box.y + box.height;
          if (!inside) out.push(btn.dataset.shape);
        }
      }
      return [...new Set(out)];
    });
    if (bad.length) throw new Error(`eyes outside the body: ${bad.join(', ')}`);
  });

  await check('picking a colour repaints the preview', async () => {
    const before = await page.evaluate(
      () => document.querySelector('#bpreview path').getAttribute('fill'));
    await page.evaluate(() => document.querySelectorAll('#bcolors button')[2].click());
    const after = await page.evaluate(
      () => document.querySelector('#bpreview path').getAttribute('fill'));
    if (before === after) throw new Error(`fill did not change from ${before}`);
  });

  await page.fill('#bname', '浏览器验收');
  await page.click('#newform button[type="submit"]');
  // A closed <dialog> is hidden, so wait on the attribute rather than visibility.
  await page.waitForFunction(() => !document.querySelector('#newdlg').open, null, { timeout: 30_000 });

  console.log('the opening question');
  await check('a new bot opens with a question instead of an empty box', async () => {
    // Naming it is all the create sheet asks for, so this is where "what is it
    // for" gets settled — in one tap rather than an opening brief.
    await page.waitForSelector('.choices .choice', { timeout: 180_000 });
    const n = await page.$$eval('.choices .choice', (els) => els.length);
    if (n < 2) throw new Error(`only ${n} options offered`);
  });

  await check('the options are lettered, so they can also be typed', async () => {
    const keys = await page.$$eval('.choices .key', (els) => els.map((e) => e.textContent));
    if (keys[0] !== 'A') throw new Error(`first key is "${keys[0]}"`);
  });

  await check('the status row shows the bot working, not the stream', async () => {
    // It used to sit in the conversation, where it shifted the transcript and
    // read like a message from the bot.
    const inStream = await page.$('.stream .thinking');
    if (inStream) throw new Error('the indicator is still inside the conversation');
    if (!(await page.$('#statusrow'))) throw new Error('no status row');
  });

  await check('picking an option sends it and locks the card', async () => {
    const chosen = await page.$eval('.choices .choice span:last-child', (e) => e.textContent);
    await page.click('.choices .choice');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.choices .choice')].every((b) => b.disabled),
      null, { timeout: 10_000 },
    );
    await page.waitForFunction(
      (text) => [...document.querySelectorAll('.msg.me')].some((m) => m.textContent === text),
      chosen, { timeout: 15_000 },
    );
  });

  await check('the composer stays usable while the bot works', async () => {
    // Refusing input mid-turn threw away corrections thought of a second late.
    const disabledInput = await page.isDisabled('#text');
    if (disabledInput) throw new Error('the input is disabled while busy');
    await page.fill('#text', 'x');
    if (await page.isDisabled('#sendbtn')) throw new Error('send is disabled with text present');
    await page.fill('#text', '');
  });

  await page.waitForFunction(
    () => document.querySelector('#statusrow').hidden, null, { timeout: 180_000 },
  ).catch(() => {});

  await check('the bot appears in the roster with its face', async () => {
    await page.waitForSelector('.rosteritem .nm', { timeout: 10_000 });
    const name = await page.textContent('.rosteritem .nm');
    if (name !== '浏览器验收') throw new Error(`roster shows: ${name}`);
    const face = await page.$('.rosteritem .botface path');
    if (!face) throw new Error('the roster row has no avatar');
  });

  await check('the name pill shows the selected bot', async () => {
    const t = await page.textContent('#topname');
    if (t !== '浏览器验收') throw new Error(`pill shows: ${t}`);
  });
  await shot('03-bot-created');

  console.log('sending a message that needs approval');
  /*
   * Settle the opening exchange first, answering anything it parks.
   *
   * Picking an option can start real work — the bot went looking around with a
   * shell command, which the gate held. Typing the next message into that queue
   * is allowed, but nothing moves until someone answers the prompt already on
   * screen, so the test does what a person would.
   */
  for (let i = 0; i < 60; i++) {
    const idle = await page.evaluate(() => document.querySelector('#statusrow').hidden);
    const card = await page.$('.ask .yes');
    if (card) {
      await card.click();
      await page.waitForSelector('.ask', { state: 'detached', timeout: 30_000 }).catch(() => {});
      continue;
    }
    if (idle) break;
    await page.waitForTimeout(2000);
  }
  await page.fill('#text', 'Create a file named browser.txt containing exactly: clicked. Use the write tool.');
  await check('the send button enables once there is text', async () => {
    if (await page.isDisabled('#sendbtn')) throw new Error('send is still disabled');
  });
  await page.click('#sendbtn');

  await check('my message appears immediately', async () => {
    await page.waitForSelector('.msg.me', { timeout: 5_000 });
  });
  await check('a busy indicator appears beside the composer', async () => {
    // Not `.thinking` in the stream any more: the indicator sits between the
    // conversation and the input, with the bot's face and what it is doing.
    await page.waitForFunction(
      () => !document.querySelector('#statusrow').hidden, null, { timeout: 20_000 },
    );
  });
  await shot('04-thinking');

  console.log('the approval card');
  await check('an approval card renders', async () => {
    await page.waitForSelector('.ask', { timeout: 300_000 });
  });
  await check('the card asks in plain language and shows the command', async () => {
    const h = await page.textContent('.ask .h');
    if (!h?.includes('要我')) throw new Error(`heading was: ${h}`);
    const pre = (await page.textContent('.ask pre'))?.trim();
    if (!pre) throw new Error('the card shows no command or path');
  });
  await check('the busy indicator clears while waiting on me', async () => {
    await page.waitForFunction(
      () => document.querySelector('#statusrow').hidden, null, { timeout: 20_000 },
    );
  });
  await shot('05-approval-card');

  await check('clicking 批准 dismisses the card', async () => {
    await page.click('.ask .yes');
    await page.waitForSelector('.ask', { state: 'detached', timeout: 10_000 });
  });

  /*
   * From here on, answer prompts as they appear.
   *
   * The checks above verify the card and the click once. After that several
   * queued turns can each park, and an unanswered prompt stalls everything
   * behind it — so this stands in for someone watching the conversation.
   */
  autoApprove = setInterval(() => {
    page.$('.ask .yes').then((btn) => btn?.click()).catch(() => {});
  }, 1500);

  console.log('tool activity and the reply');
  await check('tool work renders as one folded line', async () => {
    await page.waitForSelector('.activity', { timeout: 300_000 });
    const open = await page.$eval('details.activity', (el) => el.open);
    if (open) throw new Error('the activity line should start collapsed');
  });
  await check('the activity line reads as prose, not json', async () => {
    const t = await page.textContent('details.activity summary');
    const verbs = /运行了命令|读取了文件|写入了文件|修改了文件|看了目录|问了你一个问题|排了一个例行任务|看了已有的例行任务|看了有哪些 Bot|找了另一个 Bot/;
    if (!verbs.test(t ?? '')) {
      throw new Error(`summary said: ${t} — the verb map is out of step with pi's tool names`);
    }
  });
  await check('no raw json is visible while the detail is folded', async () => {
    // textContent would include text inside a collapsed <details>, which nobody
    // can see; innerText reflects what is rendered.
    const visible = await page.$eval('.stream', (el) => el.innerText);
    if (/\{"(command|path|content)"/.test(visible)) {
      throw new Error(`raw tool arguments are on screen: ${visible.slice(0, 160)}`);
    }
  });
  await check('expanding the line reveals the detail', async () => {
    await page.click('details.activity summary');
    const open = await page.$eval('details.activity', (el) => el.open);
    if (!open) throw new Error('clicking the summary did not expand it');
  });

  await check('the bot replies', async () => {
    await page.waitForSelector('.msg.bot', { timeout: 300_000 });
  });

  await check('no error banner appeared at any point during normal use', () => {
    if (bannerSightings.length) {
      throw new Error(`the banner showed: ${bannerSightings.join(' | ').slice(0, 300)}`);
    }
  });

  await shot('06-after-approval');

  await check('a reply bubble lays out as text, not as a grid', async () => {
    // The bug this exists for: the roster's `.bot` rule also matched `.msg.bot`,
    // so a reply rendered one character per line inside a wide bubble. Measuring
    // the bubble's width missed it; the height for a short paragraph is the tell.
    const b = await page.$eval('.msg.bot', (el) => ({
      display: getComputedStyle(el).display,
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
      chars: el.textContent.length,
    }));
    if (b.display === 'grid') throw new Error('the bubble is a grid; a layout rule is leaking into it');
    // A paragraph wrapping at a sane width is at most a few lines tall.
    const maxReasonable = Math.ceil(b.chars / 40) * 30 + 60;
    if (b.height > maxReasonable) {
      throw new Error(`${b.chars} chars in a ${Math.round(b.width)}x${Math.round(b.height)} bubble — the text column is too narrow`);
    }
  });

  await check('a long tool output does not squeeze the message bubbles', async () => {
    // The bug this exists for: an expanded <pre> stretched the flex container
    // and every bubble collapsed to a one-character column.
    const widths = await page.$$eval('.msg', (els) => els.map((e) => e.getBoundingClientRect().width));
    const narrow = widths.filter((w) => w < 120);
    if (narrow.length) throw new Error(`bubble widths: ${widths.map(Math.round).join(', ')}`);
  });

  await check('the reply renders markdown rather than showing its markup', async () => {
    // Models write **bold**, `code` and lists whether or not anything renders
    // them, so leaving the text raw is a decision to show markup to the person.
    const body = await page.$eval('.msg.bot', (el) => el.textContent);
    if (/\*\*/.test(body)) throw new Error(`asterisks are visible in the reply: ${body.slice(0, 120)}`);
  });

  await check('model output cannot inject markup', async () => {
    // The renderer builds text nodes; this is the check that it stays that way.
    const counts = await page.evaluate(() => {
      const stream = document.querySelector('.stream');
      return {
        scripts: stream.querySelectorAll('script').length,
        images: stream.querySelectorAll('img').length,
        iframes: stream.querySelectorAll('iframe').length,
      };
    });
    const bad = Object.entries(counts).filter(([, n]) => n > 0);
    if (bad.length) throw new Error(`injected elements: ${JSON.stringify(counts)}`);
  });

  console.log('the side effect really happened');
  await check('the file exists in the sandbox workspace', async () => {
    /*
     * Poll for the file rather than for a quiet status row.
     *
     * The write is the third queued turn — greeting, the option that was
     * picked, then this — and the row goes briefly idle between turns, so
     * waiting on it looked like "finished" while the write had not started.
     */
    const { existsSync, readFileSync } = await import('node:fs');
    const path = './data/test/workspaces/browser/browser.txt';
    for (let i = 0; i < 150; i++) {
      if (existsSync(path)) break;
      await page.waitForTimeout(2000);
    }
    if (!existsSync(path)) throw new Error('browser.txt was never written');
    const content = readFileSync(path, 'utf8');
    if (!content.includes('clicked')) throw new Error(`file content: ${content}`);
  });

  await check('the busy indicator clears once the work is done', async () => {
    /*
     * Checked here rather than mid-conversation.
     *
     * With a greeting, a picked option and this write all queued, the row is
     * continuously busy by design — asserting it had gone idle earlier was
     * asserting that the queue had stalled.
     */
    await page.waitForFunction(
      () => document.querySelector('#statusrow').hidden, null, { timeout: 180_000 },
    );
  });

  await check('the face animates while the bot is working', async () => {
    // The status indicator is the avatar itself, so a glance at the sidebar
    // says which bots are busy with no text to read.
    await page.evaluate(() => {
      const el = document.querySelector('.rosteritem .botface');
      el.dataset.state = 'working';
    });
    const running = await page.evaluate(() => {
      const el = document.querySelector('.rosteritem .botface .botbody');
      return getComputedStyle(el).animationName;
    });
    if (running === 'none') throw new Error('no animation on a working face');
  });

  await check('the animation is off when idle', async () => {
    await page.evaluate(() => {
      document.querySelector('.rosteritem .botface').dataset.state = 'idle';
    });
    const name = await page.evaluate(
      () => getComputedStyle(document.querySelector('.rosteritem .botface .botbody')).animationName);
    if (name !== 'none') throw new Error(`idle face is animating with ${name}`);
  });

  console.log('groups');
  await check('a group needs a second bot before it can be made', async () => {
    await page.click('#newgroupbtn');
    await page.waitForSelector('#groupdlg[open]');
    const chips = await page.$$('#gmembers .chipbtn');
    // One bot exists at this point, so the picker cannot reach the minimum.
    if (chips.length > 1) throw new Error('expected a single bot in the picker');
    await page.click('#groupdlg [data-close]');
  });

  await check('a group can be created from two bots', async () => {
    // A second bot, so a group is possible.
    await page.click('#newbtn');
    await page.waitForSelector('#newdlg[open]');
    await page.fill('#bname', '同伴');
    await page.click('#newform button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#newdlg').open, null, { timeout: 20_000 });

    await page.click('#newgroupbtn');
    await page.waitForSelector('#groupdlg[open] .chipbtn');
    await page.fill('#gname', '小组');
    for (const chip of await page.$$('#gmembers .chipbtn')) await chip.click();
    await page.click('#groupform button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#groupdlg').open, null, { timeout: 20_000 });
  });

  await check('the group appears in the roster with its members', async () => {
    const names = await page.$$eval('.rosteritem .nm', (els) => els.map((e) => e.textContent));
    if (!names.includes('小组')) throw new Error(`roster: ${names.join(', ')}`);
    const preview = await page.$$eval('.rosteritem .pv', (els) => els.map((e) => e.textContent));
    if (!preview.some((p) => p.includes('同伴'))) throw new Error(`previews: ${preview.join(' | ')}`);
  });

  await check('a group avatar stacks its members', async () => {
    const chips = await page.$$('.rosteritem .stack .chip');
    if (chips.length < 2) throw new Error('the group avatar should show two members');
  });

  await check('a group hides the per-bot sandbox and permission buttons', async () => {
    // Neither belongs to a group: they are properties of each member.
    if (await page.isVisible('#setBtn')) throw new Error('#setBtn should be hidden for a group');
    if (await page.isVisible('#whereBtn')) throw new Error('#whereBtn should be hidden for a group');
  });

  await check('the composer hints how to address members', async () => {
    const hint = await page.textContent('#hint');
    if (!hint.includes('@')) throw new Error(`hint said: ${hint}`);
    const ph = await page.getAttribute('#text', 'placeholder');
    if (!ph.includes('@')) throw new Error(`placeholder said: ${ph}`);
  });
  await shot('11-group');

  await check('switching back to a bot restores its buttons', async () => {
    const items = await page.$$('.rosteritem');
    // The groups come first, so the last row is a bot.
    await items[items.length - 1].click();
    await page.waitForSelector('#setBtn:not([hidden])', { timeout: 10_000 });
  });

  console.log('the other surfaces');
  await check('the apps sheet lists tools tagged by risk', async () => {
    await page.click('#appsbtn');
    await page.waitForSelector('#appsdlg[open] .tool', { timeout: 10_000 });
    const tags = await page.$$eval('#toollist .tag', (els) => els.map((e) => e.textContent));
    if (!tags.includes('需审批')) throw new Error(`tags were: ${tags.join(',')}`);
    if (!tags.includes('只读')) throw new Error('no read-only tool was listed');
  });
  await shot('07-apps-sheet');
  await page.click('#appsdlg [data-close]');

  await check('the sandbox sheet shows where the bot runs', async () => {
    await page.click('#whereBtn');
    await page.waitForSelector('#wheredlg[open]', { timeout: 10_000 });
    const info = await page.textContent('#whereinfo');
    if (!info?.trim()) throw new Error('no target description shown');
  });
  await shot('08-sandbox-sheet');
  await page.click('#wheredlg [data-close]');

  console.log('routines');
  await check('the settings sheet lists routines', async () => {
    await page.click('#setBtn');
    await page.waitForSelector('#setdlg[open]', { timeout: 10_000 });
    await page.waitForFunction(
      () => !document.querySelector('#routinelist').textContent.includes('读取中'),
      null, { timeout: 15_000 },
    );
    const text = await page.textContent('#routinelist');
    // With none scheduled it has to say so and say how to make one, rather than
    // showing an empty box.
    if (!text.trim()) throw new Error('the routine list is blank');
  });
  await shot('12-routines');
  await page.click('#setdlg [data-close]');

  console.log('deleting a bot');
  await check('a bot can be deleted from its settings', async () => {
    // Pick a bot explicitly: a group may be selected after the checks above,
    // and the settings sheet is bot-only.
    const rows = await page.$$('.rosteritem');
    await rows[rows.length - 1].click();
    await page.waitForSelector('#setBtn:not([hidden])', { timeout: 10_000 });
    await page.click('#setBtn');
    await page.waitForSelector('#setdlg[open] #delbot', { timeout: 10_000 });
    page.once('dialog', (d) => d.accept()); // the confirm
    const before = await page.$$eval('.rosteritem .nm', (e) => e.length);
    await page.click('#delbot');
    await page.waitForFunction(
      (n) => document.querySelectorAll('.rosteritem .nm').length < n,
      before, { timeout: 20_000 },
    );
  });

  await check('deleting leaves the app in a usable state', async () => {
    const banner = await page.evaluate(() => {
      const el = document.querySelector('#banner');
      return el.getBoundingClientRect().height > 0 ? document.querySelector('#bannertext').textContent : null;
    });
    if (banner) throw new Error(`a banner appeared after deleting: ${banner}`);
    if (!(await page.$('#roster'))) throw new Error('the roster is gone');
  });

  console.log('layout');
  await check('dark mode has a dark background', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const bg = await page.$eval('body', (el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    if ((r + g + b) / 3 > 90) throw new Error(`body background is ${bg}`);
  });
  await shot('09-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await check('phone width does not scroll sideways', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (over) throw new Error('the page scrolls horizontally at 390px');
  });
  await shot('10-phone');
  await page.setViewportSize({ width: 1280, height: 860 });

  console.log('auth from the browser');
  // This probe deliberately provokes a 401, which the browser logs as a console
  // error. Record the count first so the final check does not trip over it.
  const errorsBeforeProbe = consoleErrors.length;
  await check('a page without the token is refused by the api', async () => {
    const status = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/bots`, { headers: { 'content-type': 'application/json' } });
      return r.status;
    }, BASE);
    if (status !== 401) throw new Error(`expected 401 without a token, got ${status}`);
  });

  await check('a cross-origin page cannot use a leaked token', async () => {
    const other = await browser.newPage();
    // A data: URL is an opaque origin — foreign to our server by definition.
    await other.goto('data:text/html,<p>foreign origin</p>');
    const result = await other.evaluate(async ([base, token]) => {
      try {
        const r = await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${token}` } });
        return `status ${r.status}`;
      } catch (e) {
        return `blocked: ${e.message}`;
      }
    }, [BASE, TOKEN]).catch((e) => `navigation failed: ${e.message}`);
    await other.close();
    // Either the browser's CORS layer blocks reading it, or our 403 does.
    if (/status 200/.test(String(result))) {
      throw new Error(`a foreign origin read the api: ${result}`);
    }
  });

  await check('no console errors accumulated during the whole run', () => {
    // Errors from the auth probes above are expected; everything before is not.
    const before = consoleErrors.slice(0, errorsBeforeProbe)
      // A 409 is part of the delete flow: it asks, learns the bot is busy,
      // stops it, and asks again.
      .filter((e) => !/favicon|ERR_CONNECTION_REFUSED|404|409/i.test(e));
    if (before.length) throw new Error(before.join(' | ').slice(0, 300));
  });

} catch (e) {
  fails.push(`run aborted: ${e.message}`);
} finally {
  if (autoApprove) clearInterval(autoApprove);
  clearInterval(watchBanner);
  await browser.close().catch(() => {});
  stop();
}

console.log(`\n${passed} passed, ${fails.length} failed`);
console.log(`screenshots in ${SHOTS}/`);
if (fails.length) {
  console.log('\nserver log tail:');
  console.log(serverLog.split('\n').slice(-15).join('\n'));
  process.exit(1);
}
