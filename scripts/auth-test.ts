/**
 * Authorization scoping and token handling. No model, no network.
 *
 *   pnpm tsx scripts/auth-test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

const DB = './data/test/auth-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;

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

/* ---------- authorization scoping ---------- */

// Two owners, each with a bot, a run, a step, and an open approval.
const alice = store.createBot('alice', 'A', 'job');
const bob = store.createBot('bob', 'B', 'job');

const aliceRun = store.createRun(alice.id);
const bobRun = store.createRun(bob.id);
store.appendStep(aliceRun.id, 'assistant_text', 'alice private text');
store.appendStep(bobRun.id, 'assistant_text', 'bob private text');

const aliceApproval = store.createApproval({
  runId: aliceRun.id, botId: alice.id, tool: 'write',
  args: '{"path":"a.txt"}', reason: 'test', risk: 'write',
});
const bobApproval = store.createApproval({
  runId: bobRun.id, botId: bob.id, tool: 'write',
  args: '{"path":"b.txt"}', reason: 'test', risk: 'write',
});

console.log('owner scoping');
await check('an owner can read their own run', () => {
  assert.equal(store.getRunFor('alice', aliceRun.id)?.id, aliceRun.id);
});
await check("another owner's run reads as absent", () => {
  assert.equal(store.getRunFor('bob', aliceRun.id), undefined);
});
await check('listing runs is scoped to the owner', () => {
  assert.equal(store.listRunsFor('alice', alice.id).length, 1);
  assert.equal(store.listRunsFor('bob', alice.id).length, 0, "bob must not list alice's runs");
});
await check("steps of another owner's run are not readable", () => {
  assert.equal(store.listStepsFor('alice', aliceRun.id).length, 1);
  assert.equal(store.listStepsFor('bob', aliceRun.id).length, 0);
});
await check("another owner's approval is not visible", () => {
  assert.ok(store.getApprovalFor('alice', aliceApproval.id));
  assert.equal(store.getApprovalFor('bob', aliceApproval.id), undefined);
});
await check('pending approvals are scoped', () => {
  assert.equal(store.pendingApprovalsFor('alice', aliceRun.id).length, 1);
  assert.equal(store.pendingApprovalsFor('bob', aliceRun.id).length, 0);
});

await check("an owner cannot resolve another owner's approval", () => {
  const out = store.resolveApprovalFor('bob', aliceApproval.id, true);
  assert.equal(out, undefined, 'the call must refuse');
  assert.equal(
    store.getApproval(aliceApproval.id)!.resolvedAt, null,
    'the approval must remain open — this is the one that would have approved a write',
  );
});
await check('an owner can resolve their own approval', () => {
  const out = store.resolveApprovalFor('bob', bobApproval.id, true);
  assert.ok(out);
  assert.equal(store.getApproval(bobApproval.id)!.approved, 1);
});
await check('openApprovals never crosses owners', () => {
  assert.ok(store.openApprovals('alice').every((a) => a.botId === alice.id));
  assert.equal(store.openApprovals('bob').length, 0, "bob's only approval was just resolved");
});

/* ---------- token handling ---------- */

console.log('token handling');
const dir = mkdtempSync(path.join(tmpdir(), 'auth-'));
const envFile = path.join(dir, '.env');
process.env.AUTH_ENV_FILE = envFile;
delete process.env.AUTH_TOKEN;

const fresh = await import(`../src/server/auth.ts?a=${Math.random()}`);

await check('a token is generated and persisted when absent', () => {
  const a = fresh.loadAuth();
  assert.ok(a.generated);
  assert.ok(a.token.length >= 32);
  assert.match(readFileSync(envFile, 'utf8'), /AUTH_TOKEN=/);
});

await check('a persisted token is reused, not regenerated', () => {
  const first = readFileSync(envFile, 'utf8').match(/AUTH_TOKEN=(.+)/)![1]!.trim();
  const again = fresh.loadAuth();
  assert.equal(again.token, first);
  assert.equal(again.generated, false, 'a restart must not invalidate existing clients');
});

await check('an env var takes precedence over the file', () => {
  process.env.AUTH_TOKEN = 'from-the-environment';
  assert.equal(fresh.loadAuth().token, 'from-the-environment');
  delete process.env.AUTH_TOKEN;
});

await check('a quoted value in the file is unquoted', () => {
  writeFileSync(envFile, 'AUTH_TOKEN="quoted-value"\n');
  assert.equal(fresh.loadAuth().token, 'quoted-value');
});

const auth = { token: 'the-real-token', generated: false };
const reqWith = (headers: Record<string, string>, url = '/api/bots'): IncomingMessage =>
  ({ headers, url } as unknown as IncomingMessage);

await check('a correct bearer token is accepted', () => {
  assert.equal(fresh.authorized(reqWith({ authorization: 'Bearer the-real-token' }), auth), true);
});
await check('a wrong token is rejected', () => {
  assert.equal(fresh.authorized(reqWith({ authorization: 'Bearer nope' }), auth), false);
});
await check('a missing token is rejected', () => {
  assert.equal(fresh.authorized(reqWith({}), auth), false);
});
await check('a token prefix is not accepted', () => {
  // Guards against a comparison that stops at the shorter length.
  assert.equal(fresh.authorized(reqWith({ authorization: 'Bearer the-real' }), auth), false);
});
await check('a query token works for the websocket handshake', () => {
  assert.equal(fresh.authorized(reqWith({}, '/ws?token=the-real-token'), auth), true);
  assert.equal(fresh.authorized(reqWith({}, '/ws?token=wrong'), auth), false);
});

console.log('origin checks');
await check('no Origin header is allowed (curl, scripts)', () => {
  assert.equal(fresh.originAllowed(reqWith({}), '127.0.0.1', 4000), true);
});
await check('our own origin is allowed', () => {
  assert.equal(fresh.originAllowed(reqWith({ origin: 'http://127.0.0.1:4000' }), '127.0.0.1', 4000), true);
  assert.equal(fresh.originAllowed(reqWith({ origin: 'http://localhost:4000' }), '127.0.0.1', 4000), true);
});
await check('a foreign origin is refused', () => {
  // The attack this exists for: a visited page fetching our API.
  assert.equal(fresh.originAllowed(reqWith({ origin: 'http://evil.example' }), '127.0.0.1', 4000), false);
});
await check('a different port on localhost is refused', () => {
  assert.equal(fresh.originAllowed(reqWith({ origin: 'http://127.0.0.1:9999' }), '127.0.0.1', 4000), false);
});

rmSync(dir, { recursive: true, force: true });
delete process.env.AUTH_ENV_FILE;
console.log(`\n${passed} checks passed`);
