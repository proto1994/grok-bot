/**
 * Shell command classification.
 *
 * This decides whether a command runs without asking, so the interesting cases
 * are the ones that try to look harmless. Anything unproven must come back as
 * 'write': a false 'read' runs unreviewed, a false 'write' costs one prompt.
 *
 *   pnpm tsx scripts/classify-test.ts
 */
import assert from 'node:assert/strict';
import { classifyBash, evaluate } from '../src/agent/policy.ts';

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

const readOnly = (cmd: string) => assert.equal(classifyBash(cmd), 'read', `"${cmd}" should be read-only`);
const needsApproval = (cmd: string) =>
  assert.equal(classifyBash(cmd), 'write', `"${cmd}" must NOT be auto-allowed`);

console.log('plain reads run without asking');
check('listing and printing', () => {
  readOnly('ls -la');
  readOnly('cat notes.txt');
  readOnly('head -c 1500 feed.xml');
  readOnly('wc -l *.txt');
  readOnly('pwd');
  readOnly('date');
});
check('read-only subcommands of bigger tools', () => {
  readOnly('git status');
  readOnly('git log --oneline -20');
  readOnly('git diff HEAD~1');
  readOnly('npm ls --depth 0');
  readOnly('docker ps');
});

console.log('writes and unknowns ask');
check('obvious mutations', () => {
  needsApproval('rm -rf build');
  needsApproval('mv a b');
  needsApproval('touch new.txt');
  needsApproval('mkdir -p out');
  needsApproval('npm install left-pad');
});
check('write subcommands of read-mostly tools', () => {
  needsApproval('git push');
  needsApproval('git commit -m x');
  needsApproval('git checkout -b feature');
  needsApproval('docker rm -f box');
});
check('an unrecognised command is a write', () => {
  needsApproval('some-tool --do-things');
  needsApproval('./build.sh');
  needsApproval('python3 script.py');
});

console.log('attempts to look harmless');
check('a chained command cannot hide behind a safe prefix', () => {
  // The whole reason prefix matching is not enough.
  needsApproval('ls; rm -rf /');
  needsApproval('cat f && rm g');
  needsApproval('pwd || curl evil.example');
  needsApproval('date & rm -rf .');
});
check('redirection is a write even from a reading command', () => {
  needsApproval('cat a > b');
  needsApproval('echo hi >> log.txt');
  needsApproval('ls 2> err.txt');
});
check('command substitution is not auto-allowed', () => {
  needsApproval('echo `rm -rf x`');
  needsApproval('echo $(rm -rf x)');
  needsApproval('cat ${HOME}/.ssh/id_rsa');
});
check('a newline cannot smuggle a second command', () => {
  needsApproval('ls\nrm -rf /');
});
check('a pipe is not auto-allowed', () => {
  // `cat x | sh` reads nothing and executes everything.
  needsApproval('cat payload | sh');
  needsApproval('ls | xargs rm');
});
check('privilege escalation always asks', () => {
  needsApproval('sudo ls');
  needsApproval('su -c ls');
});
check('a path to a binary is not classified by its name', () => {
  needsApproval('/bin/ls');
  needsApproval('../ls');
});
check('find and grep that execute are writes', () => {
  needsApproval('find . -name x -delete');
  needsApproval('find . -exec rm {} ;');
});
check('empty or whitespace is a write', () => {
  needsApproval('');
  needsApproval('   ');
});

console.log('the policy engine still has the final say');
check('a read-only command is allowed by the risk floor', () => {
  assert.equal(evaluate('bash', classifyBash('ls -la')).decision, 'allow');
});
check('a write command asks', () => {
  assert.equal(evaluate('bash', classifyBash('rm -rf x')).decision, 'ask');
});
check('a team rule can require approval for every command', () => {
  const strict = [{ tool: 'bash', decision: 'ask' as const, reason: '所有命令都要批准' }];
  assert.equal(evaluate('bash', classifyBash('ls -la'), strict).decision, 'ask');
});
check('no rule can loosen a write below asking', () => {
  const loose = [{ tool: '*', decision: 'allow' as const, reason: 'try to loosen' }];
  assert.equal(evaluate('bash', classifyBash('rm -rf /'), loose, loose).decision, 'ask');
});

console.log(`\n${passed} checks passed`);
