import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { store } from '../agent/store.ts';
import {
  applySecrets, clearSecret, modelsDocument, redact, type ProviderModel, type ProviderRecord,
} from './providers.ts';

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
 * Models confirmed present on the internal gateway's /v1/models listing.
 *
 * There is no baked-in base URL. The address is deployment detail, and a
 * fallback here would leak an internal hostname into the repo and silently
 * point a misconfigured install at it. ADA_BASE_URL supplies it, once, when
 * the store is still empty.
 */
export const ADA_MODELS: GatewayModel[] = [
  /*
   * reasoning: true on all three, and it is not cosmetic.
   *
   * pi only asks the provider for thinking when the model is declared capable
   * of it, so with this false the thinkingLevel below is accepted and then
   * ignored — and the model wrote its reasoning into the reply instead. Real
   * replies opened with "I should keep my response short and wait for the user
   * to reply."; 12 of 53 in one database did something like it.
   *
   * The gateway still returns only text blocks, never a thinking block, so the
   * reasoning is kept server-side rather than handed to us. Absence of
   * narration is the only observable, and it needs both this and a thinking
   * level above 'off' — three runs each of all four combinations put narration
   * in every one except both-set.
   */
  {
    id: 'kr-claude-opus-5.5',
    name: 'Opus 5.5 (ada)',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    reasoning: true,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: 'kr-claude-sonnet-5.5',
    name: 'Sonnet 5.5 (ada)',
    contextWindow: 1_000_000,
    maxTokens: 32_000,
    reasoning: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5 (ada)',
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
];

const NO_MODEL =
  '还没有默认模型。打开侧边栏的「模型」，添加一个提供商并设为默认；' +
  '或者在 .env 里留下原来的 ADA_TOKEN 和 ADA_BASE_URL（或 ANTHROPIC_API_KEY），首次启动会导入。';

/**
 * Imports the previous .env configuration the first time the store is empty.
 *
 * ADA_TOKEN wins when both are set, because that is the path a running install
 * was actually calling. The Anthropic key is imported alongside it so it is
 * not thrown away, but it does not become the default out from under the gateway.
 */
export function seedFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (store.countProviders() > 0) return;

  let madeDefault = false;

  if (env.ADA_TOKEN && env.ADA_BASE_URL) {
    const models: ProviderModel[] = ADA_MODELS.map((m) => ({
      modelId: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning ?? false,
    }));
    const wanted = env.PI_MODEL?.trim();
    if (wanted && !models.some((m) => m.modelId === wanted)) {
      models.unshift({
        modelId: wanted, name: wanted, contextWindow: 1_000_000, maxTokens: 32_000, reasoning: true,
      });
    }
    const p = store.createProvider({
      name: 'Gateway',
      preset: 'ada',
      apiStyle: 'anthropic-messages',
      baseUrl: env.ADA_BASE_URL.replace(/\/+$/, ''),
      apiKey: env.ADA_TOKEN,
      models,
    });
    const modelId = wanted && p.models.some((m) => m.modelId === wanted)
      ? wanted
      : p.models[0]!.modelId;
    store.setDefaultModel(p.id, modelId);
    madeDefault = true;
    // The name of the variable, never its value.
    console.log('models        seeded a provider from ADA_TOKEN');
  }

  if (env.ANTHROPIC_API_KEY) {
    const modelId = env.MODEL_ID?.trim() || 'claude-sonnet-5-5';
    const p = store.createProvider({
      name: 'Anthropic',
      preset: 'anthropic',
      apiStyle: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: env.ANTHROPIC_API_KEY,
      models: [{
        modelId, name: modelId, contextWindow: 200_000, maxTokens: 32_000, reasoning: true,
      }],
    });
    if (!madeDefault) {
      store.setDefaultModel(p.id, modelId);
      console.log('models        seeded a provider from ANTHROPIC_API_KEY');
    } else {
      console.log('models        also imported ANTHROPIC_API_KEY');
    }
  }
}

/** Seeds from the environment when the store has nothing yet. */
export function ensureProviders(): void {
  seedFromEnv(process.env);
}

/**
 * Writes the models.json PI reads and points each `$ENV` reference at the key
 * in the store. Returns the file path.
 */
export function writeModelsConfig(dir: string): string {
  ensureProviders();
  const providers = store.listProviders();
  applySecrets(providers);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'models.json');
  writeFileSync(file, JSON.stringify(modelsDocument(providers), null, 2), 'utf8');
  return file;
}

export function forgetProviderSecret(providerId: string): void {
  clearSecret(providerId);
}

/** Which provider and model a bot should call. Throws a message a person can act on. */
export function resolveSelection(bot: { providerId: string | null; modelId: string | null }): {
  providerId: string;
  modelId: string;
} {
  ensureProviders();
  if (store.countProviders() === 0) {
    if (process.env.ADA_TOKEN && !process.env.ADA_BASE_URL && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('ADA_TOKEN is set but ADA_BASE_URL is not. Put the gateway base URL in .env, or add a provider in the UI.');
    }
    throw new Error(NO_MODEL);
  }

  if (bot.providerId && bot.modelId) {
    const p = store.getProvider(bot.providerId);
    if (p?.models.some((m) => m.modelId === bot.modelId)) {
      return { providerId: p.id, modelId: bot.modelId };
    }
    throw new Error('这个 Bot 选的模型已经不在了。在它的设置里重选一个。');
  }

  const d = store.getDefaultModel();
  const provider = d ? store.getProvider(d.providerId) : undefined;
  if (!d || !provider?.models.some((m) => m.modelId === d.modelId)) {
    throw new Error(NO_MODEL);
  }
  return d;
}

export function redactSecrets(text: string): string {
  return redact(text, store.providerSecrets());
}

/** For logs at startup. Names and model ids only. */
export function describeModels(): string {
  ensureProviders();
  const all = store.listProviders();
  if (!all.length) return 'none';
  const d = store.getDefaultModel();
  const def = d ? store.getProvider(d.providerId) : undefined;
  const label = def ? `${def.name} / ${d!.modelId}` : 'no default';
  return `${all.length} provider(s), default ${label}`;
}

export type { ProviderRecord };
