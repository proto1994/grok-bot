import { isDue, type Routine } from '../agent/routines.ts';
import { store } from '../agent/store.ts';

/**
 * Fires routines when they come due.
 *
 * A one-minute tick rather than a timer per routine: routines are added,
 * switched off and deleted while the process runs, and a single pass over the
 * list cannot drift out of step with the database.
 *
 * Two things it deliberately does not do. It does not catch up on routines
 * missed while the orchestrator was off — `isDue` only fires inside a window
 * after the scheduled time, so a laptop opened at noon does not set four jobs
 * running at once. And it does not queue behind a busy bot: a routine that
 * collides with live work is skipped and tried again tomorrow, because the
 * person is mid-conversation and a surprise second task is worse than a late
 * report.
 */

export interface SchedulerDeps {
  ownerId: string;
  startRun: (botId: string, text: string) => Promise<string>;
  isBusy: (botId: string) => boolean;
  onFired?: (routine: Routine, runId: string) => void;
}

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

export function startScheduler(deps: SchedulerDeps): () => void {
  if (timer) clearInterval(timer);
  // A tick on startup as well, so a routine due in the last few minutes still
  // runs rather than waiting for the next minute boundary.
  void tick(deps);
  timer = setInterval(() => void tick(deps), TICK_MS);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export async function tick(deps: SchedulerDeps, now = new Date()): Promise<Routine[]> {
  const fired: Routine[] = [];

  for (const routine of store.allRoutines(deps.ownerId)) {
    if (!isDue(routine, now)) continue;

    if (deps.isBusy(routine.botId)) {
      // Skipped rather than queued: the person is working with this bot now.
      continue;
    }

    const bot = store.getBot(routine.botId);
    if (!bot) continue;

    try {
      const runId = await deps.startRun(
        routine.botId,
        `[例行任务：${routine.title}]\n\n${routine.prompt}`,
      );
      store.markRoutineRun(routine.id, runId, now.getTime());
      fired.push(routine);
      deps.onFired?.(routine, runId);
    } catch (e) {
      console.error(`[scheduler] ${routine.title}:`, e instanceof Error ? e.message : e);
    }
  }

  return fired;
}
