import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';

/**
 * Per-bot conversation transcripts, on disk.
 *
 * These were in memory, which meant a bot forgot everything the moment the
 * orchestrator restarted: the step log still showed the conversation, but the
 * model could not answer a question about it. For something presented as a
 * persistent teammate that is the wrong default.
 *
 * One file per bot, named by its id, next to the database — so dev and a
 * packaged app keep their own, and a bot's history travels with the state
 * directory rather than with pi's global session folder.
 */

/** Where transcripts live, derived from wherever the database is. */
export function sessionDir(): string {
  const db = process.env.DB_PATH ?? './data/app.db';
  return path.join(path.dirname(path.resolve(db)), 'sessions');
}

/**
 * Pi names a session file <timestamp>_<id>.jsonl, so the bot id is a suffix
 * rather than a prefix, and a bot accumulates one file per session it starts.
 * Everything here therefore matches on the id appearing in the name.
 */
function filesFor(botId: string): string[] {
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.includes(botId))
    .map((n) => path.join(dir, n));
}

/** The most recent transcript for a bot, if it has one. */
function latestFor(botId: string): string | null {
  const files = filesFor(botId)
    .filter((f) => f.endsWith('.jsonl'))
    .sort(); // the timestamp prefix sorts chronologically
  return files.at(-1) ?? null;
}

/**
 * Opens a bot's transcript, creating it the first time.
 *
 * A corrupt or unreadable file is moved aside rather than thrown: losing the
 * model's memory of past turns is recoverable (the step log is still there),
 * while refusing to start the bot at all is not.
 */
export function sessionFor(botId: string, cwd: string): SessionManager {
  const dir = sessionDir();
  mkdirSync(dir, { recursive: true });

  const file = latestFor(botId);
  if (file) {
    try {
      return SessionManager.open(file, dir, cwd);
    } catch (e) {
      const broken = `${file}.broken-${Date.now()}`;
      try {
        // Keep it for inspection rather than deleting outright.
        renameSync(file, broken);
      } catch { /* fall through to a fresh session */ }
      console.error(
        `[sessions] could not read ${path.basename(file)} ` +
          `(${e instanceof Error ? e.message : e}); started a new transcript, ` +
          `moved the old one to ${path.basename(broken)}`,
      );
    }
  }

  // The id ties the session to the bot, so reopening finds the same file.
  return SessionManager.create(cwd, dir, { id: botId });
}

/** Removes every transcript belonging to a bot. */
export function forgetSession(botId: string): void {
  for (const f of filesFor(botId)) rmSync(f, { force: true, recursive: true });
}

export function sessionExists(botId: string): boolean {
  return latestFor(botId) !== null;
}

/** How many transcripts a bot has accumulated, for the tests. */
export function sessionCount(botId: string): number {
  return filesFor(botId).filter((f) => f.endsWith('.jsonl')).length;
}
