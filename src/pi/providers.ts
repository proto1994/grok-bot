/**
 * Provider catalogue and the wire shape of a model call.
 *
 * PI already speaks both APIs this app cares about (`anthropic-messages` and
 * `openai-completions`). What it does not do is remember a user's providers:
 * that used to be three environment variables and a file we generated at
 * startup. This module is the bit in between. It knows the presets, how a
 * stored provider becomes the models.json PI reads, and how a "test
 * connection" request is shaped — the same URL, auth header, and token field
 * PI will use for real calls.
 *
 * API keys are never put in that file. PI interpolates `$ENV_NAME` at request
 * time, so the value stays in the process environment (set from the store) and
 * in sqlite, and nowhere a log line or a repo would pick it up.
 */

export type ApiStyle = 'anthropic-messages' | 'openai-chat-completions';

export const API_STYLES: ApiStyle[] = ['anthropic-messages', 'openai-chat-completions'];

/** What PI calls the OpenAI Chat Completions API. */
export type PiApi = 'anthropic-messages' | 'openai-completions';

export interface ProviderModel {
  modelId: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ProviderRecord {
  id: string;
  name: string;
  preset: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  /** Raw secret. Never send this to a client and never log it. */
  apiKey: string;
  models: ProviderModel[];
  createdAt: number;
  updatedAt: number;
}

/** What the UI is allowed to see. `apiKey` is absent on purpose. */
export interface ProviderPublic {
  id: string;
  name: string;
  preset: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  hasKey: boolean;
  apiKeyMask: string;
  models: ProviderModel[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Compatibility flags written into models.json.
 *
 * Only fields PI's schema accepts. Anything else makes the whole file fail to
 * load, which looks like "no models" rather than a bad flag.
 */
export interface OpenAICompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'qwen';
  requiresReasoningContentOnAssistantMessages?: boolean;
}

export interface PresetModel extends ProviderModel {}

export interface Preset {
  id: string;
  label: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  models: PresetModel[];
  hint: string;
  /** Local servers that ignore the key. The form may leave it blank. */
  keyOptional?: boolean;
}

const TEXT = 128_000;
const OUT = 8_192;

export const PRESETS: Preset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://api.openai.com/v1',
    hint: '官方接口。Key 在 platform.openai.com。',
    models: [
      { modelId: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1_047_576, maxTokens: 32_768, reasoning: false },
      { modelId: 'gpt-4o', name: 'GPT-4o', contextWindow: TEXT, maxTokens: 16_384, reasoning: false },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://api.deepseek.com',
    hint: 'OpenAI 兼容。Key 在 platform.deepseek.com。deepseek-chat 支持工具调用。',
    models: [
      { modelId: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
      { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: TEXT, maxTokens: OUT, reasoning: true },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    apiStyle: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    hint: '官方 Messages 接口。Key 在 console.anthropic.com。',
    models: [
      { modelId: 'claude-sonnet-5-5', name: 'Claude Sonnet', contextWindow: 200_000, maxTokens: 32_000, reasoning: true },
      { modelId: 'claude-haiku-4-5', name: 'Claude Haiku', contextWindow: 200_000, maxTokens: 32_000, reasoning: true },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    hint: 'Kimi 的 OpenAI 兼容接口。国际站把地址换成 https://api.moonshot.ai/v1。',
    models: [
      { modelId: 'moonshot-v1-128k', name: 'Moonshot 128K', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
      { modelId: 'kimi-latest', name: 'Kimi', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
    ],
  },
  {
    id: 'qwen',
    label: 'Qwen / DashScope',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    hint: '通义千问的兼容模式。Key 是 DashScope 的 API-KEY。',
    models: [
      { modelId: 'qwen-plus', name: 'Qwen Plus', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
      { modelId: 'qwen-max', name: 'Qwen Max', contextWindow: 32_768, maxTokens: OUT, reasoning: false },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    hint: '一个 key 路由到多家模型。模型 id 形如 deepseek/deepseek-chat。',
    models: [
      { modelId: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
      { modelId: 'openai/gpt-4.1', name: 'GPT-4.1', contextWindow: 1_047_576, maxTokens: 32_768, reasoning: false },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    hint: '本机模型。Key 可以留空，Ollama 不校验。',
    keyOptional: true,
    models: [
      { modelId: 'llama3.1', name: 'Llama 3.1', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
    ],
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    apiStyle: 'openai-chat-completions',
    baseUrl: '',
    hint: 'DeepSeek、vLLM、LM Studio，或任何带 /chat/completions 的网关。Base URL 写到版本前缀为止，例如 http://127.0.0.1:8000/v1。',
    keyOptional: true,
    models: [
      { modelId: '', name: '', contextWindow: TEXT, maxTokens: OUT, reasoning: false },
    ],
  },
];

const PRESET_IDS = new Set([...PRESETS.map((p) => p.id), 'ada']);

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** PI's name for the API. The UI says openai-chat-completions; PI says openai-completions. */
export function piApi(style: ApiStyle): PiApi {
  return style === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions';
}

/**
 * Env var PI interpolates for this provider's key.
 *
 * The id is a uuid, which is not a legal env name, so it is flattened. The
 * name is stable for a provider: rewriting models.json keeps pointing at the
 * same variable.
 */
export function envName(providerId: string): string {
  return `GB_KEY_${providerId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()}`;
}

/**
 * Flags for an OpenAI-compatible server that is not OpenAI.
 *
 * Official OpenAI gets no override: PI's own defaults (developer role,
 * max_completion_tokens) are right there and wrong everywhere else. A custom
 * endpoint is assumed to be the lowest common denominator — system role,
 * max_tokens, no strict tools — which is what DeepSeek, Ollama, and most
 * self-hosted gateways actually accept. Known hosts get the extra flag that
 * makes their reasoning survive a replay.
 */
export function compatFor(p: { preset: string; apiStyle: ApiStyle; baseUrl: string }): OpenAICompat | undefined {
  if (p.apiStyle !== 'openai-chat-completions') return undefined;
  const url = p.baseUrl.toLowerCase();
  const deepseek = p.preset === 'deepseek' || url.includes('deepseek.com');
  const moonshot = p.preset === 'moonshot' || url.includes('api.moonshot.');
  const openrouter = p.preset === 'openrouter' || url.includes('openrouter.ai');
  const qwen = p.preset === 'qwen' || url.includes('dashscope');
  const ollama = p.preset === 'ollama' || url.includes(':11434');
  const official = p.preset === 'openai' || url.includes('api.openai.com');

  if (official && !deepseek && !moonshot && !openrouter && !qwen && !ollama) return undefined;

  if (deepseek) {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      supportsStrictMode: true,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    };
  }
  if (openrouter) {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'openrouter',
    };
  }
  if (qwen) {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'qwen',
    };
  }
  if (moonshot) {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    };
  }
  // Ollama and anything else. stream_options is off: older local servers
  // reject the field outright, and a test connection that 400s on it is worse
  // than a missing usage number.
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: ollama ? false : true,
    supportsStrictMode: false,
    maxTokensField: 'max_tokens',
  };
}

/** The models.json document. Keys are `$ENV` references, never the secret. */
export function modelsDocument(providers: ProviderRecord[]): { providers: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  for (const p of providers) {
    if (!p.models.length || !p.baseUrl) continue;
    const compat = compatFor(p);
    out[p.id] = {
      baseUrl: p.baseUrl,
      api: piApi(p.apiStyle),
      apiKey: `$${envName(p.id)}`,
      ...(compat ? { compat } : {}),
      models: p.models.map((m) => ({
        id: m.modelId,
        name: m.name || m.modelId,
        reasoning: m.reasoning,
        input: ['text'],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    };
  }
  return { providers: out };
}

/**
 * Puts each key where PI will interpolate it, and nowhere else.
 *
 * An empty key (Ollama) still needs a non-empty value: PI treats a model with
 * no auth as unavailable. The placeholder is not a credential.
 */
export function applySecrets(providers: ProviderRecord[]): void {
  for (const p of providers) {
    process.env[envName(p.id)] = p.apiKey || 'local';
  }
}

export function clearSecret(providerId: string): void {
  delete process.env[envName(providerId)];
}

/** First 4 and last 4. Short keys collapse entirely so the mask is not the key. */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function toPublic(p: ProviderRecord): ProviderPublic {
  return {
    id: p.id,
    name: p.name,
    preset: p.preset,
    apiStyle: p.apiStyle,
    baseUrl: p.baseUrl,
    hasKey: p.apiKey.length > 0,
    apiKeyMask: maskKey(p.apiKey),
    models: p.models.map((m) => ({ ...m })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Replaces every stored key that shows up in a string. Short values are left alone. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('•••');
  }
  return out;
}

export class ProviderInputError extends Error {}

export interface ParsedProvider {
  name: string;
  preset: string;
  apiStyle: ApiStyle;
  baseUrl: string;
  /** Undefined when the client did not send a key (keep the stored one). */
  apiKey: string | undefined;
  models: ProviderModel[];
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? v as Record<string, unknown> : {};
}

/**
 * Turns a request body into something the store can write.
 *
 * `apiKey` stays undefined when the field was omitted, so an edit that only
 * changes the model list does not wipe the secret. Sending the current mask
 * is treated the same way: the UI shows the mask as a placeholder, and a
 * client that echoes it back must not overwrite the real key with the mask.
 */
export function parseProviderBody(body: unknown, existingKey?: string): ParsedProvider {
  const b = asObject(body);
  const name = String(b.name ?? '').trim();
  if (!name) throw new ProviderInputError('需要一个名字');
  if (name.length > 80) throw new ProviderInputError('名字太长');

  const preset = String(b.preset ?? 'custom').trim() || 'custom';
  if (!PRESET_IDS.has(preset)) throw new ProviderInputError(`未知的预设：${preset}`);

  const apiStyle = String(b.apiStyle ?? '') as ApiStyle;
  if (!API_STYLES.includes(apiStyle)) {
    throw new ProviderInputError('接口只能是 anthropic-messages 或 openai-chat-completions');
  }

  const baseUrl = String(b.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new ProviderInputError('需要 Base URL');
  if (baseUrl.length > 500) throw new ProviderInputError('Base URL 太长');
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProviderInputError('Base URL 不是合法的地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderInputError('Base URL 只能是 http 或 https');
  }

  let apiKey: string | undefined;
  if (b.apiKey === undefined || b.apiKey === null) {
    apiKey = undefined;
  } else {
    apiKey = String(b.apiKey);
    if (apiKey.length > 4000) throw new ProviderInputError('API key 太长');
    // The mask is what we showed them. Echoing it means "leave the key alone".
    if (existingKey && apiKey === maskKey(existingKey)) apiKey = undefined;
  }

  if (!Array.isArray(b.models) || b.models.length === 0) {
    throw new ProviderInputError('至少要有一个模型');
  }
  if (b.models.length > 40) throw new ProviderInputError('模型太多了');

  const seen = new Set<string>();
  const models: ProviderModel[] = b.models.map((raw, i) => {
    const m = asObject(raw);
    const modelId = String(m.modelId ?? '').trim();
    if (!modelId) throw new ProviderInputError(`第 ${i + 1} 个模型缺少 id`);
    if (modelId.length > 200) throw new ProviderInputError(`模型 id 太长：${modelId.slice(0, 40)}`);
    if (seen.has(modelId)) throw new ProviderInputError(`模型 id 重复：${modelId}`);
    seen.add(modelId);
    const contextWindow = Number(m.contextWindow ?? 128_000);
    const maxTokens = Number(m.maxTokens ?? 8_192);
    if (!Number.isFinite(contextWindow) || contextWindow < 1_024 || contextWindow > 10_000_000) {
      throw new ProviderInputError(`${modelId} 的上下文长度不合法`);
    }
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 2_000_000) {
      throw new ProviderInputError(`${modelId} 的最大输出不合法`);
    }
    const display = String(m.name ?? '').trim() || modelId;
    return {
      modelId,
      name: display.slice(0, 80),
      contextWindow: Math.floor(contextWindow),
      maxTokens: Math.floor(maxTokens),
      reasoning: m.reasoning === true || m.reasoning === 1,
    };
  });

  return { name, preset, apiStyle, baseUrl, apiKey, models };
}

/** Joins the way the OpenAI and Anthropic SDKs do: base plus an absolute path. */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  return b + (path.startsWith('/') ? path : `/${path}`);
}

export interface ShapedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * The request a connection test sends.
 *
 * It is deliberately the same shape PI uses for a one-token completion: the
 * path, the auth header, and the token-limit field. A server that answers this
 * will answer a real turn. Tool calls are not part of the probe — those are
 * exercised by driving PI itself.
 */
export function connectionRequest(p: {
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  preset: string;
}): ShapedRequest {
  if (p.apiStyle === 'anthropic-messages') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (p.apiKey) headers['x-api-key'] = p.apiKey;
    return {
      url: joinUrl(p.baseUrl, '/v1/messages'),
      headers,
      body: {
        model: p.modelId,
        max_tokens: 1,
        stream: false,
        messages: [{ role: 'user', content: 'ping' }],
      },
    };
  }

  const compat = compatFor(p);
  const tokenField = compat?.maxTokensField ?? 'max_completion_tokens';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
  return {
    url: joinUrl(p.baseUrl, '/chat/completions'),
    headers,
    body: {
      model: p.modelId,
      [tokenField]: 1,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    },
  };
}

/**
 * Asks the provider for a one-token reply and reports whether it answered.
 *
 * The detail string is what the UI shows. It is passed through redact so a
 * gateway that echoes the key in an error body does not end up on screen or
 * in the log.
 */
export async function testConnection(p: {
  apiStyle: ApiStyle;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  preset: string;
}): Promise<{ ok: boolean; detail: string }> {
  const req = connectionRequest(p);
  const secret = p.apiKey ? [p.apiKey] : [];
  const clean = (s: string) => redact(s, secret).slice(0, 400);
  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: clean(`鉴权失败（${res.status}）。检查 API key。${snippet(text)}`) };
    }
    if (res.ok) return { ok: true, detail: `已连通（${res.status}）` };
    return { ok: false, detail: clean(`服务返回 ${res.status}。${snippet(text)}`) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: clean(`连不上：${msg}`) };
  }
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return ` ${t.slice(0, 180)}`;
}
