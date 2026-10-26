/**
 * Integration test for the docker driver and real network isolation.
 * Needs a running daemon; skips cleanly without one.
 *
 *   pnpm docker
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const daemon = spawnSync('docker', ['ps'], { encoding: 'utf8' });
if (daemon.status !== 0) {
  console.log('docker daemon is not reachable — skipping.');
  console.log('  start Docker Desktop, then: pnpm docker');
  process.exit(0);
}

const OWNER = 'dockertest';
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

const dk = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

const TARGET = 'dt';
const { makeDockerDriver, destroyOwner } = await import('../src/sandbox/docker.ts');
const { loadPolicy } = await import('../src/sandbox/egress.ts');

async function withPolicy(
  policy: string | null,
  fn: (sandbox: import('../src/sandbox/types.ts').Sandbox) => Promise<void>,
) {
  const target = {
    kind: 'docker' as const,
    ...(policy ? { egress: loadPolicy(JSON.parse(policy)) } : {}),
  };
  await destroyOwner(OWNER, TARGET, target);
  const sandbox = await makeDockerDriver(TARGET, target).acquire(OWNER);
  try {
    await fn(sandbox);
  } finally {
    await destroyOwner(OWNER, TARGET, target);
  }
}

console.log('docker driver — allow_all');
await withPolicy(null, async (sandbox) => {
  await check('a command runs in the container', async () => {
    const r = await sandbox.exec('echo hello && pwd');
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello/);
    assert.match(r.stdout, /\/workspace/);
  });
  await check('the sandbox is a container, not this host', async () => {
    const r = await sandbox.exec('cat /etc/os-release | head -1');
    assert.match(r.stdout, /Debian|Ubuntu/i);
  });
  await check('files round-trip through the volume', async () => {
    await sandbox.writeFile('note.txt', 'persisted');
    assert.equal((await sandbox.readFile('note.txt')).trim(), 'persisted');
  });
  await check('a workspace file survives a container restart', async () => {
    dk('restart', `gbl-${TARGET}-${OWNER}`);
    assert.equal((await sandbox.readFile('note.txt')).trim(), 'persisted');
  });
});

console.log('docker driver — allowlist_only');
await withPolicy(
  JSON.stringify({ mode: 'allowlist_only', allowed: ['example.com'], applyToMcp: false }),
  async (sandbox) => {
    await check('the proxy container is running', () => {
      const r = dk('inspect', '-f', '{{.State.Running}}', `gbl-proxy-${TARGET}-${OWNER}`);
      assert.equal(r.stdout.trim(), 'true');
    });

    await check('the sandbox sits on an internal network only', () => {
      const r = dk('inspect', '-f', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}', `gbl-${TARGET}-${OWNER}`);
      const nets = r.stdout.trim().split(/\s+/).filter(Boolean);
      assert.deepEqual(nets, [`gbl-net-${TARGET}-${OWNER}`], `networks: ${r.stdout}`);
    });

    await check('the proxy bridges the internal and egress networks', () => {
      const r = dk('inspect', '-f', '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}', `gbl-proxy-${TARGET}-${OWNER}`);
      const nets = r.stdout.trim().split(/\s+/).filter(Boolean).sort();
      assert.deepEqual(nets, [`gbl-egress-${TARGET}-${OWNER}`, `gbl-net-${TARGET}-${OWNER}`], `networks: ${r.stdout}`);
    });

    await check('a direct connection out is impossible, not merely discouraged', async () => {
      // No proxy env: this is what a process that ignores HTTP_PROXY would do.
      const r = await sandbox.exec(
        'env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ' +
          'getent hosts example.com >/dev/null 2>&1 && echo RESOLVED || echo NO_ROUTE',
        { timeoutMs: 30_000 },
      );
      assert.match(r.stdout, /NO_ROUTE/, `expected no route off the internal network, got: ${r.stdout}`);
    });

    await check('the proxy refuses a host outside the allowlist', async () => {
      const r = await sandbox.exec(
        'node -e "' +
          'const http=require(\'http\');' +
          "const req=http.request({host:'egress-proxy',port:8888,method:'CONNECT',path:'blocked.test:443'});" +
          "req.on('connect',(res)=>{console.log('STATUS '+res.statusCode);process.exit(0)});" +
          "req.on('response',(res)=>{console.log('STATUS '+res.statusCode);process.exit(0)});" +
          "req.on('error',(e)=>{console.log('ERR '+e.message);process.exit(0)});" +
          'req.end();"',
        { timeoutMs: 30_000 },
      );
      assert.match(r.stdout, /STATUS 403/, `expected a 403 from the proxy, got: ${r.stdout}`);
    });

    await check('the denial is visible to the operator in the proxy log', () => {
      const r = dk('logs', `gbl-proxy-${TARGET}-${OWNER}`);
      assert.match(r.stdout + r.stderr, /\[deny\] blocked\.test/);
    });

    await check('an allowlisted host is reachable through the proxy', async () => {
      // The other half of the policy: blocking is useless if nothing gets out.
      const r = await sandbox.exec(
        'node -e "' +
          'const http=require(\'http\');' +
          "const req=http.request({host:'egress-proxy',port:8888,method:'CONNECT',path:'example.com:443'});" +
          "req.on('connect',(res)=>{console.log('STATUS '+res.statusCode);process.exit(0)});" +
          "req.on('response',(res)=>{console.log('STATUS '+res.statusCode);process.exit(0)});" +
          "req.on('error',(e)=>{console.log('ERR '+e.message);process.exit(0)});" +
          'req.end();"',
        { timeoutMs: 40_000 },
      );
      assert.match(r.stdout, /STATUS 200/, `expected the tunnel to open, got: ${r.stdout}`);
    });

    await check('a subdomain of an allowlisted host is reachable too', async () => {
      const r = await sandbox.exec(
        'node -e "' +
          'const http=require(\'http\');' +
          "const req=http.request({host:'egress-proxy',port:8888,method:'CONNECT',path:'www.example.com:443'});" +
          "req.on('connect',(res)=>{console.log('STATUS '+res.statusCode);process.exit(0)});" +
          "req.on('response',(res)=>{console.log('STATUS '+res.statusCode);process.exit(0)});" +
          "req.on('error',(e)=>{console.log('ERR '+e.message);process.exit(0)});" +
          'req.end();"',
        { timeoutMs: 40_000 },
      );
      assert.match(r.stdout, /STATUS 200/, `expected the tunnel to open, got: ${r.stdout}`);
    });
  },
);

console.log('two targets, same owner');
// Stands in for local-vs-remote: a real remote target differs only in the
// daemon flags, so what matters here is that nothing is shared between targets.
{
  const tA = { kind: 'docker' as const };
  const tB = { kind: 'docker' as const };
  await destroyOwner(OWNER, 'ta', tA);
  await destroyOwner(OWNER, 'tb', tB);

  const a = await makeDockerDriver('ta', tA).acquire(OWNER);
  const b = await makeDockerDriver('tb', tB).acquire(OWNER);

  try {
    await check('each target gets its own container', () => {
      const ra = dk('inspect', '-f', '{{.Name}}', `gbl-ta-${OWNER}`);
      const rb = dk('inspect', '-f', '{{.Name}}', `gbl-tb-${OWNER}`);
      assert.equal(ra.status, 0, 'target ta should have a container');
      assert.equal(rb.status, 0, 'target tb should have a container');
    });

    await check('a file written on one target is not visible on the other', async () => {
      await a.writeFile('only-here.txt', 'from target A');
      assert.equal((await a.readFile('only-here.txt')).trim(), 'from target A');
      await assert.rejects(
        () => b.readFile('only-here.txt'),
        'the second target must not see the first target\'s workspace',
      );
    });

    await check('each target has its own volume', () => {
      assert.equal(dk('volume', 'inspect', `gbl-ws-ta-${OWNER}`).status, 0);
      assert.equal(dk('volume', 'inspect', `gbl-ws-tb-${OWNER}`).status, 0);
    });
  } finally {
    await destroyOwner(OWNER, 'ta', tA);
    await destroyOwner(OWNER, 'tb', tB);
    dk('volume', 'rm', `gbl-ws-ta-${OWNER}`);
    dk('volume', 'rm', `gbl-ws-tb-${OWNER}`);
  }
}

console.log(`\n${passed} checks passed`);
