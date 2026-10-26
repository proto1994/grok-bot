import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clip, type ExecResult, type Sandbox, type SandboxDriver } from './types.ts';

const ROOT = path.resolve(process.env.LOCAL_SANDBOX_ROOT ?? './data/workspaces');

/**
 * Dev-only driver: commands run as your user on the host. There is no isolation.
 * It exists so the loop can be developed without a docker daemon, and so the
 * Sandbox seam stays honest — swapping in a remote driver must require no
 * changes above this file.
 */
class LocalSandbox implements Sandbox {
  constructor(
    readonly ownerId: string,
    private readonly cwd: string,
  ) {}

  /** The host path commands really run in; there is no /workspace here. */
  get workdir(): string {
    return this.cwd;
  }

  /** Keeps file tools inside the workspace. Not a security boundary — a shell
   *  command can still reach anywhere this process can. */
  private resolve(p: string): string {
    const abs = path.resolve(this.cwd, p.replace(/^\/workspace\/?/, ''));
    const rel = path.relative(this.cwd, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes the workspace: ${p}`);
    }
    return abs;
  }

  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(command, { shell: true, cwd: this.cwd });
      let out = '';
      let err = '';
      // No timeout unless one was asked for. A default here killed long
      // commands and reported exit -1, which reads as "the command was cut off"
      // rather than "we stopped it".
      let killedByTimeout = false;
      const timer = opts?.timeoutMs
        ? setTimeout(() => {
            killedByTimeout = true;
            child.kill('SIGKILL');
          }, opts.timeoutMs)
        : null;
      const done = () => { if (timer) clearTimeout(timer); };

      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        done();
        resolve({ exitCode: -1, stdout: '', stderr: String(e), truncated: false });
      });
      child.on('close', (code, signal) => {
        done();
        const o = clip(out);
        // Say plainly that we stopped it, so the model does not retry a command
        // that was actually fine.
        const note = killedByTimeout
          ? `\n[stopped after ${opts?.timeoutMs}ms by the sandbox timeout]`
          : signal
            ? `\n[killed by ${signal}]`
            : '';
        resolve({
          exitCode: code ?? -1,
          stdout: o.text,
          stderr: clip(err).text + note,
          truncated: o.truncated,
        });
      });
    });
  }

  async readFile(p: string): Promise<string> {
    return readFile(this.resolve(p), 'utf8');
  }

  async writeFile(p: string, content: string): Promise<void> {
    const abs = this.resolve(p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  async stop(): Promise<void> {
    /* nothing to reclaim */
  }
}

export const localDriver: SandboxDriver = {
  name: 'local',

  async acquire(ownerId: string): Promise<Sandbox> {
    if (process.env.SANDBOX_ALLOW_LOCAL !== '1') {
      throw new Error(
        'SANDBOX_DRIVER=local runs commands on your host with no isolation. ' +
          'Set SANDBOX_ALLOW_LOCAL=1 to accept that, or start docker and use SANDBOX_DRIVER=docker.',
      );
    }
    const dir = path.join(ROOT, ownerId);
    await mkdir(dir, { recursive: true });
    return new LocalSandbox(ownerId, dir);
  },
};
