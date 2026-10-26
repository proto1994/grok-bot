/**
 * Does the packaged app actually work?
 *
 * The build runs compiled output from a read-only bundle with state in
 * userData — a different layout from `pnpm app`. Everything that is only true
 * of the packaged form has to be checked here, on the real .app.
 *
 *   ADA_TOKEN=... node scripts/dmg-test.mjs
 */
import { chromium } from 'playwright-core';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const APP = path.resolve('release/Bots.app');
const BIN = path.join(APP, 'Contents/MacOS/Bots');
const CDP_PORT = 9333;
// The packaged app keeps state in userData, keyed by the bundle name.
const USER_DATA = path.join(os.homedir(), 'Library/Application Support/Bots');

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

console.log('the bundle');
await check('the bundled node has node:sqlite', () => {
  // The store runs on node:sqlite, which arrived in Node 22. An Electron that
  // bundles Node 20 produces a bundle that opens a window and then dies on the
  // first query — passing every check that stops at "a window appeared".
  const r = spawnSync(BIN, ['-e', 'require("node:sqlite")'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`node:sqlite missing from the bundled node: ${(r.stderr || '').slice(0, 200)}`);
});
await check('the app exists and is executable', () => {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing — run pnpm dmg first`);
  statSync(BIN);
});
await check('no typescript sources shipped except the proxy\'s', () => {
  const appRoot = path.join(APP, 'Contents/Resources/app');
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(p, out);
      } else if (e.name.endsWith('.ts')) out.push(path.relative(appRoot, p));
    }
    return out;
  };
  const ts = walk(appRoot);
  const unexpected = ts.filter((p) => !p.startsWith('dist/sandbox/'));
  if (unexpected.length) throw new Error(`unexpected .ts in the bundle: ${unexpected.join(', ')}`);
  if (!ts.length) throw new Error('the proxy sources are missing; a restricted egress target would fail');
});
await check('the dmg was produced', () => {
  const dmg = readdirSync('release').find((f) => f.endsWith('.dmg'));
  if (!dmg) throw new Error('no .dmg in release/');
  const mb = statSync(path.join('release', dmg)).size / 1e6;
  if (mb < 50) throw new Error(`the dmg is only ${mb.toFixed(0)}MB — probably missing electron`);
});

// Start from a clean userData so the first-run path is what gets tested.
rmSync(USER_DATA, { recursive: true, force: true });
mkdirSync(USER_DATA, { recursive: true });
writeFileSync(path.join(USER_DATA, '.env'), [
  `ADA_TOKEN=${process.env.ADA_TOKEN}`,
  `ADA_BASE_URL=${process.env.ADA_BASE_URL ?? ''}`,
  `PI_MODEL=${process.env.PI_MODEL ?? 'kr-claude-opus-5.5'}`,
  'SANDBOX_DRIVER=local',
  'SANDBOX_ALLOW_LOCAL=1',
  '',
].join('\n'));

console.log('\nrunning the packaged app');
const app = spawn(BIN, [`--remote-debugging-port=${CDP_PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ADA_TOKEN: '', AUTH_TOKEN: '' }, // must come from userData/.env
});
let log = '';
app.stdout.on('data', (d) => (log += d));
app.stderr.on('data', (d) => (log += d));
const stop = () => { try { app.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);

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
  await check('the packaged app opens a window', () => {
    if (!browser) throw new Error(`could not attach in 90s. log:\n${log.slice(-800)}`);
  });
  if (!browser) throw new Error('stop');

  const ctx = browser.contexts()[0];
  let page = ctx.pages()[0];
  for (let i = 0; i < 30 && !page; i++) {
    await new Promise((r) => setTimeout(r, 500));
    page = ctx.pages()[0];
  }
  await check('a renderer page is reachable', () => {
    // Previously a missing page silently skipped every check below it, which
    // reported a pass for a build that had not been exercised at all.
    if (!page) throw new Error(`no page in the renderer. app log:\n${log.slice(-800)}`);
  });
  if (!page) throw new Error('stop');
  await page.waitForLoadState('domcontentloaded');

  await check('the compiled orchestrator started', () => {
    if (!/orchestrator\s+http:\/\/127\.0\.0\.1:\d+/.test(log)) {
      throw new Error(`no orchestrator line:\n${log.slice(-600)}`);
    }
  });

  await check('state went to userData, not into the bundle', () => {
    if (!existsSync(path.join(USER_DATA, 'app.db'))) {
      throw new Error('app.db is not in userData — an installed app could not write it');
    }
    const inBundle = path.join(APP, 'Contents/Resources/app/data');
    if (existsSync(inBundle)) throw new Error('the app wrote into its own bundle');
  });

  await check('the token was read from userData/.env', async () => {
    const t = await page.evaluate(() => window.__TOKEN__);
    if (!t) throw new Error('no token on the page');
  });

  await check('the ui rendered from the compiled bundle', async () => {
    await page.waitForSelector('#roster', { timeout: 20_000 });
    await page.waitForSelector('.cwrap input', { timeout: 20_000 });
  });

  await check('a real task runs end to end in the packaged app', async () => {
    await page.click('#newbtn');
    await page.waitForSelector('#newdlg[open]');
    await page.fill('#bname', '打包验收');
    await page.fill('#bjob', 'do what the user asks');
    await page.selectOption('#bmode', 'full'); // no approval step in this check
    await page.click('#newform button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#newdlg').open, null, { timeout: 20_000 });

    await page.fill('#text', 'Create a file named packaged.txt containing exactly: shipped. Use the write tool.');
    await page.click('#sendbtn');
    await page.waitForSelector('.msg.bot', { timeout: 180_000 });

    const file = path.join(USER_DATA, 'workspaces/local/packaged.txt');
    const alt = path.join(USER_DATA, 'workspaces');
    if (!existsSync(file)) {
      const found = existsSync(alt) ? readdirSync(alt, { recursive: true }).join(', ') : '(no workspaces dir)';
      throw new Error(`packaged.txt not found. workspaces contains: ${found}`);
    }
  });

  await page.screenshot({ path: 'data/screenshots/dmg-01-packaged.png' });

  await check('no renderer errors', async () => {
    const errs = await page.evaluate(() => {
      const el = document.querySelector('#banner');
      return el && !el.hidden ? [document.querySelector('#bannertext').textContent] : [];
    });
    if (errs.length) throw new Error(errs.join(' | '));
  });
} catch (e) {
  if (String(e.message) !== 'stop') fails.push(`run aborted: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  stop();
}

const dmgName = readdirSync('release').find((f) => f.endsWith('.dmg'));
console.log(`\n${passed} passed, ${fails.length} failed`);
if (dmgName) console.log(`artifact: release/${dmgName}`);
if (fails.length) {
  console.log('\napp log tail:');
  console.log(log.split('\n').slice(-20).join('\n'));
  process.exit(1);
}
