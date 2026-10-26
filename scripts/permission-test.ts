/**
 * Permission modes.
 *
 * 'full' turns the approval gate off, so the thing worth guarding is that it
 * can only be reached deliberately: no rule, no transcript content, and no
 * default may produce it.
 *
 *   pnpm tsx scripts/permission-test.ts
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB = './data/test/permission-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.env.DB_PATH = DB;

const { store } = await import('../src/agent/store.ts');
const { classifyBash, evaluate, rulesForMode, DEFAULT_TEAM_RULES } = await import('../src/agent/policy.ts');
const { PERMISSION_MODES } = await import('../src/protocol.ts');

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
};

/** What the gate would decide, for modes that still consult the policy engine. */
const decide = (mode: 'strict' | 'balanced', tool: string, command?: string) => {
  const risk = tool === 'bash' ? classifyBash(command ?? '') : tool === 'read' ? 'read' : 'write';
  return evaluate(tool, risk, [...DEFAULT_TEAM_RULES, ...rulesForMode(mode)]).decision;
};

console.log('defaults');
check('a new bot is balanced, never full', () => {
  const b = store.createBot('perm', 'A', 'job');
  assert.equal(b.permissionMode, 'balanced');
});
check('full is never the default for any code path', () => {
  const b = store.createBot('perm', 'B', 'job', null);
  assert.notEqual(b.permissionMode, 'full');
});

console.log('balanced');
check('reads run without asking', () => {
  assert.equal(decide('balanced', 'read'), 'allow');
  assert.equal(decide('balanced', 'bash', 'ls -la'), 'allow');
});
check('writes ask', () => {
  assert.equal(decide('balanced', 'write'), 'ask');
  assert.equal(decide('balanced', 'bash', 'rm -rf x'), 'ask');
});

console.log('strict');
check('even a read asks', () => {
  assert.equal(decide('strict', 'read'), 'ask');
  assert.equal(decide('strict', 'bash', 'ls -la'), 'ask');
});
check('writes still ask', () => {
  assert.equal(decide('strict', 'bash', 'rm -rf x'), 'ask');
});

console.log('full is not reachable through the policy engine');
check('rulesForMode emits nothing permissive for full', () => {
  // If this ever returns an 'allow' rule, the engine's "only tighten" property
  // would be the thing standing between a prompt and an unreviewed command.
  assert.deepEqual(rulesForMode('full'), []);
  assert.deepEqual(rulesForMode('balanced'), []);
  assert.equal(rulesForMode('strict').length, 1);
  assert.equal(rulesForMode('strict')[0]!.decision, 'ask');
});
check('the engine still asks for a write under full', () => {
  // The bypass lives in the gate, not here — so the engine must be unchanged.
  const asIfFull = evaluate('bash', classifyBash('rm -rf /'), [
    ...DEFAULT_TEAM_RULES, ...rulesForMode('full'),
  ]);
  assert.equal(asIfFull.decision, 'ask');
});

console.log('switching modes');
check('a mode change persists', () => {
  const b = store.createBot('perm', 'C', 'job');
  store.setPermissionMode(b.id, 'full');
  assert.equal(store.getBot(b.id)!.permissionMode, 'full');
  store.setPermissionMode(b.id, 'strict');
  assert.equal(store.getBot(b.id)!.permissionMode, 'strict');
});
check('a bot created as full keeps that mode', () => {
  const b = store.createBot('perm', 'D', 'job', null, 'full');
  assert.equal(store.getBot(b.id)!.permissionMode, 'full');
});
check('only the three known modes exist', () => {
  assert.deepEqual(PERMISSION_MODES, ['strict', 'balanced', 'full']);
});

console.log('existing bots');
check('a bot from before this feature reads as balanced', () => {
  // The migration adds the column as NULL; nothing should silently become full.
  const b = store.createBot('perm', 'E', 'job');
  const db = new DatabaseSync(DB);
  db.prepare('UPDATE bots SET permissionMode=NULL WHERE id=?').run(b.id);
  db.close();
  assert.notEqual(store.getBot(b.id)!.permissionMode, 'full');
});

console.log(`\n${passed} checks passed`);
