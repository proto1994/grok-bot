import type { RiskLevel } from '../protocol.ts';
import { store } from '../agent/store.ts';
import {
  describe, MAX_ROUTINES_PER_BOT, parseDays, parseTime,
} from '../agent/routines.ts';
import type { Tool, ToolContext } from '../agent/tools.ts';

/**
 * Letting a bot put recurring work on a schedule.
 *
 * This is the tool behind "把每天的发帖和复盘排成固定日程" — the bot turns that
 * into named routines the person can see and switch off, instead of promising to
 * remember and then only acting when spoken to.
 *
 * Creating one is a write: it commits the bot to acting unprompted, and those
 * runs spend money and touch real systems. So it goes through the approval gate
 * like any other change, and the list it creates is visible and reversible.
 */

export function scheduleTool(ctx: ToolContext, onChange: () => void): Tool {
  return {
    risk: 'write' as RiskLevel,
    schema: {
      name: 'schedule_routine',
      description:
        'Put a recurring job on your own schedule — either because the user ' +
        'asked for something regular, or because your job implies it and nobody ' +
        'should have to ask. Check list_routines first and do not duplicate one. ' +
        'The prompt you give is what you will be handed when it fires, with none ' +
        'of the current conversation, so write it to stand alone and say what ' +
        'finished looks like. One routine per job; say what you scheduled, and ' +
        'why, in your reply.',
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'A short name the user will see in a list, e.g. 每日数据复盘.',
          },
          prompt: {
            type: 'string',
            description:
              'The instruction to hand yourself when it fires. Self-contained: ' +
              'it arrives with no conversation around it.',
          },
          time: { type: 'string', description: 'Time of day, 24-hour, e.g. "9:00" or "16:45".' },
          days: {
            type: 'string',
            description:
              'When to run: "每天", "工作日", "周末", or a list like "周一、周三". ' +
              'Omit for every day.',
          },
          why: { type: 'string', description: 'One line for the approval prompt.' },
        },
        required: ['title', 'prompt', 'time'],
      },
    },

    async run(input) {
      const title = String(input.title ?? '').trim();
      const prompt = String(input.prompt ?? '').trim();
      if (!title) throw new Error('"title" is required');
      if (!prompt) throw new Error('"prompt" is required');

      const minuteOfDay = parseTime(String(input.time ?? ''));
      if (minuteOfDay === null) {
        return `Could not read "${input.time}" as a time of day. Use something like 9:00 or 16:45.`;
      }

      const existing = store.listRoutines(ctx.botId);
      if (existing.length >= MAX_ROUTINES_PER_BOT) {
        return (
          `This bot already has ${existing.length} routines, which is the limit. ` +
          'Remove one first, or fold this into an existing routine.'
        );
      }

      const days = parseDays(input.days);
      const clash = existing.find(
        (r) => r.minuteOfDay === minuteOfDay && r.days.join() === days.join(),
      );
      if (clash) {
        return (
          `"${clash.title}" already runs at the same time (${describe(clash)}). ` +
          'Two routines at once would have them queue behind each other; pick a ' +
          'different time or extend that one.'
        );
      }

      const routine = store.createRoutine(ctx.botId, { title, prompt, minuteOfDay, days });
      onChange();
      return `Scheduled "${title}" — ${describe(routine)}. The user can switch it off in your settings.`;
    },
  };
}

/** Lets a bot see and reason about what it has already scheduled. */
export function listRoutinesTool(ctx: ToolContext): Tool {
  return {
    risk: 'read' as RiskLevel,
    schema: {
      name: 'list_routines',
      description: 'List the recurring jobs you already have scheduled.',
      input_schema: { type: 'object', properties: {} },
    },
    async run() {
      const rs = store.listRoutines(ctx.botId);
      if (!rs.length) return 'You have no routines scheduled.';
      return rs
        .map((r) => `- ${r.title} — ${describe(r)}${r.enabled ? '' : ' (switched off)'}`)
        .join('\n');
    },
  };
}
