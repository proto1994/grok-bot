import type { RiskLevel } from '../protocol.ts';
import { store } from '../agent/store.ts';
import type { Tool, ToolContext } from '../agent/tools.ts';

/**
 * Bot-to-bot messaging.
 *
 * One bot can hand work to another: the receiver wakes, does the work under its
 * own permissions, and replies. That is the useful shape — the bot that owns a
 * source system is rarely the one that owns the deliverable.
 *
 * It is also the first feature where a bot can cause another bot to spend money
 * and touch real systems without a person in the loop for that step. Four things
 * keep that bounded:
 *
 *  1. A chain. Every handoff carries the ids it has already passed through, so a
 *     cycle (A→B→A) is refused rather than discovered by watching the bill.
 *  2. A depth limit. Even an acyclic chain stops; a long one is a design mistake
 *     rather than something to serve.
 *  3. The receiver's own gate still applies. A bot in 'balanced' mode asks its
 *     owner before writing, whoever asked it to. Delegation is not a way to
 *     borrow someone else's permissions.
 *  4. One run per bot. A busy bot refuses rather than queueing, so a fan-out
 *     cannot quietly become a backlog.
 */

export const MAX_HOPS = 4;

export interface HandoffChain {
  /** Bot ids this request has already passed through, oldest first. */
  path: string[];
  /**
   * True when this turn is a reply coming back, not a fresh request.
   *
   * A reply is not another hop — otherwise an ordinary exchange would exhaust
   * the depth limit — but the path still travels with it, so answering a reply
   * by asking the same bot again is caught as a cycle.
   */
  isReply?: boolean;
}

export interface HandoffDeps {
  /** Starts a run on another bot and resolves when it settles. */
  deliver: (toBotId: string, text: string, chain: HandoffChain) => Promise<string>;
  /** True when that bot is already working. */
  isBusy: (botId: string) => boolean;
}

export function describeChain(chain: HandoffChain): string {
  const names = chain.path.map((id) => store.getBot(id)?.name ?? id.slice(0, 8));
  return names.join(' → ');
}

/** Why a handoff is refused, phrased for the model that asked. */
export function refuse(reason: string): string {
  return `Handoff refused: ${reason}`;
}

export function checkChain(chain: HandoffChain, toBotId: string): string | null {
  if (chain.path.includes(toBotId)) {
    const name = store.getBot(toBotId)?.name ?? toBotId;
    return refuse(
      `"${name}" is already in this chain (${describeChain(chain)}), so this would loop. ` +
        `Finish the work yourself, or report back to whoever asked.`,
    );
  }
  if (chain.path.length >= MAX_HOPS) {
    return refuse(
      `this request has already passed through ${chain.path.length} bots ` +
        `(${describeChain(chain)}). Do the remaining work yourself or tell the user ` +
        `what is still needed.`,
    );
  }
  return null;
}

/**
 * The tool a bot uses to reach another bot.
 *
 * Risk is 'external': it leaves this bot's own sandbox and causes work
 * elsewhere, which is worth a decision even though nothing local changes.
 */
export function messageBotTool(
  ctx: ToolContext,
  /** Read at call time: the chain belongs to the prompt, not the session. */
  currentChain: () => HandoffChain,
  deps: HandoffDeps,
): Tool {
  return {
    risk: 'external' as RiskLevel,
    schema: {
      name: 'message_bot',
      description:
        'Send a request to another bot and wait for its reply. Use it when another ' +
        'bot owns the system or the context the task needs. Name one owner per ' +
        'stage: parallel handoffs produce duplicate work. The other bot works ' +
        'under its own permissions and may stop to ask its owner, so a reply can ' +
        'take a while. List the available bots with list_bots first.',
      input_schema: {
        type: 'object',
        properties: {
          bot: { type: 'string', description: 'The name of the bot to ask.' },
          request: {
            type: 'string',
            description:
              'What you need, with enough context to act on it alone, and what ' +
              'finished looks like. The other bot cannot see your conversation.',
          },
          why: { type: 'string', description: 'One line on why this needs another bot. Shown to the user.' },
        },
        required: ['bot', 'request'],
      },
    },

    async run(input) {
      const name = String(input.bot ?? '').trim();
      const request = String(input.request ?? '').trim();
      if (!name) throw new Error('"bot" is required');
      if (!request) throw new Error('"request" is required');

      const self = store.getBot(ctx.botId);
      if (!self) throw new Error('this bot no longer exists');

      const peers = store.listBots(self.ownerId).filter((b) => b.id !== self.id);
      const target =
        peers.find((b) => b.name === name) ??
        peers.find((b) => b.name.toLowerCase() === name.toLowerCase());

      if (!target) {
        return refuse(
          `there is no bot called "${name}". Available: ${peers.map((b) => b.name).join(', ') || '(none)'}`,
        );
      }

      const chain = currentChain();
      const problem = checkChain(chain, target.id);
      if (problem) return problem;

      if (deps.isBusy(target.id)) {
        return refuse(
          `"${target.name}" is already working on something. Wait and ask again, or ` +
            `do this part yourself.`,
        );
      }

      const next: HandoffChain = { path: [...chain.path, target.id] };
      const reply = await deps.deliver(target.id, request, next);
      return `${target.name} replied:\n\n${reply}`;
    },
  };
}

/** Lets a bot see who else it can reach, and what each one is for. */
export function listBotsTool(ctx: ToolContext): Tool {
  return {
    risk: 'read' as RiskLevel,
    schema: {
      name: 'list_bots',
      description:
        'List the other bots on this account, with the job each one is for. Use it ' +
        'before message_bot to pick the right one.',
      input_schema: { type: 'object', properties: {} },
    },

    async run() {
      const self = store.getBot(ctx.botId);
      if (!self) throw new Error('this bot no longer exists');
      const peers = store.listBots(self.ownerId).filter((b) => b.id !== self.id);
      if (!peers.length) return 'There are no other bots on this account.';
      return peers
        .map((b) => `- ${b.name}: ${b.job}${b.permissionMode === 'full' ? ' [runs unattended]' : ''}`)
        .join('\n');
    },
  };
}
