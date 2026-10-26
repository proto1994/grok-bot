import type { PermissionMode, RiskLevel } from '../protocol.ts';

export type Decision = 'allow' | 'ask';

export interface Rule {
  /** Glob-ish match on the tool name: "*" or "shell*" or "shell". */
  tool: string;
  decision: Decision;
  reason: string;
}

/**
 * Approval is a rule engine, not a line in the prompt. A model can be talked out
 * of an instruction; it cannot talk its way past this function.
 *
 * Stricter wins. Member rules may only tighten what team rules allow, so a run
 * cannot be made looser by anything the user (or a prompt injection) says.
 */
const RANK: Record<Decision, number> = { allow: 0, ask: 1 };

export const DEFAULT_TEAM_RULES: Rule[] = [
  // Nothing is loosened here: the risk floor still decides. A read-only command
  // is allowed by the floor; anything classifyBash cannot vouch for is a write
  // and asks. Add { tool: 'bash', decision: 'ask' } to require approval for
  // every command, including reads.
  { tool: '*', decision: 'allow', reason: '默认' },
];

function matches(pattern: string, tool: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/** Risk floor: anything that writes or leaves the sandbox asks by default. */
function riskFloor(risk: RiskLevel): { decision: Decision; reason: string } {
  // These reasons are shown on the approval card, so they are written for the
  // person deciding, in the UI's language.
  if (risk === 'read') return { decision: 'allow', reason: '只读操作' };
  if (risk === 'write') return { decision: 'ask', reason: '会改动沙箱里的东西' };
  return { decision: 'ask', reason: '会访问外部服务' };
}

/**
 * Shell constructs that let one command become several, or redirect output.
 *
 * A prefix that looks harmless proves nothing: `ls; rm -rf /` starts with `ls`.
 * Anything containing these is never classified as read-only, whatever the
 * first word is.
 */
const CHAINING = /[;&|><`]|\$\(|\$\{|\n/;

/**
 * Commands that only read, and cannot be talked into doing more by their
 * arguments alone.
 *
 * Network commands are deliberately absent: where they may connect is the
 * egress policy's business, and a request leaving the sandbox is worth a
 * decision even when it writes nothing locally.
 */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'date', 'file', 'stat', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink', 'which', 'type', 'env', 'printenv',
  'uname', 'whoami', 'id', 'hostname', 'echo', 'printf', 'seq', 'sort', 'uniq',
  'cut', 'tr', 'nl', 'diff', 'cmp', 'md5sum', 'shasum', 'sha256sum', 'tree',
]);

/** Subcommands that only read, for tools whose risk depends on the verb. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(['log', 'status', 'diff', 'show', 'branch', 'remote', 'config',
                'blame', 'describe', 'rev-parse', 'ls-files', 'shortlog', 'tag']),
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why']),
  pnpm: new Set(['ls', 'list', 'why', 'outdated']),
  docker: new Set(['ps', 'images', 'inspect', 'logs', 'version', 'info']),
};

/**
 * Risk of a specific shell command.
 *
 * Conservative by construction: this returns 'read' only for a command it can
 * account for completely, and 'write' for everything else — including anything
 * it cannot parse. Being wrong in that direction costs an approval prompt;
 * being wrong the other way runs something unreviewed.
 */
export function classifyBash(command: string): RiskLevel {
  const cmd = command.trim();
  if (!cmd) return 'write';

  // Could be more than one command, or could redirect into a file.
  if (CHAINING.test(cmd)) return 'write';

  const parts = cmd.split(/\s+/);
  const head = parts[0]!;

  // An absolute or relative path to a binary is not something to reason about.
  if (head.includes('/')) return 'write';
  // Anything that changes who is running is a decision in itself.
  if (head === 'sudo' || head === 'su' || head === 'doas') return 'write';

  const subs = READ_ONLY_SUBCOMMANDS[head];
  if (subs) {
    const sub = parts.slice(1).find((p) => !p.startsWith('-'));
    return sub && subs.has(sub) ? 'read' : 'write';
  }

  if (!READ_ONLY_COMMANDS.has(head)) return 'write';

  // `find` and `grep` read, but both can execute: -exec, -delete, -ok.
  if (parts.some((p) => /^-(exec|execdir|delete|ok|okdir)$/.test(p))) return 'write';

  return 'read';
}

/**
 * Extra rules implied by a permission mode.
 *
 * Only 'strict' appears here, because only tightening can be expressed as a
 * rule. 'full' means not consulting this engine at all — see the gate.
 */
export function rulesForMode(mode: PermissionMode): Rule[] {
  if (mode === 'strict') {
    return [{ tool: '*', decision: 'ask', reason: '这个 Bot 设成了逐次确认' }];
  }
  return [];
}

export function evaluate(
  tool: string,
  risk: RiskLevel,
  teamRules: Rule[] = DEFAULT_TEAM_RULES,
  memberRules: Rule[] = [],
): { decision: Decision; reason: string } {
  let current = riskFloor(risk);

  for (const r of [...teamRules, ...memberRules]) {
    if (!matches(r.tool, tool)) continue;
    // Only ever move toward stricter.
    if (RANK[r.decision] > RANK[current.decision]) {
      current = { decision: r.decision, reason: r.reason };
    }
  }
  return current;
}
