import type { RiskLevel } from '../protocol.ts';
import { store } from '../agent/store.ts';
import type { Tool, ToolContext } from '../agent/tools.ts';

/**
 * Offering someone a choice.
 *
 * A model asked to narrow things down writes "A) … B) … C) …" into its reply,
 * which leaves the person retyping an answer the model already enumerated. This
 * turns that into a structured question the UI can render as buttons, so the
 * reply is one tap.
 *
 * It is a read: nothing happens until the person picks, and what they pick
 * arrives as an ordinary message.
 */

export const MAX_CHOICES = 6;

export interface PendingQuestion {
  question: string;
  options: string[];
}

/** Questions waiting on an answer, keyed by bot. One at a time. */
const open = new Map<string, PendingQuestion>();

export function pendingQuestion(botId: string): PendingQuestion | undefined {
  return open.get(botId);
}

export function clearQuestion(botId: string): void {
  open.delete(botId);
}

export function askTool(ctx: ToolContext, onAsk: (q: PendingQuestion) => void): Tool {
  return {
    risk: 'read' as RiskLevel,
    schema: {
      name: 'ask_choice',
      description:
        'Ask the user a question with a short list of answers to pick from, shown ' +
        'as buttons. Use it when you need one decision to get started and the ' +
        'plausible answers are few — what to work on first, which of two ' +
        'approaches, which file. Do not use it for anything you can decide ' +
        'yourself, and do not use it to confirm an action: a tool that needs ' +
        'approval already asks. After calling it, stop and wait; the answer ' +
        'arrives as the next message.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One short question.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description:
              `Two to ${MAX_CHOICES} answers, each a few words. Make the last one ` +
              'an escape hatch when the list might not cover it.',
          },
        },
        required: ['question', 'options'],
      },
    },

    async run(input) {
      const question = String(input.question ?? '').trim();
      const options = Array.isArray(input.options)
        ? input.options.map((o) => String(o).trim()).filter(Boolean)
        : [];

      if (!question) throw new Error('"question" is required');
      if (options.length < 2) {
        return 'A choice needs at least two options. Ask in your reply instead.';
      }

      const trimmed = options.slice(0, MAX_CHOICES);
      const q: PendingQuestion = { question, options: trimmed };
      open.set(ctx.botId, q);

      // Recorded as a step so it survives a reload and shows up in history.
      const runId = store.listRuns(ctx.botId)[0]?.id;
      if (runId) store.appendStep(runId, 'note', `ask_choice ${JSON.stringify(q)}`);
      onAsk(q);

      return (
        `Asked the user: "${question}" with ${trimmed.length} options. ` +
        'Stop here and wait — their answer comes as the next message.'
      );
    },
  };
}
