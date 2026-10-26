import type { PendingApproval, Run, Step } from '../protocol.ts';
import { store } from '../agent/store.ts';
import { dropSession, sessionFor } from '../pi/runner.ts';
import { getSandbox, type Sandbox } from '../sandbox/index.ts';

/**
 * Eval harness.
 *
 * PI owns the loop now, so a case can no longer script what the model says.
 * What remains testable is what actually happened — which is the part worth
 * testing anyway: did the tool run, was approval asked for, was a denial
 * respected, did the work land in the sandbox rather than on the host.
 *
 * Every case needs a real model, so the whole suite skips without ADA_TOKEN.
 */

export type Decide = 'approve' | 'deny' | 'ignore';

export interface EvalContext {
  botId: string;
  runId: string;
  sandbox: Sandbox;
  steps(): Step[];
  run(): Run;
  approvals(): PendingApproval[];
  /** Tool names the model actually got results back from. */
  toolsRun(): string[];
  /** Tool names that were proposed, whether or not they ran. */
  toolsProposed(): string[];
  /** Everything the bot said, joined. */
  said(): string;
  /** Shell in the sandbox, for checking side effects. */
  sh(cmd: string): Promise<string>;
}

export interface EvalCase {
  name: string;
  /** Why this case exists. Printed on failure. */
  rationale: string;
  job?: string;
  /** Files to place in the sandbox first. */
  setup?: (ctx: { sandbox: Sandbox }) => Promise<void>;
  prompt: string;
  /** What to do with approvals while the run is live. Default: deny. */
  decide?: Decide;
  expect: (ctx: EvalContext) => void | Promise<void>;
}

export interface EvalResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

const OWNER = 'evals';

export async function runCase(c: EvalCase): Promise<EvalResult> {
  if (!process.env.ADA_TOKEN) return { name: c.name, status: 'skip', detail: 'needs ADA_TOKEN' };

  const bot = store.createBot(OWNER, 'Eval', c.job ?? 'do what the user asks');
  const sandbox = await getSandbox(OWNER, null);
  const seenApprovals: PendingApproval[] = [];

  try {
    await c.setup?.({ sandbox });

    const run = store.createRun(bot.id);
    const session = await sessionFor(bot);

    // Answer approvals the way the case asks, recording each one.
    const mode = c.decide ?? 'deny';
    let parked = false;
    const watcher = setInterval(() => {
      for (const a of store.openApprovals(OWNER)) {
        if (!seenApprovals.some((s) => s.id === a.id)) seenApprovals.push(a);
        parked = true;
        if (mode === 'approve') store.resolveApproval(a.id, true);
        else if (mode === 'deny') store.resolveApproval(a.id, false);
      }
    }, 200);

    const task = session.prompt(c.prompt, run.id, () => {});

    if (mode === 'ignore') {
      // An unanswered approval is meant to wait forever — that is the gate
      // working. Observe that it parked, then release the run so the case can
      // finish; leaving it hanging would just stall the suite.
      for (let i = 0; i < 400 && !parked; i++) await new Promise((r) => setTimeout(r, 250));
      clearInterval(watcher);
      for (const a of store.openApprovals(OWNER)) store.resolveApproval(a.id, false);
      await task;
    } else {
      try {
        await task;
      } finally {
        clearInterval(watcher);
      }
    }

    const steps = () => store.listSteps(run.id);
    const ctx: EvalContext = {
      botId: bot.id,
      runId: run.id,
      sandbox,
      steps,
      run: () => store.getRun(run.id)!,
      approvals: () => seenApprovals,
      toolsRun: () =>
        steps().filter((s) => s.kind === 'tool_result' && s.tool).map((s) => s.tool!),
      toolsProposed: () =>
        steps().filter((s) => s.kind === 'tool_call' && s.tool).map((s) => s.tool!),
      said: () => steps().filter((s) => s.kind === 'assistant_text').map((s) => s.body).join('\n'),
      sh: async (cmd) => (await sandbox.exec(cmd)).stdout,
    };

    await c.expect(ctx);
    return { name: c.name, status: 'pass' };
  } catch (e) {
    return {
      name: c.name,
      status: 'fail',
      detail: `${e instanceof Error ? e.message : String(e)}\n       why this matters: ${c.rationale}`,
    };
  } finally {
    await dropSession(bot.id).catch(() => {});
  }
}
