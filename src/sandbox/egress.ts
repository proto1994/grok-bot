/**
 * Egress policy for sandbox traffic.
 *
 * Two paths leave this system and they need separate controls:
 *
 *   1. the sandbox computer  — covered here, enforced by the proxy in proxy.ts
 *   2. remote MCP servers    — dialled from the orchestrator, NOT from the
 *                              sandbox, so this policy does not cover them.
 *                              See applyToMcp below.
 *
 * Treating those as one perimeter is the mistake to avoid: blocking a service's
 * MCP server does not block its website, and vice versa.
 */

export type EgressMode = 'allow_all' | 'defaults_plus_allowlist' | 'allowlist_only';

export interface EgressPolicy {
  mode: EgressMode;
  /** Hostnames or suffix patterns: "example.com" matches "api.example.com". */
  allowed: string[];
  /** When true, the orchestrator holds remote MCP servers to `allowed` too. */
  applyToMcp: boolean;
}

/** What a sandbox needs to be a working computer at all. */
export const DEFAULT_DESTINATIONS = [
  'registry.npmjs.org',
  'nodejs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'codeload.github.com',
  'api.github.com',
  'deb.debian.org',
  'security.debian.org',
];

export const DEFAULT_POLICY: EgressPolicy = {
  mode: 'allow_all',
  allowed: [],
  applyToMcp: false,
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

/** Suffix match on label boundaries: "example.com" allows "api.example.com"
 *  but never "notexample.com". */
export function hostMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (!p || !h) return false;
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h.endsWith('.' + p);
}

export function isAllowed(policy: EgressPolicy, host: string): boolean {
  if (policy.mode === 'allow_all') return true;
  const lists =
    policy.mode === 'defaults_plus_allowlist'
      ? [...DEFAULT_DESTINATIONS, ...policy.allowed]
      : policy.allowed;
  return lists.some((p) => hostMatches(p, host));
}

/** Destinations the orchestrator may dial for remote MCP servers. */
export function mcpAllowed(policy: EgressPolicy, host: string): boolean {
  // An allowlist mode does not restrict MCP servers unless this is turned on.
  // Stated plainly because assuming otherwise is the dangerous default.
  if (!policy.applyToMcp) return true;
  return isAllowed(policy, host);
}

export function loadPolicy(raw: unknown): EgressPolicy {
  if (!raw || typeof raw !== 'object') return DEFAULT_POLICY;
  const o = raw as Record<string, unknown>;
  const mode = o.mode;
  if (mode !== 'allow_all' && mode !== 'defaults_plus_allowlist' && mode !== 'allowlist_only') {
    throw new Error(`unknown egress mode: ${String(mode)}`);
  }
  return {
    mode,
    allowed: Array.isArray(o.allowed) ? o.allowed.map(String) : [],
    applyToMcp: o.applyToMcp === true,
  };
}

export function describePolicy(p: EgressPolicy): string {
  if (p.mode === 'allow_all') return 'allow all destinations';
  const n = p.allowed.length;
  const base = p.mode === 'defaults_plus_allowlist' ? `defaults + ${n} entry(s)` : `${n} entry(s) only`;
  return `${base}; MCP ${p.applyToMcp ? 'held to the same list' : 'NOT restricted'}`;
}
