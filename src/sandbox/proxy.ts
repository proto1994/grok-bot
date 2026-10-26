import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import { isAllowed, type EgressPolicy } from './egress.ts';

/**
 * Filtering forward proxy. The sandbox gets HTTP(S)_PROXY pointed here and no
 * other route out, so every request names its destination before it opens.
 *
 * For HTTPS this only ever sees the CONNECT host — not the path, not the body.
 * That is the right granularity: a host allowlist, enforced without terminating
 * TLS, so nothing here can read the traffic it is gating.
 */

export interface ProxyHandle {
  port: number;
  /** Replaces the policy for new connections; existing tunnels are unaffected. */
  setPolicy(p: EgressPolicy): void;
  denials(): { host: string; at: number }[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

export async function startEgressProxy(
  initial: EgressPolicy,
  opts: { host?: string; port?: number; onDeny?: (host: string) => void } = {},
): Promise<ProxyHandle> {
  let policy = initial;
  const denials: { host: string; at: number }[] = [];

  const deny = (host: string) => {
    denials.push({ host, at: Date.now() });
    if (denials.length > 500) denials.shift();
    opts.onDeny?.(host);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP through a proxy uses an absolute-form request target.
    let host: string;
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      host = target.hostname;
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('this proxy requires an absolute request target\n');
      return;
    }

    if (!isAllowed(policy, host)) {
      deny(host);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`egress policy: ${host} is not in the allowlist\n`);
      return;
    }

    const upstream = net.connect(
      Number(target.port || 80),
      host,
      () => {
        const path = target.pathname + target.search;
        const headers = Object.entries(req.headers)
          .filter(([k]) => k.toLowerCase() !== 'proxy-connection')
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n');
        upstream.write(`${req.method} ${path} HTTP/1.1\r\n${headers}\r\n\r\n`);
        req.pipe(upstream);
        upstream.pipe(res.socket!);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('upstream connection failed\n');
      } else res.destroy();
    });
  });

  // HTTPS: tunnel bytes after checking the host, never terminating TLS.
  server.on('connect', (req: IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    const [rawHost, rawPort] = (req.url ?? '').split(':');
    const host = rawHost ?? '';
    const port = Number(rawPort || 443);

    if (!host || !isAllowed(policy, host)) {
      if (host) deny(host);
      clientSocket.end(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n' +
          `egress policy: ${host || 'unknown host'} is not in the allowlist\n`,
      );
      return;
    }

    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    port,
    setPolicy: (p) => {
      policy = p;
    },
    denials: () => [...denials],
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
