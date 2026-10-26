/**
 * Behaviour evals against a real model.
 *
 *   ADA_TOKEN=... pnpm eval
 *   ADA_TOKEN=... pnpm eval -g approval
 */
import { rmSync } from 'node:fs';

const DB = './data/test/eval.db';
const OWNER = 'evals';

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync(`./data/test/workspaces/${OWNER}`, { recursive: true, force: true });

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = process.env.SANDBOX_DRIVER ?? 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';

const args = process.argv.slice(2);
const gi = args.findIndex((a) => a === '-g' || a === '--grep');
const grep = gi >= 0 ? args[gi + 1] : undefined;

const { CASES } = await import('../src/eval/cases.ts');
const { runCase } = await import('../src/eval/harness.ts');

let selected = CASES;
if (grep) selected = selected.filter((c) => c.name.includes(grep));

if (!process.env.ADA_TOKEN) {
  console.log('ADA_TOKEN is not set — evals need a real model. Skipping.');
  process.exit(0);
}

const results = [];
for (const c of selected) {
  const r = await runCase(c);
  results.push(r);
  const mark = r.status === 'pass' ? 'pass' : r.status === 'skip' ? 'skip' : 'FAIL';
  console.log(`  ${mark.padEnd(4)} ${r.name}`);
  if (r.detail) console.log(`       ${r.detail.replace(/\n/g, '\n       ')}`);
}

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skip = results.filter((r) => r.status === 'skip').length;
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail > 0 ? 1 : 0);
