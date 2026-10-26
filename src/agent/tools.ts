import type { RiskLevel } from '../protocol.ts';

/**
 * Registry for tools we supply ourselves.
 *
 * PI brings its own bash/read/write/edit (wired to the sandbox in
 * src/pi/sandbox-ops.ts), so nothing is registered here by default. What remains
 * is the seam MCP servers register through: their tools carry a risk level, and
 * the approval gate asks the policy engine about them by name.
 */

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ToolContext {
  botId: string;
  ownerId: string;
  /** Which sandbox target this bot's computer lives on; null means the default. */
  sandboxTarget?: string | null;
}

export interface Tool {
  schema: ToolSchema;
  risk: RiskLevel;
  /** Returns text the model will read. Throwing is fine: the error is fed back. */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export const TOOLS: Record<string, Tool> = {};

/** Adds a tool at runtime (MCP servers register theirs this way). */
export function registerTool(name: string, tool: Tool): void {
  if (TOOLS[name]) throw new Error(`tool name already taken: ${name}`);
  TOOLS[name] = tool;
}

/** Computed per call: MCP tools register after this module loads. */
export function toolSchemas(): ToolSchema[] {
  return Object.values(TOOLS).map((t) => t.schema);
}
