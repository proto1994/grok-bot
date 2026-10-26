import type { Sandbox } from '../sandbox/index.ts';

/**
 * PI tool operations backed by our sandbox.
 *
 * Only tools whose work actually goes through these hooks belong here. grep and
 * find spawn their own child process on the host, so no implementation of their
 * hooks would keep them inside the sandbox; they are not exposed at all.
 *
 * Without these, PI's tools run in the orchestrator's own process — which means
 * on the host, with the host's permissions, and the container isolation we built
 * would be bypassed entirely. PI's docs point at exactly this seam: "Override
 * these to delegate command execution to remote systems."
 *
 * Every path is resolved under the sandbox's working directory, so a path PI
 * believes is absolute still lands inside the sandbox.
 *
 * `cwd` is whatever the sandbox reports as its working directory: /workspace for
 * the docker driver, a host path for the local one.
 */

/** Maps a path PI produced onto a path inside the sandbox. */
export function toSandboxPath(p: string, cwd: string): string {
  if (p === cwd) return cwd;
  if (p.startsWith(`${cwd}/`)) return p;
  if (p.startsWith('/')) {
    // An absolute path from somewhere else is treated as relative to the
    // workspace rather than followed out of it.
    return `${cwd}/${p.replace(/^\/+/, '')}`;
  }
  return `${cwd}/${p}`;
}

/**
 * Path for use inside a shell command.
 *
 * exec() runs with the workspace as its working directory and does no path
 * translation, while readFile/writeFile resolve against it. A relative path is
 * the only form both treat the same way.
 */
export function toShellPath(p: string, cwd: string): string {
  const abs = toSandboxPath(p, cwd);
  if (abs === cwd) return '.';
  return abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
}

/** Single-quotes a string for safe use inside a sh -c command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function sandboxBashOperations(sandbox: Sandbox, cwd: string) {
  return {
    async exec(
      command: string,
      _cwd: string,
      options: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number },
    ): Promise<{ exitCode: number | null }> {
      if (options.signal?.aborted) return { exitCode: null };

      const r = await sandbox.exec(command, { timeoutMs: options.timeout });
      // Our sandbox returns the whole result; PI expects streamed chunks. One
      // chunk at the end is a faithful-but-unstreamed view, which is honest:
      // nothing is dropped, it just arrives at once.
      if (r.stdout) options.onData(Buffer.from(r.stdout, 'utf8'));
      if (r.stderr) options.onData(Buffer.from(r.stderr, 'utf8'));
      return { exitCode: r.exitCode };
    },
  };
}

export function sandboxReadOperations(sandbox: Sandbox, cwd: string) {
  return {
    async readFile(absolutePath: string): Promise<Buffer> {
      return Buffer.from(await sandbox.readFile(toSandboxPath(absolutePath, cwd)), 'utf8');
    },
    async access(absolutePath: string): Promise<void> {
      const p = toSandboxPath(absolutePath, cwd);
      const r = await sandbox.exec(`test -e ${shq(toShellPath(absolutePath, cwd))}`);
      if (r.exitCode !== 0) {
        const err = new Error(`ENOENT: no such file or directory, access '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    },
  };
}

export function sandboxWriteOperations(sandbox: Sandbox, cwd: string) {
  return {
    async writeFile(absolutePath: string, content: string): Promise<void> {
      await sandbox.writeFile(toSandboxPath(absolutePath, cwd), content);
    },
    async mkdir(dir: string): Promise<void> {
      const r = await sandbox.exec(`mkdir -p ${shq(toShellPath(dir, cwd))}`);
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot mkdir ${dir}`);
    },
  };
}

export function sandboxLsOperations(sandbox: Sandbox, cwd: string) {
  return {
    async exists(absolutePath: string): Promise<boolean> {
      const r = await sandbox.exec(`test -e ${shq(toShellPath(absolutePath, cwd))}`);
      return r.exitCode === 0;
    },
    async stat(absolutePath: string): Promise<{ isDirectory: () => boolean; size: number }> {
      const p = shq(toShellPath(absolutePath, cwd));
      // One round trip: type marker then size, so a listing is not N execs.
      const r = await sandbox.exec(
        `if [ -d ${p} ]; then echo d; else echo f; fi; wc -c < ${p} 2>/dev/null || echo 0`,
      );
      const [kind = 'f', size = '0'] = r.stdout.trim().split('\n');
      const isDir = kind.trim() === 'd';
      return { isDirectory: () => isDir, size: Number(size.trim()) || 0 };
    },
    async readdir(absolutePath: string): Promise<string[]> {
      const r = await sandbox.exec(`ls -A ${shq(toShellPath(absolutePath, cwd))} 2>/dev/null`);
      return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    },
  };
}

export function sandboxEditOperations(sandbox: Sandbox, cwd: string) {
  const read = sandboxReadOperations(sandbox, cwd);
  const write = sandboxWriteOperations(sandbox, cwd);
  return {
    readFile: read.readFile,
    access: read.access,
    writeFile: write.writeFile,
  };
}
