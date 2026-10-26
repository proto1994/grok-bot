/**
 * Routines: work a bot does on a schedule, without being asked each time.
 *
 * The schedule is deliberately coarse — a time of day, and which days — rather
 * than cron. A bot that says "每天 10:45 左右" is describing something it will
 * get to, not an alarm; pretending to minute precision would be a promise the
 * rest of the system cannot keep, since a run waits on approvals and on the
 * model.
 */

export interface Routine {
  id: string;
  botId: string;
  /** What the person sees in the list. */
  title: string;
  /** The message handed to the bot when it fires. */
  prompt: string;
  /** Minutes after midnight, local time. */
  minuteOfDay: number;
  /** 0–6, Sunday first. Empty means every day. */
  days: number[];
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastRunId: string | null;
}

export const MAX_ROUTINES_PER_BOT = 12;

/** "9:00" / "21:45" / "0945" → minutes after midnight. */
export function parseTime(text: string): number | null {
  const m = /^\s*(\d{1,2})\s*[:：.]?\s*(\d{2})?\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function formatTime(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** "每天 9:00" / "周一、周三 18:30" */
export function describe(r: Pick<Routine, 'minuteOfDay' | 'days'>): string {
  const time = formatTime(r.minuteOfDay);
  if (!r.days.length || r.days.length === 7) return `每天 ${time}`;
  if (r.days.length === 5 && [1, 2, 3, 4, 5].every((d) => r.days.includes(d))) {
    return `工作日 ${time}`;
  }
  if (r.days.length === 2 && r.days.includes(0) && r.days.includes(6)) {
    return `周末 ${time}`;
  }
  // "周一、周三", not "周一、三": the 周 repeats the way it is spoken.
  return `${r.days.map((d) => `周${DAY_NAMES[d]}`).join('、')} ${time}`;
}

/**
 * Normalises whatever the model supplied for days.
 *
 * Accepts numbers, "每天", "工作日", "周一" and English names, because a model
 * writing for a Chinese UI mixes them. Anything unrecognised means every day,
 * which is the safe reading of "regularly".
 */
export function parseDays(input: unknown): number[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    const out = input
      .map((d) => (typeof d === 'number' ? d : parseDayName(String(d))))
      .filter((d): d is number => d !== null && d >= 0 && d <= 6);
    return [...new Set(out)].sort();
  }

  const text = String(input).trim();
  if (!text || /每天|daily|every ?day/i.test(text)) return [];
  if (/工作日|weekday/i.test(text)) return [1, 2, 3, 4, 5];
  if (/周末|weekend/i.test(text)) return [0, 6];

  const out: number[] = [];
  for (const part of text.split(/[,，、\s]+/)) {
    const d = parseDayName(part);
    if (d !== null) out.push(d);
  }
  return [...new Set(out)].sort();
}

function parseDayName(part: string): number | null {
  const s = part.trim().toLowerCase();
  if (!s) return null;
  const cn = /^(周|星期|每周)?([日一二三四五六天])$/.exec(s);
  if (cn) {
    const map: Record<string, number> = {
      日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
    };
    return map[cn[2]!] ?? null;
  }
  const en = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const i = en.findIndex((n) => s.startsWith(n));
  if (i >= 0) return i;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

/**
 * Should this routine run now?
 *
 * `now` and `lastRunAt` are both absolute times, so a routine that was missed
 * while the orchestrator was off does not fire a burst on startup: it runs once
 * if its window is still open today, and otherwise waits for tomorrow.
 */
export function isDue(r: Routine, now: Date, graceMinutes = 30): boolean {
  if (!r.enabled) return false;
  if (r.days.length && !r.days.includes(now.getDay())) return false;

  const minuteNow = now.getHours() * 60 + now.getMinutes();
  if (minuteNow < r.minuteOfDay) return false;
  if (minuteNow > r.minuteOfDay + graceMinutes) return false;

  if (r.lastRunAt) {
    const last = new Date(r.lastRunAt);
    const sameDay =
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate();
    if (sameDay) return false;
  }
  return true;
}
