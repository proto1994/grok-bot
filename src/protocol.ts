/** Shared types between the orchestrator and any client (desktop, web, mobile). */

export type RiskLevel = 'read' | 'write' | 'external';

/** A run is one turn of work. It survives process restarts. */
export type RunStatus =
  | 'running'
  | 'waiting_approval'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'budget_exceeded';

export type StepKind = 'user_message' | 'assistant_text' | 'tool_call' | 'tool_result' | 'note';

/**
 * How much a bot may do without stopping to ask.
 *
 * - strict:   every tool call needs approval, including reads.
 * - balanced: reads run; anything that writes or leaves the sandbox asks.
 * - full:     nothing asks. The approval gate is bypassed entirely.
 *
 * 'full' is not expressible as a rule: rules may only tighten, never loosen, so
 * a prompt-injected "rule" can never reach it. It is a separate code path that
 * only a person can turn on.
 */
export type PermissionMode = 'strict' | 'balanced' | 'full';

export const PERMISSION_MODES: PermissionMode[] = ['strict', 'balanced', 'full'];

export interface Bot {
  id: string;
  ownerId: string;
  name: string;
  job: string;
  createdAt: number;
  /** Sandbox target name, or null for the configured default. */
  sandboxTarget: string | null;
  permissionMode: PermissionMode;
  /** Avatar shape and colour ids; null means derived from the bot's id. */
  shape: string | null;
  color: string | null;
  /**
   * Which configured provider and model this bot calls.
   * Null on either means the account default.
   */
  providerId: string | null;
  modelId: string | null;
}

export interface Run {
  id: string;
  botId: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  error: string | null;
}

export interface Step {
  id: number;
  runId: string;
  seq: number;
  kind: StepKind;
  /** Tool name for tool_call / tool_result. */
  tool: string | null;
  /** Human-readable payload. Arguments, output, or message text. */
  body: string;
  createdAt: number;
}

export interface PendingApproval {
  id: string;
  runId: string;
  botId: string;
  tool: string;
  args: string;
  reason: string;
  risk: RiskLevel;
  createdAt: number;
  resolvedAt: number | null;
  approved: number | null;
}

/**
 * A group chat: one person and two to six bots in a shared conversation.
 *
 * Bounded at six deliberately. Beyond that, a message with no @ has too many
 * plausible answerers and the transcript turns into noise — the same reason the
 * kickoff advice is one owner per stage.
 */
export interface Group {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
  members: string[];
}

export const GROUP_MIN = 2;
export const GROUP_MAX = 6;

export interface GroupMessage {
  id: number;
  groupId: string;
  /** null means the person; otherwise the bot that said it. */
  botId: string | null;
  body: string;
  runId: string | null;
  createdAt: number;
}

/** Events pushed to clients over the websocket. */
export type ServerEvent =
  | { type: 'run.updated'; run: Run }
  | { type: 'step.appended'; step: Step; botId?: string }
  | { type: 'approval.requested'; approval: PendingApproval }
  | { type: 'approval.resolved'; approvalId: string; approved: boolean }
  | { type: 'bot.created'; bot: Bot }
  | { type: 'group.created'; group: Group }
  | { type: 'group.message'; message: GroupMessage; authorName: string }
  | { type: 'group.thinking'; groupId: string; botId: string | null }
  | { type: 'question.asked'; botId: string; question: string; options: string[] }
  | { type: 'routines.changed'; botId: string; routines: unknown[] }
  | { type: 'routine.fired'; botId: string; title: string; runId: string };
