import { store } from '../agent/store.ts';
import type { Bot, Group } from '../protocol.ts';
import { describeChain, type HandoffChain } from '../pi/handoff.ts';
import {
  groupPrompt, MAX_GROUP_HOPS, parseMentions, planTurns, routeToMember,
} from './group.ts';
import { dropSession, sessionFor, setHandoffDeps } from '../pi/runner.ts';

type Emit = (e: unknown) => void;

/**
 * Run lifecycle on top of PI.
 *
 * PI owns the agent loop, so this is only bookkeeping: one in-flight prompt per
 * bot, and a record of what happened.
 *
 * Approvals do not come back through here. The gate extension is already
 * awaiting inside PI's tool_call handler and polls the store for a decision, so
 * resolving an approval needs no further nudge — unlike the previous loop,
 * which had to be re-driven.
 */

const inFlight = new Map<string, Promise<void>>();

/**
 * Pushes an event to connected clients.
 *
 * A handoff happens outside any request, so there is no per-request emit to
 * thread through. The server registers the real one at startup; until then
 * events are dropped rather than queued.
 */
let broadcast: Emit = () => {};
export function setBroadcast(fn: Emit): void {
  broadcast = fn;
}

/**
 * Delivering one bot's request to another.
 *
 * The receiving bot gets its own run, so its work shows up in its own
 * conversation and under its own permissions — the asking bot cannot borrow
 * them. The caller awaits the reply, which means a handoff to a bot that stops
 * for approval waits for that person, by design.
 */
/**
 * Delivering one bot's request to another.
 *
 * Asynchronous: message_bot returns as soon as the request is queued, and the
 * reply arrives later as a new turn on the asking bot. Waiting for the reply
 * inline looked simpler, but it hung the asking bot for as long as the receiver
 * sat on an approval — the case where a handoff is most useful is exactly the
 * one where the other side takes a while.
 *
 * The receiving bot gets its own run, so its work appears in its own
 * conversation and under its own permissions. Delegation never borrows the
 * asker's.
 */
setHandoffDeps({
  isBusy: (botId) => inFlight.has(botId),

  async deliver(toBotId, text, chain): Promise<string> {
    const target = store.getBot(toBotId);
    if (!target) return `There is no bot with id ${toBotId}.`;
    if (inFlight.has(toBotId)) return `${target.name} is already working on something.`;

    const from = chain.path.length >= 2 ? store.getBot(chain.path[chain.path.length - 2]!) : null;
    const run = store.createRun(target.id);

    // Visible on the receiving side: who asked, and through which chain.
    store.appendStep(
      run.id, 'note',
      `Request from ${from?.name ?? 'another bot'} (${describeChain(chain)})`,
    );
    store.appendStep(run.id, 'user_message', text);

    const task = (async () => {
      try {
        const session = await sessionFor(target);
        await session.prompt(text, run.id, broadcast, chain);
        const reply = session.lastReply().trim();
        if (from) await returnReply(from.id, target.name, reply, chain);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        store.appendStep(run.id, 'note', `handoff failed: ${msg}`);
        store.updateRun(run.id, { status: 'failed', endedAt: Date.now(), error: msg });
        if (from) {
          await returnReply(from.id, target.name, `I could not do it: ${msg}`, chain);
        }
      } finally {
        inFlight.delete(toBotId);
      }
    })();

    inFlight.set(toBotId, task.then(() => {}, () => {}));

    return (
      `Sent to ${target.name}. It is working on this now and its reply will reach ` +
      `you as a new message; you do not need to wait. Carry on with anything that ` +
      `does not depend on it, or tell the user you are waiting.`
    );
  },
});

/**
 * Hands a reply back to the bot that asked.
 *
 * The asker's original run has usually finished, so the reply is a new turn on
 * it. The chain is passed through unchanged and marked as a reply: a reply is
 * not another hop, but the path still has to be carried so a bot cannot answer
 * a reply by asking the same bot again and go round forever.
 */
