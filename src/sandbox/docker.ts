import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { targetEgress, type SandboxTarget } from './config.ts';
import type { EgressPolicy } from './egress.ts';
import { clip, type ExecResult, type Sandbox, type SandboxDriver } from './types.ts';

const DEFAULT_IMAGE = process.env.SANDBOX_IMAGE ?? 'node:22-bookworm';

/** Copied into the proxy container so both run one copy of the filtering logic. */
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Timeout for docker's own management calls (inspect, create, cp, …).
 *
 * These must not hang the orchestrator when a remote daemon stops answering.
 * The agent's own commands are separate and intentionally unbounded.
 */
const MGMT_TIMEOUT_MS = 60_000;

/** Connection flags for a target's daemon. Empty means the local one. */
function hostFlags(target: SandboxTarget): string[] {
  if (target.dockerHost) return ['-H', target.dockerHost];
  if (target.dockerContext) return ['--context', target.dockerContext];
  return [];
}

/** Runs the docker CLI with an args array — never a shell string, so the
 *  agent's command text cannot escape into the host shell. */
/**
 * Runs the docker CLI.
 *
 * `timeoutMs` undefined means no timeout: the agent's bash tool passes a limit
 * only when the model asked for one, and imposing a default here killed long
 * commands while reporting exit -1 — which reads as a truncated command rather
 * than as something we stopped. Management calls below pass their own limits.
 */
