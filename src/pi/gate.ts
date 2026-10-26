import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { PermissionMode, RiskLevel } from '../protocol.ts';
import {
  classifyBash, DEFAULT_TEAM_RULES, evaluate, rulesForMode, type Rule,
} from '../agent/policy.ts';
import { store } from '../agent/store.ts';

/**
 * The approval gate, as a PI extension.
 *
 * PI deliberately ships no permission prompt — the documented answer is to run
 * in a container or write an extension. This is that extension: it intercepts
 * every tool call, asks the policy engine, and for anything that needs a human
 * it parks the call and awaits a decision made elsewhere (the HTTP API, driven
 * by the UI).
 *
 * The handler may await indefinitely, verified against PI 0.85.1: a call held
 * for 10s was still executed on release, and a blocked call never ran.
 *
 * Two properties matter more than anything else here:
 *
 *  - A thrown handler blocks the call. PI treats handler failure as a block, so
 *    a bug in this file cannot silently open the gate.
 *  - Registration is asserted at startup. An extension passed in the wrong
 *    shape is silently ignored by PI, which would look exactly like a system
 *    with no gate at all.
 */

/** Risk per PI built-in tool. Anything unknown is treated as external. */
const TOOL_RISK: Record<string, RiskLevel> = {
  read: 'read',
  ls: 'read',
  grep: 'read',
  find: 'read',
  bash: 'write',
  powershell: 'write',
  write: 'write',
  edit: 'write',
  ask_choice: 'read',
  list_routines: 'read',
  // Commits the bot to acting unprompted, so it is a change like any other.
  schedule_routine: 'write',
  list_bots: 'read',
  // Causes work on another bot, which spends tokens and may touch real systems.
  message_bot: 'external',
};

export function riskOf(toolName: string): RiskLevel {
  return TOOL_RISK[toolName] ?? 'external';
}

export interface GateHooks {
  /** How long a decision took, so a turn's budget can exclude it. */
  onWaited?: (ms: number) => void;
  /** Called when a call is parked. */
  onPark: (approvalId: string) => void;
  /** Called once a decision arrives. */
  onDecide?: (approvalId: string, approved: boolean) => void;
  /** Mirrors the tool call into the step log before the policy runs. */
  onCall?: (toolName: string, args: unknown) => void;
}

export interface GateOptions {
  botId: string;
  runId: () => string | null;
  /** Read per call, so a change takes effect without rebuilding the session. */
  mode: () => PermissionMode;
  teamRules?: Rule[];
  memberRules?: Rule[];
  hooks: GateHooks;
  /** Resolution poll interval. */
  pollMs?: number;
  /** Abort signal: a stopped run must not leave a handler hanging forever. */
  signal?: AbortSignal;
}

export class GateNotRegisteredError extends Error {
  constructor() {
    super(
      'the approval gate never registered with PI — refusing to run. ' +
        'Inline extensions go through DefaultResourceLoader({ extensionFactories }) ' +
        'as { name, factory }; a wrong shape is ignored silently.',
    );
    this.name = 'GateNotRegisteredError';
  }
}

export function createGate(opts: GateOptions) {
  let registered = false;
  const poll = opts.pollMs ?? 250;

  const factory: ExtensionFactory = (pi) => {
    registered = true;

    pi.on('tool_call', async (event: { toolName?: string; input?: unknown }) => {
      const toolName = event.toolName ?? 'unknown';
      const args = event.input ?? {};
      opts.hooks.onCall?.(toolName, args);

      // 'full' bypasses the gate outright rather than going through the policy
      // engine with a permissive rule. The engine refuses to be loosened by
      // design; bypassing it is a decision a person makes in settings, and it
      // stays visible in the step log because onCall already recorded the call.
      if (opts.mode() === 'full') return undefined;

      // A shell command's risk is in its text, not in the tool's name: `ls` and
      // `rm -rf` arrive through the same tool.
      const risk =
        toolName === 'bash' || toolName === 'powershell'
          ? classifyBash(String((args as Record<string, unknown>).command ?? ''))
          : riskOf(toolName);

      const verdict = evaluate(
        toolName, risk,
        [...(opts.teamRules ?? DEFAULT_TEAM_RULES), ...rulesForMode(opts.mode())],
        opts.memberRules,
      );
      if (verdict.decision === 'allow') return undefined;

      const runId = opts.runId();
      if (!runId) {
        return { block: true, reason: 'There is no active run to attach an approval to.' };
      }

      const approval = store.createApproval({
        runId,
        botId: opts.botId,
        tool: toolName,
        args: JSON.stringify(args),
        reason:
          typeof (args as Record<string, unknown>).why === 'string'
            ? String((args as Record<string, unknown>).why)
            : verdict.reason,
        risk,
      });
      opts.hooks.onPark(approval.id);

      // Wait for a human. No timeout by design: a pending approval is a question
      // that stays open until answered or the run is stopped. The time is
      // reported so the turn's own budget does not count it as a stall.
      const waitStart = Date.now();
      let reported = 0;
      /*
       * Reported as it accrues, not once at the end.
       *
       * The turn's budget is checked on its own timer, so a decision that takes
       * longer than the whole budget would trip the ceiling before the refund
       * ever arrived — the turn would die while the question was still on
       * screen. Each call reports only the time since the last one.
       */
      const report = () => {
        const total = Date.now() - waitStart;
        opts.hooks.onWaited?.(total - reported);
        reported = total;
      };
      for (;;) {
        if (opts.signal?.aborted) {
          store.settleApproval(approval.id);
          report();
          return { block: true, reason: 'The run was stopped before this was approved.' };
        }
        const fresh = store.getApproval(approval.id);
        if (fresh?.resolvedAt != null) {
          const approved = fresh.approved === 1;
          store.settleApproval(approval.id);
          report();
          opts.hooks.onDecide?.(approval.id, approved);
          return approved
            ? undefined
            : {
                block: true,
                reason:
                  'The user denied this action. Do not retry it; say what you would ' +
                  'need instead, or ask what to do.',
              };
        }
        await new Promise((r) => setTimeout(r, poll));
        report();
      }
    });
  };

  return {
    extension: { name: 'approval-gate', factory },
    /** Throws unless PI actually called the factory. */
    assertRegistered(): void {
      if (!registered) throw new GateNotRegisteredError();
    },
  };
}
