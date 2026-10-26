export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * One sandbox per owner, shared by all of that owner's bots.
 *
 * This mirrors the trade-off Grok Bot makes: handoffs between bots work without
 * re-authenticating, but bots are NOT isolated from each other. If two bots must
 * hold credentials with different blast radius, give them separate owners.
 */
export interface Sandbox {
  readonly ownerId: string;
  /**
   * The working directory as seen from inside the sandbox.
   *
   * The docker driver reports /workspace; the local driver reports the host
   * path it actually runs in. Telling the model /workspace when `cd /workspace`
   * fails wasted turns and made it doubt its own tools.
   */
  readonly workdir: string;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** Frees compute but keeps the workspace. */
  stop(): Promise<void>;
}

export interface SandboxDriver {
  readonly name: string;
  /** Idempotent: returns a live sandbox, creating or waking it as needed. */
  acquire(ownerId: string): Promise<Sandbox>;
}

export const MAX_OUTPUT_BYTES = 64 * 1024;

export function clip(s: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return { text: s, truncated: false };
  return {
    text: buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + '\n[...output truncated]',
    truncated: true,
  };
}
