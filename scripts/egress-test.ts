/**
 * Egress policy + filtering proxy. No docker needed: a local HTTP server stands
 * in for an upstream, and the proxy is driven over a real socket.
 *
 *   pnpm tsx scripts/egress-test.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import {
  DEFAULT_POLICY, describePolicy, hostMatches, isAllowed, loadPolicy, mcpAllowed,
  type EgressPolicy,
} from '../src/sandbox/egress.ts';
import { startEgressProxy } from '../src/sandbox/proxy.ts';

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

console.log('host matching');
await check('an exact host matches', () => assert.ok(hostMatches('example.com', 'example.com')));
await check('a subdomain matches its parent', () => assert.ok(hostMatches('example.com', 'api.example.com')));
await check('a lookalike suffix does NOT match', () => assert.equal(hostMatches('example.com', 'notexample.com'), false));
await check('a partial label does NOT match', () => assert.equal(hostMatches('ample.com', 'example.com'), false));
await check('matching ignores case and a trailing dot', () => assert.ok(hostMatches('Example.COM', 'API.example.com.')));
await check('a wildcard matches subdomains only', () => {
  assert.ok(hostMatches('*.example.com', 'api.example.com'));
  assert.equal(hostMatches('*.example.com', 'example.com'), false);
});

console.log('policy modes');
const only: EgressPolicy = { mode: 'allowlist_only', allowed: ['internal.corp'], applyToMcp: false };
await check('allow_all permits anything', () => assert.ok(isAllowed(DEFAULT_POLICY, 'anywhere.example')));
await check('allowlist_only permits a listed host', () => assert.ok(isAllowed(only, 'git.internal.corp')));
await check('allowlist_only refuses an unlisted host', () => assert.equal(isAllowed(only, 'evil.example'), false));
await check('allowlist_only refuses the package registry too', () => assert.equal(isAllowed(only, 'registry.npmjs.org'), false));
await check('defaults_plus_allowlist permits both', () => {
  const p: EgressPolicy = { mode: 'defaults_plus_allowlist', allowed: ['internal.corp'], applyToMcp: false };
  assert.ok(isAllowed(p, 'registry.npmjs.org'));
  assert.ok(isAllowed(p, 'git.internal.corp'));
  assert.equal(isAllowed(p, 'evil.example'), false);
});

console.log('mcp is a separate path');
await check('an allowlist does NOT restrict MCP by default', () => {
  assert.ok(mcpAllowed(only, 'evil.example'), 'this is the documented trap, not a bug');
});
await check('applyToMcp holds MCP to the same list', () => {
  const p: EgressPolicy = { ...only, applyToMcp: true };
  assert.equal(mcpAllowed(p, 'evil.example'), false);
  assert.ok(mcpAllowed(p, 'api.internal.corp'));
});
await check('describePolicy says whether MCP is covered', () => {
  assert.match(describePolicy(only), /NOT restricted/);
  assert.match(describePolicy({ ...only, applyToMcp: true }), /same list/);
});
await check('an unknown mode is rejected at load', () => {
  assert.throws(() => loadPolicy({ mode: 'yolo' }), /unknown egress mode/);
});

console.log('proxy enforcement');
// Stand-in upstream. 127.0.0.1 is the "host" the policy decides on.
const upstream = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('upstream-ok');
});
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = (upstream.address() as net.AddressInfo).port;

const proxy = await startEgressProxy(
  { mode: 'allowlist_only', allowed: ['127.0.0.1'], applyToMcp: false },
  { host: '127.0.0.1' },
);

const viaProxy = (host: string, port: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => {
      s.write(`GET http://${host}:${port}/ HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('end', () => resolve(buf));
    s.on('error', reject);
    setTimeout(() => {
      s.destroy();
      resolve(buf);
    }, 3000);
  });

await check('an allowed host reaches the upstream', async () => {
  const res = await viaProxy('127.0.0.1', upstreamPort);
  assert.match(res, /200 OK/);
  assert.match(res, /upstream-ok/);
});

await check('a blocked host gets 403 and never connects', async () => {
  const res = await viaProxy('blocked.example', 80);
  assert.match(res, /403 Forbidden/);
  assert.match(res, /not in the allowlist/);
});

await check('a denial is recorded for the operator', () => {
  assert.ok(proxy.denials().some((d) => d.host === 'blocked.example'));
});

await check('CONNECT to a blocked host is refused before the tunnel opens', async () => {
  const res = await new Promise<string>((resolve) => {
    const s = net.connect(proxy.port, '127.0.0.1', () => {
      s.write('CONNECT blocked.example:443 HTTP/1.1\r\nHost: blocked.example:443\r\n\r\n');
    });
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('end', () => resolve(buf));
    setTimeout(() => {
      s.destroy();
      resolve(buf);
    }, 3000);
  });
  assert.match(res, /403 Forbidden/);
});

await check('setPolicy takes effect for new connections', async () => {
  proxy.setPolicy({ mode: 'allow_all', allowed: [], applyToMcp: false });
  const res = await viaProxy('127.0.0.1', upstreamPort);
  assert.match(res, /upstream-ok/);
});

await proxy.close();
upstream.close();
console.log(`\n${passed} checks passed`);
