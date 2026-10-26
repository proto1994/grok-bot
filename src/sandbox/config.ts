import { readFile } from 'node:fs/promises';
import { loadPolicy, DEFAULT_POLICY, type EgressPolicy } from './egress.ts';

/**
 * Sandbox targets.
 *
 * A target is "where a bot's computer lives". The same code drives a local
 * daemon and a remote one: docker's CLI takes `-H ssh://host` or a named
 * context, so a remote target reuses the whole network-isolation path unchanged.
 *
 * Switching is per bot and takes effect when its sandbox is next acquired.
 * State does not follow: files and logins live in the sandbox, so a bot moved
 * to another target starts from an empty workspace there. That is a property of
 * the design, not an oversight — migrating live state is a different feature.
 */

export interface SandboxTarget {
  /** 'docker' isolates; 'local' runs on the orchestrator's host with no isolation. */
  kind: 'docker' | 'local';
  /** docker only: a daemon address, e.g. "ssh://ops@sandbox-1" or "tcp://10.0.0.5:2375". */
  dockerHost?: string;
  /** docker only: a named docker context, as an alternative to dockerHost. */
  dockerContext?: string;
  image?: string;
  egress?: EgressPolicy;
  description?: string;
}

export interface SandboxConfig {
  targets: Record<string, SandboxTarget>;
  default: string;
}

export const BUILTIN_LOCAL = 'local-docker';

/** Used when no config file is present: one local docker target. */
export function builtinConfig(): SandboxConfig {
  return {
    targets: {
      [BUILTIN_LOCAL]: {
        kind: 'docker',
        description: 'docker on this machine',
      },
    },
    default: BUILTIN_LOCAL,
  };
}

function parseTarget(name: string, raw: unknown): SandboxTarget {
  if (!raw || typeof raw !== 'object') throw new Error(`target "${name}" must be an object`);
  const o = raw as Record<string, unknown>;

  const kind = o.kind;
  if (kind !== 'docker' && kind !== 'local') {
    throw new Error(`target "${name}": kind must be "docker" or "local", got ${JSON.stringify(kind)}`);
  }
  if (kind === 'local' && (o.dockerHost || o.dockerContext)) {
    throw new Error(`target "${name}": a local target cannot have dockerHost or dockerContext`);
  }
  if (o.dockerHost && o.dockerContext) {
    throw new Error(`target "${name}": set dockerHost or dockerContext, not both`);
  }

  return {
    kind,
    ...(typeof o.dockerHost === 'string' ? { dockerHost: o.dockerHost } : {}),
    ...(typeof o.dockerContext === 'string' ? { dockerContext: o.dockerContext } : {}),
    ...(typeof o.image === 'string' ? { image: o.image } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    egress: o.egress ? loadPolicy(o.egress) : undefined,
  };
}

export function parseConfig(raw: unknown): SandboxConfig {
  if (!raw || typeof raw !== 'object') throw new Error('sandbox config must be an object');
  const o = raw as Record<string, unknown>;

  const rawTargets = o.targets;
  if (!rawTargets || typeof rawTargets !== 'object') throw new Error('sandbox config needs a "targets" object');

  const targets: Record<string, SandboxTarget> = {};
  for (const [name, t] of Object.entries(rawTargets as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      // Target names end up in container and network names.
      throw new Error(`target name "${name}" must be alphanumeric with - or _`);
    }
    targets[name] = parseTarget(name, t);
  }

  const names = Object.keys(targets);
  if (names.length === 0) throw new Error('sandbox config defines no targets');

  const def = typeof o.default === 'string' ? o.default : names[0]!;
  if (!targets[def]) throw new Error(`default target "${def}" is not defined`);

  return { targets, default: def };
}

export async function loadConfig(path: string): Promise<SandboxConfig> {
  try {
    const text = (await readFile(path, 'utf8')).trim();
    if (!text) return builtinConfig();
    return parseConfig(JSON.parse(text));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return builtinConfig();
    throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

export function resolveTarget(cfg: SandboxConfig, name: string | null | undefined): { name: string; target: SandboxTarget } {
  const chosen = name ?? cfg.default;
  const target = cfg.targets[chosen];
  if (!target) {
    throw new Error(
      `unknown sandbox target "${chosen}". Available: ${Object.keys(cfg.targets).join(', ')}`,
    );
  }
  return { name: chosen, target };
}

export function targetEgress(t: SandboxTarget): EgressPolicy {
  return t.egress ?? DEFAULT_POLICY;
}

export function describeTarget(name: string, t: SandboxTarget): string {
  const where =
    t.kind === 'local' ? 'this host, NO isolation'
    : t.dockerHost ? `docker at ${t.dockerHost}`
    : t.dockerContext ? `docker context "${t.dockerContext}"`
    : 'docker on this machine';
  return `${name} — ${where}`;
}
