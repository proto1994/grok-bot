/**
 * Builds the orchestrator for packaging.
 *
 * tsc only emits .ts, so anything else the server reads at runtime has to be
 * copied next to it: the UI, and the egress proxy's sources (the docker driver
 * copies those into the proxy container, which runs them with Node's type
 * stripping — that container has Node 22, unlike Electron's bundled Node 20).
 *
 *   pnpm build
 */
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

console.log('cleaning dist');
await rm(dist, { recursive: true, force: true });

console.log('compiling typescript');
const tsc = spawnSync('pnpm', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

console.log('copying runtime assets');
// The UI, served verbatim.
await mkdir(path.join(dist, 'web'), { recursive: true });
for (const f of ['index.html', 'shapes.js']) {
  await cp(path.join(root, 'src/web', f), path.join(dist, 'web', f));
}

// The proxy container runs these as TypeScript, so the .ts files ship as-is
// alongside their compiled counterparts. One copy of the filtering logic, two
// ways of running it.
for (const f of ['egress.ts', 'proxy.ts', 'proxy-entry.ts', 'types.ts']) {
  await cp(path.join(root, 'src/sandbox', f), path.join(dist, 'sandbox', f));
}

const count = async (dir) => {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await count(path.join(dir, e.name)) : 1;
  }
  return n;
};
const size = async (dir) => {
  let b = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    b += e.isDirectory() ? await size(p) : (await stat(p)).size;
  }
  return b;
};

console.log(`\ndist: ${await count(dist)} files, ${(await size(dist) / 1024).toFixed(0)} KB`);
console.log('entry: dist/server/index.js');
