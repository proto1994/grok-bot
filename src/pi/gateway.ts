import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Model provider config for PI, in its models.json format.
 *
 * The API key is written as `$ENV_NAME`, which PI interpolates at load time, so
 * the token never lands in a file we generate or in a repo.
 */

export interface GatewayModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/**
 * Where the gateway lives. Required, with no default: the URL is deployment
 * detail, and a fallback baked in here would both leak an internal hostname
 * into the repo and silently point a misconfigured install at it.
 */
export const ADA_BASE_URL = process.env.ADA_BASE_URL ?? '';
export const ADA_TOKEN_ENV = 'ADA_TOKEN';

/** Models confirmed present on the gateway's /v1/models listing. */
export const ADA_MODELS: GatewayModel[] = [
  {
    id: 'kr-claude-opus-5.5',
    name: 'Opus 5.5 (ada)',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: 'kr-claude-sonnet-5.5',
    name: 'Sonnet 5.5 (ada)',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5 (ada)',
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
];

export const DEFAULT_PROVIDER = 'ada';
export const DEFAULT_MODEL = process.env.PI_MODEL ?? 'kr-claude-opus-5.5';

export function gatewayConfig() {
  return {
    providers: {
      [DEFAULT_PROVIDER]: {
        baseUrl: ADA_BASE_URL,
        api: 'anthropic-messages',
        apiKey: `$${ADA_TOKEN_ENV}`,
        models: ADA_MODELS.map((m) => ({
          ...m,
          reasoning: m.reasoning ?? false,
          input: ['text'],
        })),
      },
    },
  };
}

/** Writes the config PI reads. Returns its path. */
export function writeGatewayConfig(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gateway.json');
  writeFileSync(p, JSON.stringify(gatewayConfig(), null, 2), 'utf8');
  return p;
}

export function assertToken(): void {
  if (!process.env[ADA_TOKEN_ENV]) {
    throw new Error(
      `${ADA_TOKEN_ENV} is not set. Put it in .env — it is interpolated into PI's ` +
        `model config at load time and is never written to disk by us.`,
    );
  }
  if (!ADA_BASE_URL) {
    throw new Error('ADA_BASE_URL is not set. Put your gateway\'s base URL in .env.');
  }
}
