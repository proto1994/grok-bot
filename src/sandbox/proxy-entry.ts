/**
 * Entrypoint for the egress proxy *container*.
 *
 * Runs with `node --experimental-strip-types` against the same sources the
 * orchestrator uses, so there is only ever one copy of the filtering logic.
 *
 * Policy arrives as JSON in EGRESS_POLICY. Denials go to stdout so
 * `docker logs` is the operator's record of what was refused.
 */
import { describePolicy, loadPolicy } from './egress.ts';
import { startEgressProxy } from './proxy.ts';

const policy = loadPolicy(JSON.parse(process.env.EGRESS_POLICY ?? '{}'));
const port = Number(process.env.PROXY_PORT ?? 8888);

const handle = await startEgressProxy(policy, {
  host: '0.0.0.0',
  port,
  onDeny: (host) => console.log(`[deny] ${host}`),
});

console.log(`egress proxy on :${handle.port} — ${describePolicy(policy)}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void handle.close().then(() => process.exit(0));
  });
}
