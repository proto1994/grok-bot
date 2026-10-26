/**
 * Sandbox target config and resolution. No daemon needed.
 *   pnpm tsx scripts/targets-test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = './data/test/targets-test.db';

const {
  builtinConfig, describeTarget, loadConfig, parseConfig, resolveTarget, targetEgress,
} = await import('../src/sandbox/config.ts');
const { getSandbox, setSandboxConfig, forgetSandbox } = await import('../src/sandbox/index.ts');
const { store } = await import('../src/agent/store.ts');

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

console.log('config parsing');
await check('a minimal config parses', () => {
  const c = parseConfig({ targets: { a: { kind: 'docker' } } });
  assert.equal(c.default, 'a');
});
await check('an explicit default is honoured', () => {
  const c = parseConfig({ targets: { a: { kind: 'docker' }, b: { kind: 'docker' } }, default: 'b' });
  assert.equal(c.default, 'b');
});
await check('a default that is not defined is rejected', () => {
  assert.throws(() => parseConfig({ targets: { a: { kind: 'docker' } }, default: 'nope' }), /not defined/);
});
await check('an unknown kind is rejected', () => {
  assert.throws(() => parseConfig({ targets: { a: { kind: 'vm' } } }), /must be "docker" or "local"/);
});
await check('a name that would break container naming is rejected', () => {
  assert.throws(() => parseConfig({ targets: { 'bad name!': { kind: 'docker' } } }), /alphanumeric/);
});
await check('dockerHost and dockerContext together are rejected', () => {
  assert.throws(
    () => parseConfig({ targets: { a: { kind: 'docker', dockerHost: 'ssh://h', dockerContext: 'c' } } }),
    /not both/,
  );
});
await check('a local target cannot name a daemon', () => {
  assert.throws(
    () => parseConfig({ targets: { a: { kind: 'local', dockerHost: 'ssh://h' } } }),
    /cannot have dockerHost/,
  );
});
await check('an empty targets map is rejected', () => {
  assert.throws(() => parseConfig({ targets: {} }), /no targets/);
});
await check('a bad egress policy inside a target is rejected', () => {
  assert.throws(() => parseConfig({ targets: { a: { kind: 'docker', egress: { mode: 'nope' } } } }), /unknown egress mode/);
});

console.log('files');
const dir = await mkdtemp(path.join(tmpdir(), 'targets-'));
await check('a missing file falls back to the builtin config', async () => {
  assert.deepEqual(await loadConfig(path.join(dir, 'absent.json')), builtinConfig());
});
await check('an empty file falls back to the builtin config', async () => {
  const p = path.join(dir, 'empty.json');
  await writeFile(p, '  \n');
  assert.deepEqual(await loadConfig(p), builtinConfig());
});
await check('a malformed file is reported', async () => {
  const p = path.join(dir, 'bad.json');
  await writeFile(p, '{ nope');
  await assert.rejects(() => loadConfig(p), /cannot read/);
});
await check('the shipped example parses', async () => {
  const c = await loadConfig(path.resolve('sandboxes.example.json'));
  assert.ok(c.targets['remote-ssh']?.dockerHost);
  assert.equal(c.targets['unsafe-host']?.kind, 'local');
  assert.equal(c.default, 'local-docker');
});

console.log('resolution');
const cfg = parseConfig({
  targets: {
    here: { kind: 'docker' },
    there: { kind: 'docker', dockerHost: 'ssh://ops@elsewhere' },
  },
  default: 'here',
});
await check('null resolves to the default', () => {
  assert.equal(resolveTarget(cfg, null).name, 'here');
});
await check('a named target resolves', () => {
  assert.equal(resolveTarget(cfg, 'there').target.dockerHost, 'ssh://ops@elsewhere');
});
await check('an unknown target lists what is available', () => {
  assert.throws(() => resolveTarget(cfg, 'ghost'), /Available: here, there/);
});
await check('egress defaults to allow_all when a target omits it', () => {
  assert.equal(targetEgress(cfg.targets['here']!).mode, 'allow_all');
});
await check('describeTarget says where a remote target points', () => {
  assert.match(describeTarget('there', cfg.targets['there']!), /ssh:\/\/ops@elsewhere/);
  assert.match(describeTarget('here', cfg.targets['here']!), /this machine/);
});

console.log('bots carry a target');
await check('a bot defaults to no explicit target', () => {
  const b = store.createBot('t-owner', 'A', 'job');
  assert.equal(b.sandboxTarget, null);
});
await check('a bot can be created on a named target', () => {
  const b = store.createBot('t-owner', 'B', 'job', 'there');
  assert.equal(store.getBot(b.id)!.sandboxTarget, 'there');
});
await check('a bot can be moved to another target', () => {
  const b = store.createBot('t-owner', 'C', 'job', 'here');
  store.setBotTarget(b.id, 'there');
  assert.equal(store.getBot(b.id)!.sandboxTarget, 'there');
  store.setBotTarget(b.id, null);
  assert.equal(store.getBot(b.id)!.sandboxTarget, null);
});

console.log('per-target isolation');
await check('the same owner on two targets gets two separate sandboxes', async () => {
  // Both targets are 'local' here so no daemon is needed; what matters is that
  // the cache key includes the target, not just the owner.
  process.env.SANDBOX_ALLOW_LOCAL = '1';
  process.env.LOCAL_SANDBOX_ROOT = './data/test/workspaces';
  setSandboxConfig(parseConfig({
    targets: { one: { kind: 'local' }, two: { kind: 'local' } },
    default: 'one',
  }));

  const a = await getSandbox('iso-owner', 'one');
  const b = await getSandbox('iso-owner', 'two');
  const again = await getSandbox('iso-owner', 'one');
  assert.equal(a, again, 'the same (target, owner) should be cached');
  assert.notEqual(a, b, 'different targets must not share a sandbox handle');
});
await check('forgetSandbox drops only the named target', async () => {
  const a1 = await getSandbox('iso-owner', 'one');
  forgetSandbox('iso-owner', 'one');
  const a2 = await getSandbox('iso-owner', 'one');
  assert.notEqual(a1, a2, 'the forgotten target should be re-acquired');
  const b1 = await getSandbox('iso-owner', 'two');
  const b2 = await getSandbox('iso-owner', 'two');
  assert.equal(b1, b2, 'the other target should be untouched');
});
await check('an unknown target fails loudly at acquire time', async () => {
  await assert.rejects(() => getSandbox('iso-owner', 'ghost'), /unknown sandbox target/);
});

console.log(`\n${passed} checks passed`);
