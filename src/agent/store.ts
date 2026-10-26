import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Bot, Group, GroupMessage, PendingApproval, PermissionMode, Run, RunStatus, Step, StepKind,
} from '../protocol.ts';
import type { Routine } from './routines.ts';

const DB_PATH = process.env.DB_PATH ?? './data/app.db';
mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, name TEXT NOT NULL,
  job TEXT NOT NULL, createdAt INTEGER NOT NULL,
  -- How much this bot may do without asking. NULL means the default.
  permissionMode TEXT,
  -- Appearance: a blob shape and a colour, both picked when the bot is made.
  -- NULL means fall back to one derived from the id, so older bots still get a
  -- stable look rather than a blank square.
  shape TEXT,
  color TEXT,
  -- Which sandbox target this bot's computer lives on. NULL means the default.
  -- Changing it moves the bot to a different machine: the workspace there is
  -- separate, so files and logins do not follow.
  sandboxTarget TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  status TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER,
  steps INTEGER NOT NULL DEFAULT 0,
  tokensIn INTEGER NOT NULL DEFAULT 0, tokensOut INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, kind TEXT NOT NULL, tool TEXT, body TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_run ON steps(runId, seq);

-- Raw provider transcript. Separate from steps: steps are the audit log shown to
-- people and kept, messages are what the model sees and may be compacted.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  runId TEXT, role TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_bot ON messages(botId, id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  botId TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
  reason TEXT NOT NULL, risk TEXT NOT NULL,
  createdAt INTEGER NOT NULL, resolvedAt INTEGER, approved INTEGER,
  -- set once the tool has run (or been refused) so a resumed loop is idempotent
  settled INTEGER NOT NULL DEFAULT 0
);

-- Execution journal, keyed by the provider's tool_use_id. Makes tool execution
-- exactly-once across restarts: a claim is written before the tool runs, so a
-- crash is distinguishable from a clean retry.
CREATE TABLE IF NOT EXISTS tool_executions (
  toolUseId TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  state TEXT NOT NULL,          -- 'started' | 'finished'
  result TEXT,
  isError INTEGER NOT NULL DEFAULT 0,
  startedAt INTEGER NOT NULL,
  finishedAt INTEGER
);

-- Routines: work a bot does on a schedule.
--
-- The schedule is a time of day plus which days, not cron: a run waits on the
-- model and sometimes on an approval, so minute precision would be a promise
-- this system cannot keep.
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  minuteOfDay INTEGER NOT NULL,
  -- A comma-separated list of 0-6, empty for every day.
  days TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  lastRunAt INTEGER,
  lastRunId TEXT
);
CREATE INDEX IF NOT EXISTS routines_bot ON routines(botId);

-- Group chats: several bots and one person in a shared conversation.
--
-- Separate from the steps table because a group transcript has a different
-- shape: every line has an author (a bot, or the person), and the whole group
-- reads the same stream. A bot's own run still records its tool calls as steps;
-- this table is what everyone in the group sees.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  -- Join order, which is the order @everyone speaks in. Sorting by the bots'
  -- own createdAt was unstable: several bots made in the same millisecond came
  -- back in an arbitrary order.
  seq INTEGER NOT NULL,
  PRIMARY KEY (groupId, botId)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- NULL means the person; otherwise the bot that said it.
  botId TEXT,
  body TEXT NOT NULL,
  -- The run this line came from, so the tool calls behind it are findable.
  runId TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS group_messages_group ON group_messages(groupId, id);

-- UNUSED SINCE PI TOOK OVER THE LOOP: messages, tool_executions, memories,
-- digests. Pi owns the transcript, tool execution, memory and compaction now,
-- so nothing writes to these four. They stay because older databases hold real
-- rows in them and the migration tests exercise them; read them as history, not
-- as live state.

-- NOTE: CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
-- so a column added to a definition above never reaches an older database.
-- Every such column must also be listed in MIGRATIONS below.

-- Running summary of messages that have fallen out of the context window.
-- Written once per compaction rather than regenerated per turn, so a long
-- conversation costs one extra model call occasionally, not one every turn.
CREATE TABLE IF NOT EXISTS digests (
  botId TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  throughId INTEGER NOT NULL,   -- the newest message id this covers
  updatedAt INTEGER NOT NULL
);