function docker(args: string[], stdin?: string, timeoutMs?: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    // A remote daemon over ssh:// needs a non-interactive key; prompting would
    // hang the orchestrator, so fail fast instead.
    const env = { ...process.env, DOCKER_CLI_HINTS: 'false', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' };
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    let killedByTimeout = false;
    const timer = timeoutMs
      ? setTimeout(() => { killedByTimeout = true; child.kill('SIGKILL'); }, timeoutMs)
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
      const note = killedByTimeout
        ? `\n[stopped after ${timeoutMs}ms by the sandbox timeout]`
        : signal ? `\n[killed by ${signal}]` : '';
      resolve({
        exitCode: code ?? -1,
        stdout: o.text,
        stderr: clip(err).text + note,
        truncated: o.truncated,
      });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

class DockerSandbox implements Sandbox {
  constructor(
    readonly ownerId: string,
    private readonly container: string,
    private readonly flags: string[],
  ) {}

  readonly workdir = '/workspace';

  private dk(args: string[], stdin?: string, timeoutMs?: number) {
    return docker([...this.flags, ...args], stdin, timeoutMs);
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.dk(
      ['exec', '-w', '/workspace', this.container, 'sh', '-c', command],
      undefined,
      opts?.timeoutMs,
    );
  }

  async readFile(path: string): Promise<string> {
    const r = await this.dk(['exec', this.container, 'cat', '--', path]);
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot read ${path}`);
    return r.stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    // Content arrives on stdin so it is never part of the argv or a shell string.
    const r = await this.dk(
      ['exec', '-i', this.container, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', '--', path],
      content,
    );
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `cannot write ${path}`);
  }

  async stop(): Promise<void> {
    await this.dk(['stop', this.container]);
  }
}

async function ensureNetwork(flags: string[], name: string, internal: boolean): Promise<void> {
  const exists = await docker([...flags, 'network', 'inspect', name], undefined, MGMT_TIMEOUT_MS);
  if (exists.exitCode === 0) return;
  const args = [...flags, 'network', 'create'];
  // An internal network has no route off the host: the only way out is a
  // container that is also attached to another network.
  if (internal) args.push('--internal');
  args.push(name);
  const created = await docker(args);
  if (created.exitCode !== 0 && !created.stderr.includes('already exists')) {
    throw new Error(`cannot create network ${name}: ${created.stderr}`);
  }
}

async function isRunning(flags: string[], container: string): Promise<boolean | null> {
  const state = await docker([...flags, 'inspect', '-f', '{{.State.Running}}', container], undefined, MGMT_TIMEOUT_MS);
  if (state.exitCode !== 0) return null; // does not exist
  return state.stdout.trim() === 'true';
}

/** Resource names are namespaced by target so two targets never collide. */
function names(targetName: string, ownerId: string) {
  const slug = `${targetName}-${ownerId}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return {
    sandbox: `gbl-${slug}`,
    proxy: `gbl-proxy-${slug}`,
    volume: `gbl-ws-${slug}`,
    internalNet: `gbl-net-${slug}`,
    egressNet: `gbl-egress-${slug}`,
  };
}

/**
 * Starts the proxy container for an owner, attached to both the sandbox's
 * internal network and an egress network.
 *
 * The sources are copied in with `docker cp` rather than bind-mounted: a bind
 * mount resolves on the *daemon's* filesystem, which for a remote target is a
 * different machine. Copying goes through the daemon API, so local and remote
 * behave identically.
 */
async function ensureProxy(
  flags: string[],
  targetName: string,
  ownerId: string,
  policy: EgressPolicy,
  image: string,
): Promise<string> {
  const n = names(targetName, ownerId);

  await ensureNetwork(flags, n.internalNet, true);
  await ensureNetwork(flags, n.egressNet, false);

  const running = await isRunning(flags, n.proxy);
  if (running === true) return n.proxy;
  if (running === false) {
    // Policy lives in the environment, so a changed policy needs a new container.
    await docker([...flags, 'rm', '-f', n.proxy], undefined, MGMT_TIMEOUT_MS);
  }

  // Created idle so the sources can be copied in before the proxy starts.
  const created = await docker([
    ...flags,
    'run', '-d',
    '--name', n.proxy,
    '--network', n.internalNet,
    '--network-alias', 'egress-proxy',
    '-e', `EGRESS_POLICY=${JSON.stringify(policy)}`,
    '-e', 'PROXY_PORT=8888',
    '--memory', '256m',
    '--pids-limit', '128',
    '--cap-drop', 'ALL',
    image,
    'sleep', 'infinity',
  ], undefined, MGMT_TIMEOUT_MS);
  if (created.exitCode !== 0) throw new Error(`cannot start egress proxy: ${created.stderr}`);

  // docker cp will not create parent directories.
  const made = await docker([...flags, 'exec', n.proxy, 'mkdir', '-p', '/app/src/sandbox'], undefined, MGMT_TIMEOUT_MS);
  if (made.exitCode !== 0) throw new Error(`cannot prepare the proxy container: ${made.stderr}`);

  const copied = await docker([...flags, 'cp', `${SRC_DIR}/.`, `${n.proxy}:/app/src/sandbox/`], undefined, MGMT_TIMEOUT_MS);
  if (copied.exitCode !== 0) throw new Error(`cannot copy proxy sources: ${copied.stderr}`);

  const launched = await docker([
    ...flags, 'exec', '-d', n.proxy,
    'sh', '-c',
    'node --experimental-strip-types /app/src/sandbox/proxy-entry.ts >/proc/1/fd/1 2>/proc/1/fd/2',
  ], undefined, MGMT_TIMEOUT_MS);
  if (launched.exitCode !== 0) throw new Error(`cannot launch the proxy: ${launched.stderr}`);

  // Wait for it to listen before any sandbox depends on it.
  for (let i = 0; i < 40; i++) {
    const probe = await docker([
      ...flags, 'exec', n.proxy,
      'node', '-e',
      "const n=require('net');const s=n.connect(8888,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))",
    ], undefined, MGMT_TIMEOUT_MS);
    if (probe.exitCode === 0) break;
    if (i === 39) throw new Error('the egress proxy did not start listening');
    await new Promise((r) => setTimeout(r, 250));
  }

  // Second attachment is what gives the proxy — and only the proxy — a way out.
  const attached = await docker([...flags, 'network', 'connect', n.egressNet, n.proxy], undefined, MGMT_TIMEOUT_MS);
  if (attached.exitCode !== 0) throw new Error(`cannot attach proxy to egress: ${attached.stderr}`);

  return n.proxy;
}

/** Builds a driver bound to one target. Local and remote differ only in flags. */
export function makeDockerDriver(targetName: string, target: SandboxTarget): SandboxDriver {
  const flags = hostFlags(target);
  const image = target.image ?? DEFAULT_IMAGE;
  const policy = targetEgress(target);
  const n = (ownerId: string) => names(targetName, ownerId);

  return {
    name: targetName,

    async acquire(ownerId: string): Promise<Sandbox> {
      const r = n(ownerId);

      const running = await isRunning(flags, r.sandbox);
      if (running !== null) {
        if (!running) {
          const started = await docker([...flags, 'start', r.sandbox], undefined, MGMT_TIMEOUT_MS);
          if (started.exitCode !== 0) throw new Error(`cannot start ${r.sandbox}: ${started.stderr}`);
        }
        if (policy.mode !== 'allow_all') await ensureProxy(flags, targetName, ownerId, policy, image);
        return new DockerSandbox(ownerId, r.sandbox, flags);
      }

      // The workspace volume outlives the container, so a rebuild keeps files.
      await docker([...flags, 'volume', 'create', r.volume], undefined, MGMT_TIMEOUT_MS);

      const args = [
        ...flags,
        'run', '-d',
        '--name', r.sandbox,
        '-v', `${r.volume}:/workspace`,
        '-w', '/workspace',
        '--memory', '2g',
        '--cpus', '2',
        '--pids-limit', '512',
      ];

      if (policy.mode === 'allow_all') {
        // Default bridge: the sandbox reaches anything the daemon's host can.
        args.push('--network', 'bridge');
      } else {
        await ensureProxy(flags, targetName, ownerId, policy, image);
        // Only the internal network. There is no route out except the proxy, so
        // the env vars below are a convenience for clients, not the control.
        args.push('--network', r.internalNet);
        args.push('-e', 'HTTP_PROXY=http://egress-proxy:8888');
        args.push('-e', 'HTTPS_PROXY=http://egress-proxy:8888');
        args.push('-e', 'http_proxy=http://egress-proxy:8888');
        args.push('-e', 'https_proxy=http://egress-proxy:8888');
        args.push('-e', 'NO_PROXY=localhost,127.0.0.1');
      }

      args.push(image, 'sleep', 'infinity');

      const created = await docker(args, undefined, MGMT_TIMEOUT_MS);
      if (created.exitCode !== 0) throw new Error(`cannot create sandbox: ${created.stderr}`);
      return new DockerSandbox(ownerId, r.sandbox, flags);
    },
  };
}

/** Checks a target's daemon is reachable, so a bad target fails loudly. */
export async function probeTarget(target: SandboxTarget): Promise<{ ok: boolean; detail: string }> {
  const r = await docker([...hostFlags(target), 'version', '--format', '{{.Server.Version}}'], undefined, 20_000);
  return r.exitCode === 0
    ? { ok: true, detail: `daemon ${r.stdout.trim()}` }
    : { ok: false, detail: (r.stderr || r.stdout).trim().split('\n')[0] ?? 'unreachable' };
}

/** Tears down an owner's sandbox, proxy, and networks on one target. Keeps the volume. */
export async function destroyOwner(
  ownerId: string,
  targetName = 'local-docker',
  target: SandboxTarget = { kind: 'docker' },
): Promise<void> {
  const flags = hostFlags(target);
  const r = names(targetName, ownerId);
  await docker([...flags, 'rm', '-f', r.sandbox], undefined, MGMT_TIMEOUT_MS);
  await docker([...flags, 'rm', '-f', r.proxy], undefined, MGMT_TIMEOUT_MS);
  await docker([...flags, 'network', 'rm', r.internalNet], undefined, MGMT_TIMEOUT_MS);
  await docker([...flags, 'network', 'rm', r.egressNet], undefined, MGMT_TIMEOUT_MS);
}
