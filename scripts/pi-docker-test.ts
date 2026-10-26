/**
 * PI on the docker target: tools must execute inside the container.
 *
 *   ADA_TOKEN=... pnpm tsx scripts/pi-docker-test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — skipping.');
  process.exit(0);
}
if (spawnSync('docker', ['ps'], { encoding: 'utf8' }).status !== 0) {
  console.log('docker daemon is not reachable — skipping.');
  process.exit(0);
}

const DB = './data/test/pi-docker.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'docker';
delete process.env.SANDBOX_ALLOW_LOCAL;

const { store } = await import('../src/agent/store.ts');
const { sessionFor, dropSession } = await import('../src/pi/runner.ts');
const { getSandbox } = await import('../src/sandbox/index.ts');

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

const OWNER = 'dockerpi';
const bot = store.createBot(OWNER, 'D', 'do what the user asks');
const sandbox = await getSandbox(OWNER, null);
await sandbox.exec('rm -f dpi.txt');

const run = store.createRun(bot.id);
const session = await sessionFor(bot);
const approve = setInterval(() => {
  for (const a of store.openApprovals(OWNER)) store.resolveApproval(a.id, true);
}, 200);
await session.prompt(
  'Run pwd, then use the write tool to create dpi.txt containing exactly: in-container. ' +
    'Report the directory pwd printed.',
  run.id, () => {},
);
clearInterval(approve);

const said = store.listSteps(run.id)
  .filter((s) => s.kind === 'assistant_text').map((s) => s.body).join(' ');

console.log('pi on the docker target');
await check('the run completed', () => {
  assert.equal(store.getRun(run.id)!.status, 'done');
});
await check('pwd reports the container workspace', () => {
  assert.match(said, /\/workspace/, `said: ${said.replace(/\n/g, ' ').slice(0, 200)}`);
});
await check('the file was written inside the container', async () => {
  const r = await sandbox.exec('cat dpi.txt 2>/dev/null || echo MISSING');
  assert.match(r.stdout, /in-container/, `got: ${r.stdout.slice(0, 120)}`);
});
await check('the host workspace directory was not used', () => {
  const r = spawnSync('sh', ['-c', `test -f ./data/test/workspaces/${OWNER}/dpi.txt && echo EXISTS || echo missing`], { encoding: 'utf8' });
  assert.match(r.stdout, /missing/, 'the write must not have landed on the host');
});

await dropSession(bot.id);
console.log(`\n${passed} checks passed`);
