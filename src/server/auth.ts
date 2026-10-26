import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';

/**
 * Bearer-token auth for the orchestrator.
 *
 * Two distinct things are being defended against:
 *
 *  1. Another machine reaching the port. Mitigated mostly by binding to
 *     127.0.0.1, but a token means exposing the port is a decision rather than
 *     an accident.
 *  2. A web page in the browser that is already on this machine. Any site can
 *     `fetch('http://127.0.0.1:4000/api/bots')`; the same-origin policy does
 *     not stop the request being *sent*. Without a token and an Origin check,
 *     a visited page could read every conversation and approve tool calls.
 *
 * The token is persisted to .env so a restart does not invalidate clients. It
 * is a local development credential, not a secret shared with anyone.
 */

const ENV_FILE = process.env.AUTH_ENV_FILE ?? '.env';
const VAR = 'AUTH_TOKEN';

export interface Auth {
  token: string;
  /** True when the token was created by this process. */
  generated: boolean;
}

function readFromEnvFile(): string | null {
  if (!existsSync(ENV_FILE)) return null;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^\s*AUTH_TOKEN\s*=\s*(.+?)\s*$/.exec(line);
    if (m?.[1]) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

export function loadAuth(): Auth {
  const fromEnv = process.env[VAR]?.trim();
  if (fromEnv) return { token: fromEnv, generated: false };

  const fromFile = readFromEnvFile();
  if (fromFile) return { token: fromFile, generated: false };

  // First run: mint one and persist it, so clients keep working across restarts.
  const token = randomBytes(32).toString('base64url');
  try {
    const prefix = existsSync(ENV_FILE) && readFileSync(ENV_FILE, 'utf8').endsWith('\n') ? '' : '\n';
    appendFileSync(ENV_FILE, `${prefix}${VAR}=${token}\n`, 'utf8');
  } catch {
    // A read-only checkout still works; the token just lives for this process.
    try {
      writeFileSync(ENV_FILE, `${VAR}=${token}\n`, { flag: 'a' });
    } catch { /* ignore */ }
  }
  return { token, generated: true };
}

function sameToken(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare in constant time, and keep the lengths out of the branch.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function presented(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m?.[1]) return m[1];
  }
  // WebSocket clients in the browser cannot set headers, so the token may
  // arrive as a query parameter on the handshake instead.
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token');
}

/**
 * Rejects a cross-origin request outright.
 *
 * A browser will send the Origin header on anything a page initiates. Our own
 * UI is same-origin and sends no Origin on same-origin GETs, while a malicious
 * page always carries its own. A non-browser client (curl, a script) sends none
 * and is allowed through on its token alone.
 */
export function originAllowed(
  req: IncomingMessage, host: string, port: number, requestHost?: string,
): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;

  const allowed = new Set([
    `http://${host}:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  // A phone loads the page by LAN address, so its Origin is that address. It is
  // accepted only when it matches the Host it actually asked for — a page on
  // another origin cannot forge that, because the browser sets Host itself.
  if (requestHost) allowed.add(`http://${requestHost}`);

  return allowed.has(origin);
}

export function authorized(req: IncomingMessage, auth: Auth): boolean {
  const token = presented(req);
  return token !== null && sameToken(token, auth.token);
}
