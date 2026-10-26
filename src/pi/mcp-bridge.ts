import type { TSchema } from 'typebox';
import { TOOLS, type Tool, type ToolContext } from '../agent/tools.ts';

/**
 * Exposes our MCP-backed tools to PI.
 *
 * Without this, a connected MCP server shows up in /api/tools but the model
 * cannot call it — the UI would claim a capability that does not exist.
 *
 * MCP gives plain JSON Schema and PI's `parameters` is typed as a typebox
 * TSchema. At runtime a typebox schema *is* a JSON Schema object, so the schema
 * passes straight through; the assertion is only to satisfy the nominal type.
 */

export type PiToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<{ content: { type: 'text'; text: string }[]; details: unknown; isError?: boolean }>;
};

export function toPiTool(name: string, tool: Tool, ctx: ToolContext): PiToolDefinition {
  const schema = tool.schema.input_schema as unknown as TSchema;
  return {
    name,
    // Shown in UIs; the server-qualified name is already distinctive.
    label: name,
    description: tool.schema.description,
    parameters: schema,
    async execute(_id, params) {
      try {
        const text = await tool.run((params ?? {}) as Record<string, unknown>, ctx);
        return { content: [{ type: 'text', text: text || '(no output)' }], details: {} };
      } catch (e) {
        // An error is information the model can act on, not a crash.
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], details: {}, isError: true };
      }
    },
  };
}

/** Every registered MCP tool, as PI tool definitions. */
export function mcpToolDefinitions(ctx: ToolContext): PiToolDefinition[] {
  return Object.entries(TOOLS).map(([name, tool]) => toPiTool(name, tool, ctx));
}

export function mcpToolNames(): string[] {
  return Object.keys(TOOLS);
}
