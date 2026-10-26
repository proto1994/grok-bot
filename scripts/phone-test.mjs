/**
 * The phone path: reach the orchestrator over the LAN, pair with a link, and
 * drive the UI at phone size.
 *
 * Checked in a real browser at 390x844 with touch emulation, against the LAN
 * address rather than loopback — the thing being tested is that a device which
 * is not this machine can use it.
 *
 *   ADA_TOKEN=... node scripts/phone-test.mjs
 */
import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}

const PORT = 4310;
const TOKEN = `phone-test-${Date.now()}`;
const SHOTS = 'data/screenshots';
mkdirSync(SHOTS, { recursive: true });

const lan = Object.entries(networkInterfaces())
  .flatMap(([iface, addrs]) => (addrs ?? []).map((a) => ({ iface, ...a })))
  .find((a) => a.family === 'IPv4' && !a.internal && /^(en|eth|wl)/.test(a.iface));

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

for (const f of ['./data/test/phone.db', './data/test/phone.db-wal', './data/test/phone.db-shm']) {
  rmSync(f, { force: true });
}
rmSync('./data/test/workspaces/phone', { recursive: true, force: true });

const server = spawn('pnpm', ['tsx', 'src/server/index.ts'], {
  env: {
    ...process.env,
    BIND: 'lan',
    AUTH_TOKEN: TOKEN,
    PORT: String(PORT),
    DB_PATH: './data/test/phone.db',
    OWNER_ID: 'phone',
    SANDBOX_DRIVER: 'local',
    SANDBOX_ALLOW_LOCAL: '1',
    LOCAL_SANDBOX_ROOT: './data/test/workspaces',
    MCP_CONFIG: '/dev/null',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const stop = () => { try { server.kill('SIGTERM'); } catch { /* ignore */ } };
process.on('exit', stop);

console.log('network');
await check('this machine has a usable LAN address', () => {
  if (!lan) throw new Error('no non-internal IPv4 interface — cannot test the phone path');
});
if (!lan) {
  stop();
  process.exit(0);
}
const BASE = `http://${lan.address}:${PORT}`;

for (let i = 0; i < 90; i++) {
  try {
    const r = await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (r.ok) break;
  } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 500));
}

await check('the server is reachable on the LAN address, not just loopback', async () => {
  const r = await fetch(`${BASE}/api/bots`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`${BASE} returned ${r.status}. log:\n${log.slice(-500)}`);
});

await check('it printed a pairing link and a qr code', () => {
  if (!log.includes(`${BASE}/?token=`)) throw new Error('no pairing url in the output');
  if (!/[█▀▄]/.test(log)) throw new Error('no qr code in the output');
});

await check('it warned about what binding to the LAN means', () => {
  if (!/reachable by anything on the network/.test(log)) {
    throw new Error('the exposure warning is missing');
  }
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({
  ...devices['iPhone 14'],
  // devices[] carries a mobile user agent, touch, and the right viewport.
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  console.log('\npairing');
  await page.goto(`${BASE}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });

  await check('following the pairing link authenticates the page', async () => {
    const t = await page.evaluate(() => window.__TOKEN__ ?? '');
    if (!t) throw new Error('the page has no token');
  });

  await check('the token is removed from the address bar', async () => {
    const url = page.url();
    if (url.includes('token=')) throw new Error(`the token is still in the url: ${url}`);
  });

  await check('the api works from the phone context', async () => {
    const status = await page.evaluate(async () => {
      const r = await fetch('/api/bots', { headers: { authorization: `Bearer ${window.__TOKEN__}` } });
      return r.status;
    });
    if (status !== 200) throw new Error(`the page's own api call returned ${status}`);
  });

  console.log('\nphone layout');
  await check('no horizontal scrolling', async () => {
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    if (over) throw new Error('the page scrolls sideways');
  });

  await check('the bot list is reachable through a drawer', async () => {
    // Before this existed the sidebar was display:none on a phone, leaving no
    // way to switch bots or make one — most of the app.
    if (!(await page.isVisible('#menubtn'))) throw new Error('no menu button');
    const closed = await page.$eval('aside', (el) => el.getBoundingClientRect().x);
    if (closed >= 0) throw new Error('the drawer is not tucked away');
    await page.click('#menubtn');
    await page.waitForTimeout(400);
    const open = await page.$eval('aside', (el) => Math.round(el.getBoundingClientRect().x));
    if (open !== 0) throw new Error(`the drawer did not open (x=${open})`);
  });
  await page.screenshot({ path: `${SHOTS}/phone-01-drawer.png` });

  await check('a bot can be created from a phone', async () => {
    await page.click('#newbtn');
    await page.waitForSelector('#newdlg[open]');
    await page.fill('#bname', '手机验收');
    await page.fill('#bjob', 'do what the user asks');
    await page.click('#newform button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('#newdlg').open, null, { timeout: 20_000 });
    await page.waitForSelector('.rosteritem .nm', { timeout: 15_000 });
  });

  await check('selecting a bot closes the drawer', async () => {
    // The drawer slides out over 200ms; sampling immediately catches it mid-way.
    await page.waitForFunction(
      () => document.querySelector('aside').getBoundingClientRect().x < 0,
      null, { timeout: 5_000 },
    ).catch(() => {
      throw new Error('the drawer stayed open over the conversation');
    });
  });
  await page.screenshot({ path: `${SHOTS}/phone-02-chat.png` });

  console.log('\na real task from the phone');
  await check('sending a message works and parks for approval', async () => {
    await page.fill('#text', 'Create a file named phone.txt containing exactly: mobile. Use the write tool.');
    await page.click('#sendbtn');
    await page.waitForSelector('.msg.me', { timeout: 10_000 });
    await page.waitForSelector('.ask', { timeout: 150_000 });
  });

  await check('the approval buttons are large enough to tap', async () => {
    const h = await page.$eval('.ask .yes', (el) => el.getBoundingClientRect().height);
    if (h < 32) throw new Error(`the approve button is only ${Math.round(h)}px tall`);
  });
  await page.screenshot({ path: `${SHOTS}/phone-03-approval.png` });

  await check('approving from the phone runs the tool', async () => {
    await page.click('.ask .yes');
    await page.waitForSelector('.ask', { state: 'detached', timeout: 15_000 });
    await page.waitForSelector('.msg.bot', { timeout: 150_000 });
    const { existsSync } = await import('node:fs');
    if (!existsSync('./data/test/workspaces/phone/phone.txt')) {
      throw new Error('the file was not written');
    }
  });
  await page.screenshot({ path: `${SHOTS}/phone-04-done.png` });

  await check('no renderer errors on the phone', () => {
    const real = errors.filter((e) => !/favicon|404/i.test(e));
    if (real.length) throw new Error(real.join(' | ').slice(0, 250));
  });
} catch (e) {
  fails.push(`run aborted: ${e.message}`);
} finally {
  await browser.close().catch(() => {});
  stop();
}

console.log(`\n${passed} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nserver log tail:');
  console.log(log.split('\n').slice(-15).join('\n'));
  process.exit(1);
}
