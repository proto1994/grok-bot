import { readFile } from 'node:fs/promises';
import type { RiskLevel } from '../protocol.ts';
import { registerTool, type Tool } from '../agent/tools.ts';
import { McpClient, type McpToolInfo } from './client.ts';

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Tools that only read. Everything else is treated as 'external' risk and
   * needs approval — an unknown tool from an unknown server is the last thing
   * that should run unattended.
   */
  readOnlyTools?: string[];
  disabled?: boolean;
}

export type McpConfig = { servers: Record<string, McpServerSpec> };

const clients: McpClient[] = [];

/** Tool names reach the model, so keep them to the characters providers accept. */
function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${clean(server)}__${clean(tool)}`;
}

function toSchema(info: McpToolInfo, exposedName: string) {
  const s = info.inputSchema;
  return {
    name: exposedName,
    description: info.description ?? `MCP tool "${info.name}".`,
    input_schema: {
      type: 'object' as const,
      properties: (s?.properties ?? {}) as Record<string, unknown>,
      ...(s?.required ? { required: s.required } : {}),
    },
  };
}

export async function loadMcpServers(configPath: string): Promise<{ server: string; tools: string[] }[]> {
  let cfg: McpConfig;
  try {
    const text = (await readFile(configPath, 'utf8')).trim();
    if (!text) return []; // an empty file means "no servers", not a broken config
    cfg = JSON.parse(text) as McpConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read ${configPath}: ${e instanceof Error ? e.message : e}`);
  }

  const loaded: { server: string; tools: string[] }[] = [];

  for (const [name, spec] of Object.entries(cfg.servers ?? {})) {
    if (spec.disabled) continue;
    const client = new McpClient(name, spec);
    try {
      const tools = await client.start();
      clients.push(client);
      const readOnly = new Set(spec.readOnlyTools ?? []);

      for (const info of tools) {
        const exposed = toolName(name, info.name);
        const risk: RiskLevel = readOnly.has(info.name) ? 'read' : 'external';
        const tool: Tool = {
          risk,
          schema: toSchema(info, exposed),
          run: (input) => client.callTool(info.name, input),
        };
        registerTool(exposed, tool);
      }
      loaded.push({ server: name, tools: tools.map((t) => t.name) });
    } catch (e) {
      // One broken server must not stop the others, or the whole orchestrator.
      console.error(`[mcp:${name}] failed to start: ${e instanceof Error ? e.message : e}`);
      client.stop();
    }
  }

  return loaded;
}

export function stopMcpServers(): void {
  for (const c of clients) c.stop();
  clients.length = 0;
}