-- Durable per-bot memory. Stable preferences and facts, not a transcript.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  botId TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  text TEXT NOT NULL, createdAt INTEGER NOT NULL
);
`);

/**
 * Columns added after a table first shipped.
 *
 * The CREATE TABLE statements above only run on a fresh database, so a new
 * column has to be applied to existing ones too. Tests always start from an
 * empty file, which is exactly why this class of bug reaches a real database
 * first: keep this list in step with the definitions above.
 */
const MIGRATIONS: { table: string; column: string; decl: string }[] = [
  { table: 'bots', column: 'sandboxTarget', decl: 'TEXT' },
  { table: 'approvals', column: 'settled', decl: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'bots', column: 'permissionMode', decl: 'TEXT' },
  { table: 'bots', column: 'shape', decl: 'TEXT' },
  { table: 'bots', column: 'color', decl: 'TEXT' },
];

function migrate(): void {
  for (const m of MIGRATIONS) {
    const exists = db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`)
      .get(m.table, m.column);
    if (exists) continue;

    // A table missing entirely is fine: the CREATE above already made it with
    // the column included.
    const table = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(m.table);
    if (!table) continue;

    db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.decl}`);
    console.log(`[store] migrated ${m.table}.${m.column}`);
  }
}

migrate();

const now = () => Date.now();

export const store = {
  createBot(
    ownerId: string, name: string, job: string,
    sandboxTarget: string | null = null,
    permissionMode: PermissionMode = 'balanced',
    look: { shape?: string | null; color?: string | null } = {},
  ): Bot {
    const bot: Bot = {
      id: randomUUID(), ownerId, name, job, createdAt: now(), sandboxTarget, permissionMode,
      shape: look.shape ?? null, color: look.color ?? null,
    };
    db.prepare(`INSERT INTO bots (id,ownerId,name,job,createdAt,sandboxTarget,permissionMode,shape,color)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(
      bot.id, bot.ownerId, bot.name, bot.job, bot.createdAt, bot.sandboxTarget,
      bot.permissionMode, bot.shape, bot.color,
    );
    return bot;
  },

  /** Renames a bot or changes how it looks. */
  updateBot(
    ownerId: string, botId: string,
    patch: { name?: string; job?: string; shape?: string; color?: string },
  ): Bot | undefined {
    const bot = store.getBot(botId);
    if (!bot || bot.ownerId !== ownerId) return undefined;
    const keys = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
    if (!keys.length) return bot;
    db.prepare(`UPDATE bots SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`)
      .run(...keys.map((k) => patch[k as keyof typeof patch] as never), botId);
    return store.getBot(botId);
  },

  /** Changes how much a bot may do unattended. */
  setPermissionMode(botId: string, mode: PermissionMode): Bot | undefined {
    db.prepare('UPDATE bots SET permissionMode=? WHERE id=?').run(mode, botId);
    return store.getBot(botId);
  },

  /**
   * Deletes a bot and everything that belonged to it.
   *
   * Runs, steps, approvals and group membership go with it through the foreign
   * keys. The transcript on disk is the caller's to remove — the store does not
   * know about files.
   */
  deleteBot(ownerId: string, botId: string): boolean {
    const bot = store.getBot(botId);
    if (!bot || bot.ownerId !== ownerId) return false;
    db.prepare('DELETE FROM bots WHERE id=?').run(botId);
    return true;
  },

  /** Moves a bot to another sandbox target. Its workspace there is separate. */
  setBotTarget(botId: string, target: string | null): Bot | undefined {
    db.prepare('UPDATE bots SET sandboxTarget=? WHERE id=?').run(target, botId);
    return store.getBot(botId);
  },

  listBots(ownerId: string): Bot[] {
    return db.prepare('SELECT * FROM bots WHERE ownerId=? ORDER BY createdAt').all(ownerId) as unknown as Bot[];
  },

  /** Newest conversational line per bot, for the sidebar preview. */
  lastLines(ownerId: string): Record<string, { kind: string; body: string }> {
    const rows = db.prepare(`
      SELECT b.id AS botId, s.kind, s.body
      FROM bots b
      JOIN steps s ON s.id = (
        SELECT s2.id FROM steps s2
        JOIN runs r2 ON r2.id = s2.runId
        WHERE r2.botId = b.id AND s2.kind IN ('user_message','assistant_text')
        ORDER BY s2.id DESC LIMIT 1
      )
      WHERE b.ownerId = ?
    `).all(ownerId) as unknown as { botId: string; kind: string; body: string }[];

    const out: Record<string, { kind: string; body: string }> = {};
    for (const r of rows) out[r.botId] = { kind: r.kind, body: r.body };
    return out;
  },

  getBot(id: string): Bot | undefined {
    return db.prepare('SELECT * FROM bots WHERE id=?').get(id) as unknown as Bot | undefined;
  },

  createRun(botId: string): Run {
    const run: Run = {
      id: randomUUID(), botId, status: 'running', startedAt: now(),
      endedAt: null, steps: 0, tokensIn: 0, tokensOut: 0, error: null,
    };
    db.prepare('INSERT INTO runs (id,botId,status,startedAt) VALUES (?,?,?,?)').run(
      run.id, run.botId, run.status, run.startedAt,
    );
    return run;
  },

  getRun(id: string): Run | undefined {
    return db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run | undefined;
  },

  /*
   * Owner-scoped reads.
   *
   * The unscoped versions above are for callers that already established which
   * bot they are acting on (the runner, the gate). Anything driven by a request
   * must use these: an id alone is not authorisation, and before these existed
   * knowing a run id was enough to read someone else's conversation or resolve
   * their approval — which would have approved a write on their sandbox.
   *
   * A row belonging to another owner reads as absent rather than forbidden, so
   * a probe cannot learn that the id exists.
   */

  getRunFor(ownerId: string, runId: string): Run | undefined {
    return db.prepare(`SELECT r.* FROM runs r JOIN bots b ON b.id = r.botId
                       WHERE r.id = ? AND b.ownerId = ?`)
      .get(runId, ownerId) as unknown as Run | undefined;
  },

  listRunsFor(ownerId: string, botId: string, limit = 50): Run[] {
    return db.prepare(`SELECT r.* FROM runs r JOIN bots b ON b.id = r.botId
                       WHERE r.botId = ? AND b.ownerId = ?
                       ORDER BY r.startedAt DESC LIMIT ?`)
      .all(botId, ownerId, limit) as unknown as Run[];
  },

  listStepsFor(ownerId: string, runId: string): Step[] {
    return db.prepare(`SELECT s.* FROM steps s
                       JOIN runs r ON r.id = s.runId
                       JOIN bots b ON b.id = r.botId
                       WHERE s.runId = ? AND b.ownerId = ?
                       ORDER BY s.seq`)
      .all(runId, ownerId) as unknown as Step[];
  },

  getApprovalFor(ownerId: string, approvalId: string): PendingApproval | undefined {
    return db.prepare(`SELECT a.* FROM approvals a JOIN bots b ON b.id = a.botId
                       WHERE a.id = ? AND b.ownerId = ?`)
      .get(approvalId, ownerId) as unknown as PendingApproval | undefined;
  },

  pendingApprovalsFor(ownerId: string, runId: string): PendingApproval[] {
    return db.prepare(`SELECT a.* FROM approvals a JOIN bots b ON b.id = a.botId
                       WHERE a.runId = ? AND b.ownerId = ? AND a.settled = 0
                       ORDER BY a.createdAt`)
      .all(runId, ownerId) as unknown as PendingApproval[];
  },

  /** Resolves only if the approval belongs to this owner. */
  resolveApprovalFor(ownerId: string, approvalId: string, approved: boolean): PendingApproval | undefined {
    if (!store.getApprovalFor(ownerId, approvalId)) return undefined;
    return store.resolveApproval(approvalId, approved);
  },

  updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'endedAt' | 'steps' | 'tokensIn' | 'tokensOut' | 'error'>>): Run {
    const keys = Object.keys(patch);
    if (keys.length) {
      db.prepare(`UPDATE runs SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(
        ...keys.map((k) => (patch as Record<string, unknown>)[k] as never), id,
      );
    }
    return store.getRun(id)!;
  },

  /** Runs that were mid-flight when the process died. */
  resumableRuns(): Run[] {
    return db.prepare("SELECT * FROM runs WHERE status='running'").all() as unknown as Run[];
  },

  appendStep(runId: string, kind: StepKind, body: string, tool: string | null = null): Step {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM steps WHERE runId=?')
      .get(runId) as { n: number }).n;
    db.prepare('INSERT INTO steps (runId,seq,kind,tool,body,createdAt) VALUES (?,?,?,?,?,?)').run(
      runId, seq, kind, tool, body, now(),
    );
    return db.prepare('SELECT * FROM steps WHERE runId=? AND seq=?').get(runId, seq) as unknown as Step;
  },

  listSteps(runId: string): Step[] {
    return db.prepare('SELECT * FROM steps WHERE runId=? ORDER BY seq').all(runId) as unknown as Step[];
  },

  listRuns(botId: string, limit = 50): Run[] {
    return db.prepare('SELECT * FROM runs WHERE botId=? ORDER BY startedAt DESC LIMIT ?')
      .all(botId, limit) as unknown as Run[];
  },

  appendMessage(botId: string, runId: string | null, role: 'user' | 'assistant', content: unknown): void {
    db.prepare('INSERT INTO messages (botId,runId,role,content,createdAt) VALUES (?,?,?,?,?)').run(
      botId, runId, role, JSON.stringify(content), now(),
    );
  },

  /**
   * Provider transcript for a bot, oldest first, with row ids so a digest can
   * record how far it covers.
   *
   * The limit is a safety rail against unbounded reads, not the context budget:
   * compaction decides what actually goes to the model.
   */
  transcript(botId: string, limit = 2000): { id: number; role: 'user' | 'assistant'; content: unknown }[] {
    const rows = db.prepare('SELECT id,role,content FROM (SELECT * FROM messages WHERE botId=? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(botId, limit) as unknown as { id: number; role: 'user' | 'assistant'; content: string }[];
    return rows.map((r) => ({ id: r.id, role: r.role, content: JSON.parse(r.content) }));
  },

  /** The running summary of everything that has fallen out of the window. */
  getDigest(botId: string): { text: string; throughId: number } | undefined {
    return db.prepare('SELECT text,throughId FROM digests WHERE botId=?')
      .get(botId) as unknown as { text: string; throughId: number } | undefined;
  },

  putDigest(botId: string, text: string, throughId: number): void {
    db.prepare(`INSERT INTO digests (botId,text,throughId,updatedAt) VALUES (?,?,?,?)
                ON CONFLICT(botId) DO UPDATE SET text=excluded.text,
                  throughId=excluded.throughId, updatedAt=excluded.updatedAt`)
      .run(botId, text, throughId, now());
  },

  createApproval(a: Omit<PendingApproval, 'id' | 'createdAt' | 'resolvedAt' | 'approved'>): PendingApproval {
    const row: PendingApproval = { ...a, id: randomUUID(), createdAt: now(), resolvedAt: null, approved: null };
    db.prepare('INSERT INTO approvals (id,runId,botId,tool,args,reason,risk,createdAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(row.id, row.runId, row.botId, row.tool, row.args, row.reason, row.risk, row.createdAt);
    return row;
  },

  resolveApproval(id: string, approved: boolean): PendingApproval | undefined {
    db.prepare('UPDATE approvals SET approved=?, resolvedAt=? WHERE id=? AND resolvedAt IS NULL')
      .run(approved ? 1 : 0, now(), id);
    return store.getApproval(id);
  },

  getApproval(id: string): PendingApproval | undefined {
    return db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as unknown as PendingApproval | undefined;
  },

  pendingApprovals(runId: string): PendingApproval[] {
    return db.prepare('SELECT * FROM approvals WHERE runId=? AND settled=0 ORDER BY createdAt')
      .all(runId) as unknown as PendingApproval[];
  },

  settleApproval(id: string): void {
    db.prepare('UPDATE approvals SET settled=1 WHERE id=?').run(id);
  },

  openApprovals(ownerId: string): PendingApproval[] {
    return db.prepare(`SELECT a.* FROM approvals a JOIN bots b ON b.id=a.botId
                       WHERE b.ownerId=? AND a.resolvedAt IS NULL ORDER BY a.createdAt`)
      .all(ownerId) as unknown as PendingApproval[];
  },

  /**
   * Claims a tool call for execution.
   *
   * - 'run'      — first time: the caller owns it and must call finishTool().
   * - 'replay'   — already finished: use the recorded result, do not re-run.
   * - 'orphaned' — claimed but never finished, i.e. we crashed mid-execution.
   *                Whether the side effect landed is unknown, so the caller
   *                must tell the model that rather than silently retrying.
   */
  claimTool(toolUseId: string, runId: string, tool: string, args: string):
    | { kind: 'run' }
    | { kind: 'replay'; result: string; isError: boolean }
    | { kind: 'orphaned' } {
    const res = db.prepare(
      `INSERT INTO tool_executions (toolUseId,runId,tool,args,state,startedAt)
       VALUES (?,?,?,?,'started',?) ON CONFLICT(toolUseId) DO NOTHING`,
    ).run(toolUseId, runId, tool, args, now());

    if (res.changes === 1) return { kind: 'run' };

    const row = db.prepare('SELECT state,result,isError FROM tool_executions WHERE toolUseId=?')
      .get(toolUseId) as unknown as { state: string; result: string | null; isError: number };
    if (row.state === 'finished') {
      return { kind: 'replay', result: row.result ?? '', isError: row.isError === 1 };
    }
    return { kind: 'orphaned' };
  },

  finishTool(toolUseId: string, result: string, isError: boolean): void {
    db.prepare("UPDATE tool_executions SET state='finished', result=?, isError=?, finishedAt=? WHERE toolUseId=?")
      .run(result, isError ? 1 : 0, now(), toolUseId);
  },

  /** Marks an orphan resolved so a later pass does not report it twice. */
  abandonTool(toolUseId: string, note: string): void {
    db.prepare("UPDATE tool_executions SET state='finished', result=?, isError=1, finishedAt=? WHERE toolUseId=?")
      .run(note, now(), toolUseId);
  },

  /* ---------- group chats ---------- */

  createGroup(ownerId: string, name: string, members: string[]): Group {
    const group: Group = { id: randomUUID(), ownerId, name, createdAt: now(), members };
    db.prepare('INSERT INTO groups (id,ownerId,name,createdAt) VALUES (?,?,?,?)')
      .run(group.id, ownerId, name, group.createdAt);
    const add = db.prepare('INSERT INTO group_members (groupId,botId,seq) VALUES (?,?,?)');
    members.forEach((botId, i) => add.run(group.id, botId, i));
    return group;
  },

  listGroups(ownerId: string): Group[] {
    const rows = db.prepare('SELECT * FROM groups WHERE ownerId=? ORDER BY createdAt')
      .all(ownerId) as unknown as Omit<Group, 'members'>[];
    return rows.map((g) => ({ ...g, members: store.groupMembers(g.id).map((b) => b.id) }));
  },

  getGroup(ownerId: string, groupId: string): Group | undefined {
    const g = db.prepare('SELECT * FROM groups WHERE id=? AND ownerId=?')
      .get(groupId, ownerId) as unknown as Omit<Group, 'members'> | undefined;
    if (!g) return undefined;
    return { ...g, members: store.groupMembers(g.id).map((b) => b.id) };
  },

  /** Members, in the order they were added, skipping any since deleted. */
  groupMembers(groupId: string): Bot[] {
    return db.prepare(`SELECT b.* FROM group_members m JOIN bots b ON b.id = m.botId
                       WHERE m.groupId = ? ORDER BY m.seq`)
      .all(groupId) as unknown as Bot[];
  },

  addGroupMessage(
    groupId: string, botId: string | null, body: string, runId: string | null = null,
  ): GroupMessage {
    const createdAt = now();
    db.prepare('INSERT INTO group_messages (groupId,botId,body,runId,createdAt) VALUES (?,?,?,?,?)')
      .run(groupId, botId, body, runId, createdAt);
    return db.prepare('SELECT * FROM group_messages WHERE groupId=? ORDER BY id DESC LIMIT 1')
      .get(groupId) as unknown as GroupMessage;
  },

  groupMessages(groupId: string, limit = 200): GroupMessage[] {
    const rows = db.prepare(`SELECT * FROM (
                               SELECT * FROM group_messages WHERE groupId=? ORDER BY id DESC LIMIT ?
                             ) ORDER BY id`)
      .all(groupId, limit) as unknown as GroupMessage[];
    return rows;
  },

  deleteGroup(ownerId: string, groupId: string): boolean {
    const g = store.getGroup(ownerId, groupId);
    if (!g) return false;
    db.prepare('DELETE FROM groups WHERE id=?').run(groupId);
    return true;
  },

  /* ---------- routines ---------- */

  createRoutine(
    botId: string,
    r: { title: string; prompt: string; minuteOfDay: number; days: number[] },
  ): Routine {
    const row: Routine = {
      id: randomUUID(), botId, title: r.title, prompt: r.prompt,
      minuteOfDay: r.minuteOfDay, days: r.days, enabled: true,
      createdAt: now(), lastRunAt: null, lastRunId: null,
    };
    db.prepare(`INSERT INTO routines (id,botId,title,prompt,minuteOfDay,days,enabled,createdAt)
                VALUES (?,?,?,?,?,?,1,?)`).run(
      row.id, botId, row.title, row.prompt, row.minuteOfDay, row.days.join(','), row.createdAt,
    );
    return row;
  },

  listRoutines(botId: string): Routine[] {
    const rows = db.prepare('SELECT * FROM routines WHERE botId=? ORDER BY minuteOfDay')
      .all(botId) as unknown as (Omit<Routine, 'days' | 'enabled'> & { days: string; enabled: number })[];
    return rows.map((r) => ({
      ...r,
      days: r.days ? r.days.split(',').filter(Boolean).map(Number) : [],
      enabled: r.enabled === 1,
    }));
  },

  /** Every routine on the account, for the scheduler. */
  allRoutines(ownerId: string): Routine[] {
    const bots = store.listBots(ownerId);
    return bots.flatMap((b) => store.listRoutines(b.id));
  },

  getRoutine(ownerId: string, routineId: string): Routine | undefined {
    const row = db.prepare(`SELECT r.* FROM routines r JOIN bots b ON b.id = r.botId
                            WHERE r.id = ? AND b.ownerId = ?`)
      .get(routineId, ownerId) as unknown as
        (Omit<Routine, 'days' | 'enabled'> & { days: string; enabled: number }) | undefined;
    if (!row) return undefined;
    return {
      ...row,
      days: row.days ? row.days.split(',').filter(Boolean).map(Number) : [],
      enabled: row.enabled === 1,
    };
  },

  setRoutineEnabled(ownerId: string, routineId: string, enabled: boolean): Routine | undefined {
    if (!store.getRoutine(ownerId, routineId)) return undefined;
    db.prepare('UPDATE routines SET enabled=? WHERE id=?').run(enabled ? 1 : 0, routineId);
    return store.getRoutine(ownerId, routineId);
  },

  /**
   * Records that a routine ran.
   *
   * `at` is the time the run was *for*, which the scheduler passes from the
   * tick it is processing. Stamping the wall clock instead left a gap between
   * what fired and what was recorded — invisible in production, and the reason
   * a corrected clock or a DST change could make a routine run twice.
   */
  markRoutineRun(routineId: string, runId: string, at: number = now()): void {
    db.prepare('UPDATE routines SET lastRunAt=?, lastRunId=? WHERE id=?')
      .run(at, runId, routineId);
  },

  deleteRoutine(ownerId: string, routineId: string): boolean {
    if (!store.getRoutine(ownerId, routineId)) return false;
    db.prepare('DELETE FROM routines WHERE id=?').run(routineId);
    return true;
  },

  remember(botId: string, text: string): void {
    db.prepare('INSERT INTO memories (botId,text,createdAt) VALUES (?,?,?)').run(botId, text, now());
  },

  memories(botId: string): string[] {
    const rows = db.prepare('SELECT text FROM memories WHERE botId=? ORDER BY createdAt')
      .all(botId) as unknown as { text: string }[];
    return rows.map((r) => r.text);
  },
};
