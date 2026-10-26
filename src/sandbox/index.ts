import {
  builtinConfig, describeTarget, loadConfig, resolveTarget, targetEgress,
  type SandboxConfig, type SandboxTarget,
} from './config.ts';
import { makeDockerDriver, probeTarget } from './docker.ts';
import { loadPolicy } from './egress.ts';
import { localDriver } from './local.ts';
import type { Sandbox, SandboxDriver } from './types.ts';

export type { ExecResult, Sandbox, SandboxDriver } from './types.ts';
export { describeTarget, targetEgress, probeTarget };
export type { SandboxConfig, SandboxTarget };

/**
 * Config from the environment, for single-target setups and tests.
 *
 * SANDBOX_DRIVER / EGRESS_POLICY describe one target; sandboxes.json describes
 * several. The file wins when present.
 */
function envConfig(): SandboxConfig {
  const kind = process.env.SANDBOX_DRIVER === 'local' ? 'local' : 'docker';
  const name = kind === 'local' ? 'local-host' : 'local-docker';
  const egress = process.env.EGRESS_POLICY
    ? loadPolicy(JSON.parse(process.env.EGRESS_POLICY))
    : undefined;
  return {
    targets: {
      [name]: {
        kind,
        ...(egress ? { egress } : {}),
        description: kind === 'local' ? 'this host, NO isolation' : 'docker on this machine',
      },
    },
    default: name,
  };
}

let config: SandboxConfig = envConfig();

export async function initSandboxConfig(path: string): Promise<SandboxConfig> {
  const fromFile = await loadConfig(path);
  // builtinConfig() is what loadConfig returns when the file is absent; in that
  // case the environment is the more specific answer.
  const fileExists = JSON.stringify(fromFile) !== JSON.stringify(builtinConfig());
  config = fileExists ? fromFile : envConfig();
  drivers.clear();
  live.clear();
  return config;
}

/** Overrides the config in-process. Used by tests. */
export function setSandboxConfig(cfg: SandboxConfig): void {
  config = cfg;
  drivers.clear();
  live.clear();
}

export function sandboxConfig(): SandboxConfig {
  return config;
}

const drivers = new Map<string, SandboxDriver>();

function driverFor(name: string, target: SandboxTarget): SandboxDriver {
  let d = drivers.get(name);
  if (!d) {
    d = target.kind === 'local' ? localDriver : makeDockerDriver(name, target);
    drivers.set(name, d);
  }
  return d;
}

/**
 * Cached per (target, owner): the same owner on two targets has two separate
 * computers, with separate files and logins. Switching a bot's target is
 * therefore a move to a different machine, not a reconnection to the same one.
 */
const live = new Map<string, Promise<Sandbox>>();

export function getSandbox(ownerId: string, targetName?: string | null): Promise<Sandbox> {
  // Resolution failures come back as a rejection, not a synchronous throw, so a
  // caller holding only a promise cannot miss them.
  let resolved: { name: string; target: SandboxTarget };
  try {
    resolved = resolveTarget(config, targetName);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const { name, target } = resolved;
  const key = `${name}::${ownerId}`;

  let s = live.get(key);
  if (!s) {
    s = driverFor(name, target)
      .acquire(ownerId)
      .catch((e) => {
        live.delete(key);
        throw e;
      });
    live.set(key, s);
  }
  return s;
}

/** Drops the cached handle so the next acquire re-resolves. */
export function forgetSandbox(ownerId: string, targetName?: string | null): void {
  const { name } = resolveTarget(config, targetName);
  live.delete(`${name}::${ownerId}`);
}
