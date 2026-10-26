import type { Bot, Group } from '../protocol.ts';
import { store } from '../agent/store.ts';

/**
 * Who speaks next in a group.
 *
 * Three cases, matching how people actually write in a group:
 *
 *   @Name      — that bot answers
 *   @everyone  — all of them answer, in order
 *   no @       — the bots decide, which here means the one whose job fits best
 *
 * The third case is the interesting one. Asking every bot and letting each
 * decide whether to speak costs a model call per member and produces a wall of
 * "not me" — so instead one cheap routing call picks the member whose job
 * matches, and only that bot runs.
 */

export const MAX_GROUP_HOPS = 6;

export interface Mention {
  /** Bots explicitly addressed. Empty when nobody was. */
  targets: Bot[];
  everyone: boolean;
  /** True when the text named something that is not a member. */
  unknown: string[];
}

/**
 * Finds @mentions in a message.
 *
 * Longest name first, so "@审核员" is not matched as "@审核" when both exist.
 * Names can contain spaces and CJK, so this cannot be a word-boundary regex.
 */
export function parseMentions(text: string, members: Bot[]): Mention {
  const everyone = /@(everyone|所有人|全体)/i.test(text);
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);

  const targets: Bot[] = [];
  let rest = text;
  for (const bot of byLength) {
    const at = `@${bot.name}`;
    if (rest.includes(at)) {
      targets.push(bot);
      rest = rest.split(at).join(' ');
    }
  }

  // Anything left that looks like a mention names a non-member.
  const unknown = [...rest.matchAll(/@([^\s@,，。:：]{1,24})/g)]
    .map((m) => m[1]!)
    .filter((n) => !/^(everyone|所有人|全体)$/i.test(n));

  return { targets, everyone, unknown };
}

/** The transcript a bot is shown when it speaks in a group. */
export function renderTranscript(group: Group, members: Bot[], limit = 40): string {
  const names = new Map(members.map((b) => [b.id, b.name]));
  const lines = store.groupMessages(group.id, limit).map((m) => {
    const who = m.botId ? (names.get(m.botId) ?? 'another bot') : '用户';
    return `${who}: ${m.body}`;
  });
  return lines.join('\n');
}

/**
 * The prompt for one bot's turn in a group.
 *
 * It carries the whole visible conversation because a group member has no
 * private thread with the person — what it knows is what the group saw.
 */
export function groupPrompt(
  group: Group, members: Bot[], speaker: Bot, hops: number,
): string {
  const others = members.filter((b) => b.id !== speaker.id);
  return [
    `You are in a group chat called "${group.name}" with the user and ${others.length} other bot(s).`,
    ``,
    `The others:`,
    ...others.map((b) => `  @${b.name} — ${b.job}`),
    ``,
    `The conversation so far:`,
    renderTranscript(group, members),
    ``,
    `Reply as yourself, to the group. Keep it short: everyone reads every line.`,
    `To hand the next step to one of the others, mention them with @ and say what`,
    `you need from them. Mention one, not several — parallel handoffs produce`,
    `duplicate work. Do not mention anyone if the work is yours or it is finished.`,
    hops >= MAX_GROUP_HOPS - 2
      ? `\nThis has already gone back and forth ${hops} times. Finish it or hand it to the user.`
      : '',
  ].join('\n');
}

/**
 * Picks the member best suited to an unaddressed message.
 *
 * Returns null when nothing fits, which the caller surfaces rather than guessing
 * — a group where the wrong bot answers is worse than one that asks who should.
 */
export async function routeToMember(
  text: string, members: Bot[], ask: (prompt: string) => Promise<string>,
): Promise<Bot | null> {
  if (members.length === 1) return members[0]!;

  const menu = members.map((b, i) => `${i + 1}. ${b.name} — ${b.job}`).join('\n');
  const prompt = [
    `A message arrived in a group chat. Which member should answer it?`,
    ``,
    `Members:`,
    menu,
    ``,
    `Message: ${text}`,
    ``,
    `Reply with the number alone, or 0 if none of them fits.`,
  ].join('\n');

  const answer = await ask(prompt);
  const n = Number((answer.match(/\d+/) ?? ['0'])[0]);
  if (!n || n > members.length) return null;
  return members[n - 1]!;
}

export interface Turn {
  bot: Bot;
  /** What the bot is being asked, when it was handed the turn by another bot. */
  handedBy?: Bot;
}

/** Decides who answers a message, given the mentions in it. */
export function planTurns(mention: Mention, members: Bot[]): Turn[] {
  if (mention.everyone) return members.map((bot) => ({ bot }));
  return mention.targets.map((bot) => ({ bot }));
}
