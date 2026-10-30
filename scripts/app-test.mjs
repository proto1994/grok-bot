/**
 * The desktop shell: does it start the orchestrator, pick a free port, pick up
 * the token, and show the UI?
 *
 * Electron is driven through the CDP port rather than Playwright's electron
 * helper, which playwright-core does not ship.
 *
 *   ADA_TOKEN=... node scripts/app-test.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const CDP_PORT = 9222;
const SHOTS = 'data/screenshots';
mkdirSync(SHOTS, { recursive: true });

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

/*
 * Started without ADA_TOKEN in its environment, so the app has to find the
 * credentials the way it does when someone double-clicks it: by reading .env
 * itself. Passing the token in hid a bug where the app looked in the wrong
 * directory and refused to start at all.
 */
const { ADA_TOKEN: _omit, ...envWithoutToken } = process.env;
const electron = spawn(
  'node_modules/.bin/electron',
  [`--remote-debugging-port=${CDP_PORT}`, 'desktop/main.cjs'],
  { env: envWithoutToken, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
electron.stdout.on('data', (d) => (log += d));
electron.stderr.on('data', (d) => (log += d));
const stop = () => { try { electron.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);

// Wait for the renderer to be attachable.
let browser = null;
for (let i = 0; i < 90; i++) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

try {
  await check('the app exposes a renderer', () => {
    if (!browser) throw new Error(`could not attach within 90s. log:\n${log.slice(-600)}`);
  });
  if (!browser) throw new Error('stop');

  const ctx = browser.contexts()[0];
  let page = ctx.pages()[0];
  for (let i = 0; i < 30 && !page; i++) {
    await new Promise((r) => setTimeout(r, 500));
    page = ctx.pages()[0];
  }

  await check('a window is open', () => {
    if (!page) throw new Error('no page in the renderer');
  });

  await page.waitForLoadState('domcontentloaded');

  await check('the orchestrator was started on a free port', () => {
    const m = /orchestrator\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (!m) throw new Error(`no orchestrator line in the log:\n${log.slice(-400)}`);
    const port = Number(m[1]);
    if (port === 4000) throw new Error('used the default port instead of a free one');
    if (!(port > 1024)) throw new Error(`implausible port ${port}`);
  });

  await check('the window loads the orchestrator, not a file:// page', async () => {
    const url = page.url();
    if (!/^http:\/\/127\.0\.0\.1:\d+/.test(url)) throw new Error(`window url is ${url}`);
  });

  await check('it started without a model credential in its environment', () => {
    // The shell used to require ADA_TOKEN and quit with 「缺少模型凭证」 when it
    // was absent, which locked out anyone who had configured a provider in the
    // UI instead. Providers live in sqlite now, so missing seeds are not a
    // reason to refuse to start. Still asserted so a hard exit cannot come back.
    if (/缺少模型凭证/.test(log)) {
      throw new Error(`the app refused to start over a missing seed:\n${log.slice(-400)}`);
    }
    if (electron.exitCode !== null) {
      throw new Error(`the app exited with ${electron.exitCode}:\n${log.slice(-400)}`);
    }
  });

  await check('the desktop app and the web server share one database', async () => {
    // They pointed at different files in dev: the app wrote ./app.db while the
    // browser used ./data/app.db, so each showed bots the other did not have.
    const { existsSync } = await import('node:fs');
    if (existsSync('./app.db')) {
      throw new Error('the app created ./app.db; dev state belongs in ./data/app.db');
    }
    const reachable = await page.evaluate(async () => {
      const r = await fetch('/api/bots', { headers: { authorization: `Bearer ${window.__TOKEN__}` } });
      return r.ok;
    });
    if (!reachable) throw new Error('could not read the bot list from the app');
  });

  await check('the window has something to drag it by', async () => {
    // titleBarStyle:hiddenInset removes the title bar, so without a drag region
    // the window cannot be moved at all.
    const region = await page.evaluate(() => {
      const el = document.querySelector('.topbar');
      return el ? getComputedStyle(el).webkitAppRegion : 'missing';
    });
    if (region !== 'drag') throw new Error(`.topbar app-region is "${region}"`);
  });

  await check('the buttons inside the drag strip still work', async () => {
    const region = await page.evaluate(() => {
      const b = document.querySelector('.topbar button');
      return b ? getComputedStyle(b).webkitAppRegion : 'missing';
    });
    if (region !== 'no-drag') throw new Error(`a button in the drag strip is "${region}"`);
  });

  await check('the traffic lights have room', async () => {
    const pad = await page.evaluate(
      () => parseInt(getComputedStyle(document.querySelector('.topbar')).paddingLeft, 10),
    );
    if (pad < 70) throw new Error(`topbar padding-left is ${pad}px; the window buttons need room`);
  });

  await check('the token reached the page, so there is no login step', async () => {
    const t = await page.evaluate(() => window.__TOKEN__);
    if (!t) throw new Error('window.__TOKEN__ is empty — notifications and the api would fail');
  });

  await check('the ui rendered', async () => {
    await page.waitForSelector('#roster', { timeout: 15_000 });
    await page.waitForSelector('.cwrap input', { timeout: 15_000 });
  });

  await check('the settings button is present', async () => {
    // Hidden until a bot is selected, but it must exist in the shell.
    if (!(await page.$('#setBtn'))) throw new Error('#setBtn is missing');
    if (!(await page.$('#setdlg'))) throw new Error('#setdlg is missing');
  });

  await check('no console errors in the renderer', async () => {
    const errs = await page.evaluate(() => window.__errors ?? []);
    if (errs.length) throw new Error(errs.join(' | '));
  });

  await page.screenshot({ path: `${SHOTS}/app-01-window.png` });

  await check('the permission sheet lists three modes', async () => {
    // Create a bot so the settings button becomes reachable.
    await page.click('#newbtn');
    await page.waitForSelector('#newdlg[open]');
    await page.fill('#bname', '应用验收');
    await page.fill('#bjob', 'do what the user asks');
    await page.click('#newform button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#newdlg').open, null, { timeout: 20_000 });
    // selectBot runs asynchronously after the dialog closes and is what reveals
    // this button; clicking straight away races it.
    await page.waitForSelector('#setBtn:not([hidden])', { timeout: 20_000 });
    await page.click('#setBtn');
    await page.waitForSelector('#setdlg[open] .mode', { timeout: 10_000 });
    const modes = await page.$$eval('#modes .mode .t', (els) => els.map((e) => e.textContent));
    if (modes.length !== 3) throw new Error(`modes: ${modes.join(', ')}`);
  });
  await page.screenshot({ path: `${SHOTS}/app-02-settings.png` });

  await check('balanced is selected by default, not full', async () => {
    const checked = await page.$$eval('#modes .mode', (els) =>
      els.map((e) => ({ on: e.getAttribute('aria-checked'), t: e.querySelector('.t').textContent })));
    const on = checked.find((c) => c.on === 'true');
    if (!on) throw new Error('nothing is selected');
    if (on.t.includes('完全')) throw new Error('full access is selected by default');
  });

  await check('the tray reports a count without crashing', () => {
    // The tray lives in the main process; a throw there would have killed it.
    if (electron.exitCode !== null) throw new Error(`the app exited with ${electron.exitCode}`);
  });
} catch (e) {
  if (String(e.message) !== 'stop') fails.push(`run aborted: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  stop();
}

console.log(`\n${passed} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nmain-process log tail:');
  console.log(log.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