async function returnReply(
  toBotId: string, fromName: string, reply: string, chain: HandoffChain,
): Promise<void> {
  // Wait for the asker to be free; it may still be finishing its own turn.
  for (let i = 0; i < 600 && inFlight.has(toBotId); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (inFlight.has(toBotId)) return; // still busy after 5 minutes: drop it rather than queue

  const asker = store.getBot(toBotId);
  if (!asker) return;

  const run = store.createRun(asker.id);
  const text = `${fromName} replied:\n\n${reply || '(it finished without saying anything)'}`;
  store.appendStep(run.id, 'note', `Reply from ${fromName}`);
  store.appendStep(run.id, 'user_message', text);

  const task = (async () => {
    try {
      const session = await sessionFor(asker);
      await session.prompt(text, run.id, broadcast, { ...chain, isReply: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.updateRun(run.id, { status: 'failed', endedAt: Date.now(), error: msg });
    } finally {
      inFlight.delete(asker.id);
    }
  })();
  inFlight.set(asker.id, task.then(() => {}, () => {}));
}
export function isBusy(botId: string): boolean {
  return inFlight.has(botId);
}

export async function startRun(botId: string, text: string, emit: Emit): Promise<string> {
  const bot = store.getBot(botId);
  if (!bot) throw new Error(`no such bot: ${botId}`);

  /*
   * A message that arrives mid-turn waits for the turn rather than being
   * refused. Someone who adds "actually, skip the second file" a second late
   * means it, and dropping it to protect a queue of one is the wrong trade.
   *
   * Pi handles the overlap itself (streamingBehavior: 'followUp'); what has to
   * be serialised here is the bookkeeping, so each message still gets its own
   * run and the order on screen matches the order typed.
   */
  const pending = inFlight.get(botId);
  if (pending) await pending.catch(() => {});

  const run = store.createRun(bot.id);
  // botId travels with the event: the page shows one bot's conversation, and
  // routines and handoffs produce runs it never started.
  emit({ type: 'step.appended', botId: bot.id, step: store.appendStep(run.id, 'user_message', text) });
  emit({ type: 'run.updated', run });

  const task = (async () => {
    try {
      const session = await sessionFor(bot);
      await session.prompt(text, run.id, emit);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit({ type: 'step.appended', botId: bot.id, step: store.appendStep(run.id, 'note', `run failed: ${msg}`) });
      emit({
        type: 'run.updated',
        run: store.updateRun(run.id, { status: 'failed', endedAt: Date.now(), error: msg }),
      });
    } finally {
      inFlight.delete(botId);
    }
  })();

  inFlight.set(botId, task);
  return run.id;
}

/** Stops a run: aborts the PI session and clears anything parked on approval. */
export async function stopRun(runId: string, emit: Emit): Promise<void> {
  const run = store.getRun(runId);
  if (!run) throw new Error(`no such run: ${runId}`);

  // Deny whatever is parked so the gate's handler stops waiting.
  for (const a of store.pendingApprovals(runId)) {
    if (a.resolvedAt === null) store.resolveApproval(a.id, false);
  }

  const updated = store.updateRun(runId, { status: 'stopped', endedAt: Date.now() });
  emit({ type: 'run.updated', run: updated });

  // The session holds conversation state, so dropping it is the price of a hard
  // stop. A fresh one starts on the next message.
  await dropSession(run.botId);
  inFlight.delete(run.botId);
}

/**
 * Marks runs that were in flight when the process died.
 *
 * The transcript survives now, so the bot still remembers the conversation —
 * but the turn itself was interrupted part-way, and resuming a half-finished
 * tool sequence is not something to guess at. The run is closed and the person
 * is told to send it again; the context for doing so is intact.
 */
export function reconcileOnBoot(emit: Emit): number {
  const stale = store.resumableRuns();
  for (const r of stale) {
    store.appendStep(
      r.id, 'note',
      '服务重启时这次任务正在进行，已经结束掉了。对话记录和它记住的上下文都还在，' +
        '直接再说一次就能接着做。',
    );
    emit({
      type: 'run.updated',
      run: store.updateRun(r.id, {
        status: 'failed', endedAt: Date.now(),
        error: 'orchestrator restarted mid-run; the transcript survived but the turn did not',
      }),
    });
  }
  return stale.length;
}

/* ---------- group chats ---------- */

/**
 * Runs a group conversation forward.
 *
 * One bot speaks at a time. If its reply mentions another member, that member
 * takes the next turn — which is how a group gets work done without the person
 * routing every step, and also how it could go round forever. Three things stop
 * that: a hop count, refusing to re-hand to a bot already in this exchange, and
 * telling the model its remaining budget as it approaches the limit.
 */
const groupsRunning = new Set<string>();

export function isGroupBusy(groupId: string): boolean {
  return groupsRunning.has(groupId);
}

async function speak(
  group: Group, members: Bot[], speaker: Bot, hops: number,
): Promise<string> {
  const run = store.createRun(speaker.id);
  store.appendStep(run.id, 'note', `Group "${group.name}" — its turn to speak`);

  broadcast({ type: 'group.thinking', groupId: group.id, botId: speaker.id });

  const session = await sessionFor(speaker);
  const task = (async () => {
    await session.prompt(
      groupPrompt(group, members, speaker, hops), run.id, broadcast, undefined,
      { inGroup: true },
    );
  })();
  inFlight.set(speaker.id, task.then(() => {}, () => {}));
  try {
    await task;
  } finally {
    inFlight.delete(speaker.id);
  }

  const said = session.lastReply().trim() || '(没有回应)';
  const message = store.addGroupMessage(group.id, speaker.id, said, run.id);
  broadcast({ type: 'group.message', message, authorName: speaker.name });
  return said;
}

export async function sendToGroup(
  ownerId: string, groupId: string, text: string,
): Promise<void> {
  const group = store.getGroup(ownerId, groupId);
  if (!group) throw new Error('no such group');
  if (groupsRunning.has(groupId)) throw new Error('这个群里已经有 Bot 在说话了，等它说完');

  const members = store.groupMembers(groupId);
  if (!members.length) throw new Error('这个群里没有 Bot 了');

  groupsRunning.add(groupId);
  try {
    const first = store.addGroupMessage(groupId, null, text, null);
    broadcast({ type: 'group.message', message: first, authorName: '用户' });

    const mention = parseMentions(text, members);
    if (mention.unknown.length) {
      const note = store.addGroupMessage(
        groupId, null,
        `（群里没有 @${mention.unknown[0]}。成员：${members.map((b) => b.name).join('、')}）`,
      );
      broadcast({ type: 'group.message', message: note, authorName: '系统' });
    }

    let queue = planTurns(mention, members);

    // Nobody was addressed: pick the member whose job fits.
    if (!queue.length) {
      const picked = await routeToMember(text, members, async (prompt) => {
        // A throwaway bot would pollute the roster, so route through the first
        // member's session; the question is about the message, not about it.
        const router = await sessionFor(members[0]!);
        const run = store.createRun(members[0]!.id);
        store.appendStep(run.id, 'note', `Group "${group.name}" — deciding who should answer`);
        await router.prompt(prompt, run.id, () => {}, undefined, { inGroup: true });
        return router.lastReply();
      });

      if (!picked) {
        const note = store.addGroupMessage(
          groupId, null,
          `（不确定该谁回答。用 @ 指定一个：${members.map((b) => b.name).join('、')}）`,
        );
        broadcast({ type: 'group.message', message: note, authorName: '系统' });
        return;
      }
      queue = [{ bot: picked }];
    }

    /*
     * Turns taken per bot, not a set of who has spoken.
     *
     * Treating any repeat speaker as a loop broke the ordinary case: in a pair,
     * "A asks B, B answers A, A finishes the job" is the whole point, and
     * blocking A's second turn stopped the work one step from done. A real loop
     * is repetition, so the limit is per bot and the overall hop count bounds
     * the rest.
     */
    const turnsTaken = new Map<string, number>();
    const MAX_TURNS_EACH = 3;
    let hops = 0;

    while (queue.length && hops < MAX_GROUP_HOPS) {
      const turn = queue.shift()!;
      hops++;

      turnsTaken.set(turn.bot.id, (turnsTaken.get(turn.bot.id) ?? 0) + 1);
      const said = await speak(group, members, turn.bot, hops);

      // A mention in the reply hands over the next turn.
      const next = parseMentions(said, members);
      const candidate = next.targets.find((b) => b.id !== turn.bot.id);
      if (!candidate) continue;

      if ((turnsTaken.get(candidate.id) ?? 0) >= MAX_TURNS_EACH) {
        const note = store.addGroupMessage(
          groupId, null,
          `（${candidate.name} 已经说过 ${MAX_TURNS_EACH} 轮，停下来避免绕圈。` +
            `需要继续的话你来指定下一步。）`,
        );
        broadcast({ type: 'group.message', message: note, authorName: '系统' });
        break;
      }
      queue.push({ bot: candidate, handedBy: turn.bot });
    }

    if (hops >= MAX_GROUP_HOPS) {
      const note = store.addGroupMessage(
        groupId, null,
        `（已经来回 ${hops} 轮，停下来等你。）`,
      );
      broadcast({ type: 'group.message', message: note, authorName: '系统' });
    }
  } finally {
    groupsRunning.delete(groupId);
  }
}
