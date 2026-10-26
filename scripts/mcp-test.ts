/**
 * Exercises the MCP client and registry against a local fixture server.
 *   pnpm tsx scripts/mcp-test.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DB_PATH = './data/test/mcp-test.db';

const { McpClient } = await import('../src/mcp/client.ts');
const { loadMcpServers, stopMcpServers } = await import('../src/mcp/registry.ts');
const { TOOLS, toolSchemas } = await import('../src/agent/tools.ts');
const { evaluate } = await import('../src/agent/policy.ts');

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

const FIXTURE = path.resolve('scripts/fixture-mcp-server.mjs');

console.log('mcp client');
const client = new McpClient('fixture', { command: process.execPath, args: [FIXTURE] });
const discovered = await client.start();

await check('discovers the server tools', () => {
  assert.deepEqual(discovered.map((t) => t.name).sort(), ['add', 'explode', 'ping']);
});
await check('calls a tool and reads its text content', async () => {
  assert.equal(await client.callTool('ping', { message: 'hi' }), 'pong hi');
});
await check('passes typed arguments through', async () => {
  assert.equal(await client.callTool('add', { a: 2, b: 40 }), '42');
});
await check('surfaces isError as a thrown error', async () => {
  await assert.rejects(() => client.callTool('explode', {}), /deliberate failure/);
});
await check('reports an unknown tool as an rpc error', async () => {
  await assert.rejects(() => client.callTool('nope', {}), /unknown tool/);
});
client.stop();
await check('calls after stop are refused, not hung', async () => {
  await assert.rejects(() => client.callTool('ping', {}), /not running/);
});

console.log('registry');
const dir = await mkdtemp(path.join(tmpdir(), 'mcp-cfg-'));
const cfg = path.join(dir, 'mcp.json');
await writeFile(cfg, JSON.stringify({
  servers: {
    fixture: { command: process.execPath, args: [FIXTURE], readOnlyTools: ['ping'] },
    broken: { command: process.execPath, args: ['/nonexistent/server.mjs'] },
    off: { command: process.execPath, args: [FIXTURE], disabled: true },
  },
}));

const loaded = await loadMcpServers(cfg);

await check('a broken server does not stop the healthy ones', () => {
  assert.deepEqual(loaded.map((l) => l.server), ['fixture']);
});
await check('disabled servers are skipped', () => {
  assert.equal(TOOLS['off__ping'], undefined);
});
await check('tools are namespaced by server', () => {
  assert.ok(TOOLS['fixture__ping'], Object.keys(TOOLS).join(','));
  assert.ok(TOOLS['fixture__add']);
});
await check('registered tools reach the model schema list', () => {
  assert.ok(toolSchemas().some((s) => s.name === 'fixture__add'));
});
await check('an MCP tool runs through the registry', async () => {
  const out = await TOOLS['fixture__add']!.run({ a: 1, b: 2 }, { botId: 'b', ownerId: 'o' });
  assert.equal(out, '3');
});
await check('unlisted MCP tools default to external risk, so they ask', () => {
  const t = TOOLS['fixture__add']!;
  assert.equal(t.risk, 'external');
  assert.equal(evaluate('fixture__add', t.risk).decision, 'ask');
});
await check('declared read-only tools are allowed without approval', () => {
  const t = TOOLS['fixture__ping']!;
  assert.equal(t.risk, 'read');
  assert.equal(evaluate('fixture__ping', t.risk).decision, 'allow');
});
await check('a missing config file is not an error', async () => {
  assert.deepEqual(await loadMcpServers(path.join(dir, 'absent.json')), []);
});
await check('an empty config file means no servers, not a failure', async () => {
  const empty = path.join(dir, 'empty.json');
  await writeFile(empty, '   \n');
  assert.deepEqual(await loadMcpServers(empty), []);
});
await check('a malformed config is reported, not swallowed', async () => {
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, '{ not json');
  await assert.rejects(() => loadMcpServers(bad), /cannot read/);
});

stopMcpServers();
console.log(`\n${passed} checks passed`);
