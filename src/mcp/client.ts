import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Minimal MCP client over stdio. Enough to discover and call tools, which is
 * what the loop needs; resources, prompts, and sampling are not wired up.
 *
 * Framing is newline-delimited JSON-RPC 2.0 on stdin/stdout. Servers are free
 * to write logs to stderr, so stderr is never parsed.
 */

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    readonly label: string,
    private readonly spec: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string },
    private readonly timeoutMs = 30_000,
  ) {}

  async start(): Promise<McpToolInfo[]> {
    // The server inherits only what it is given: no ambient process env, so a
    // misbehaving server cannot read unrelated credentials out of our environment.
    this.child = spawn(this.spec.command, this.spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.spec.cwd,
      env: { PATH: process.env.PATH ?? '', ...(this.spec.env ?? {}) },
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => {
      const line = d.trim();
      if (line) console.error(`[mcp:${this.label}] ${line.slice(0, 500)}`);
    });
    this.child.on('exit', (code) => this.failAll(new Error(`server exited (code=${code})`)));
    this.child.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: 'grok-bot-lite', version: '0.1.0' },
    });
    this.notify('notifications/initialized');

    const listed = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
    return listed.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content omitted]`))
      .join('\n')
      .trim();
    if (res.isError) throw new Error(text || 'the tool reported an error');
    return text || '(no output)';
  }

  stop(): void {
    this.closed = true;
    this.failAll(new Error('client stopped'));
    this.child?.kill();
    this.child = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;

      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`[mcp:${this.label}] unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      if (typeof msg.id !== 'number') continue; // a notification or a request from the server
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? `rpc error ${msg.error.code}`));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.closed) return Promise.reject(new Error('client is not running'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private notify(method: string, params: unknown = {}): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
