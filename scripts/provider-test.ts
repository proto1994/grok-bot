/**
 * Provider configuration, offline.
 *
 * Store CRUD, env seeding, key masking, the models.json PI actually loads, and
 * both wire shapes. The OpenAI-compatible path is then driven through the real
 * runner against a local fake server: streaming, tool calls, the approval
 * gate, ask_choice, schedule_routine, and context summarization.
 *
 *   pnpm tsx scripts/provider-test.ts
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DB = './data/test/provider-test.db';
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
rmSync('./data/test/provider-workspaces', { recursive: true, force: true });

const agentDir = mkdtempSync(path.join(tmpdir(), 'provider-agent-'));
mkdirSync(agentDir, { recursive: true });
writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 1 },
  retry: { enabled: false, maxRetries: 0 },
}));

// Hermetic: a developer shell may have real keys. Seeding is tested with an
// explicit env object, and the runner must not import whatever is in this
// process.
for (const k of ['ADA_TOKEN', 'ADA_BASE_URL', 'PI_MODEL', 'ANTHROPIC_API_KEY', 'MODEL_ID']) {
  delete process.env[k];
}

process.env.DB_PATH = DB;
process.env.SANDBOX_DRIVER = 'local';
process.env.SANDBOX_ALLOW_LOCAL = '1';
process.env.LOCAL_SANDBOX_ROOT = './data/test/provider-workspaces';
process.env.PI_OFFLINE = '1';
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CONFIG_DIR = path.join(agentDir, 'pi-config');

const { store } = await import('../src/agent/store.ts');
const {
  connectionRequest, maskKey, modelsDocument, redact, toPublic,
} = await import('../src/pi/providers.ts');
const { seedFromEnv, writeModelsConfig } = await import('../src/pi/gateway.ts');

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
};

const SECRET = 'sk-test-secret-value-abc123';
const logs: string[] = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...a: unknown[]) => {
  logs.push(a.map(String).join(' '));
  origLog(...a);
};
console.error = (...a: unknown[]) => {
  logs.push(a.map(String).join(' '));
  origErr(...a);
};

console.log('env seeding');
await check('ADA_TOKEN and ADA_BASE_URL seed an anthropic-messages provider', () => {
  seedFromEnv({
    ADA_TOKEN: SECRET,
    ADA_BASE_URL: 'http://gateway.internal.example/',
    PI_MODEL: 'kr-claude-sonnet-5.5',
  });
  const all = store.listProviders();
  assert.equal(all.length, 1);
  const p = all[0]!;
  assert.equal(p.preset, 'ada');
  assert.equal(p.apiStyle, 'anthropic-messages');
  assert.equal(p.baseUrl, 'http://gateway.internal.example');
  assert.equal(p.apiKey, SECRET);
  assert.ok(p.models.some((m) => m.modelId === 'kr-claude-sonnet-5.5'));
  assert.deepEqual(store.getDefaultModel(), { providerId: p.id, modelId: 'kr-claude-sonnet-5.5' });
});

await check('a second seed does nothing while providers exist', () => {
  seedFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-should-not-appear', MODEL_ID: 'claude-sonnet-5-5' });
  assert.equal(store.listProviders().length, 1);
  assert.equal(store.listProviders()[0]!.apiKey, SECRET);
});

await check('the public view and the models file do not contain the key', () => {
  const p = store.listProviders()[0]!;
  const pub = JSON.stringify(toPublic(p));
  assert.equal(pub.includes(SECRET), false);
  assert.equal(toPublic(p).apiKeyMask, maskKey(SECRET));
  assert.equal(toPublic(p).hasKey, true);
  const dir = path.join(agentDir, 'models');
  const file = writeModelsConfig(dir);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.includes(SECRET), false, 'models.json must not contain the key');
  assert.match(text, /\$GB_KEY_[A-Z0-9]+/);
  assert.match(text, /"api": "anthropic-messages"/);
  assert.equal(logs.some((l) => l.includes(SECRET)), false, 'a log line contained the key');
});

await check('ANTHROPIC_API_KEY seeds when the store is empty, and both can coexist', () => {
  store.deleteProvider(store.listProviders()[0]!.id);
  assert.equal(store.countProviders(), 0);
  seedFromEnv({
    ADA_TOKEN: 'ada_other_secret_token',
    ADA_BASE_URL: 'http://gw.example',
    PI_MODEL: 'not-in-the-list',
    ANTHROPIC_API_KEY: 'sk-ant-other-secret',
    MODEL_ID: 'claude-sonnet-5-5',
  });
  const all = store.listProviders();
  assert.equal(all.length, 2);
  const ada = all.find((p) => p.preset === 'ada')!;
  const anth = all.find((p) => p.preset === 'anthropic')!;
  assert.ok(ada.models.some((m) => m.modelId === 'not-in-the-list'));
  assert.equal(anth.models[0]!.modelId, 'claude-sonnet-5-5');
  assert.equal(anth.baseUrl, 'https://api.anthropic.com');
  // The gateway stays the default. That is what the previous process called.
  assert.equal(store.getDefaultModel()?.providerId, ada.id);
  assert.equal(store.getDefaultModel()?.modelId, 'not-in-the-list');
  store.deleteProvider(ada.id);
  store.deleteProvider(anth.id);
});

await check('ANTHROPIC_API_KEY alone becomes the default', () => {
  seedFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-only-secret-xx', MODEL_ID: 'claude-haiku-4-5' });
  const p = store.listProviders()[0]!;
  assert.equal(p.apiStyle, 'anthropic-messages');
  assert.equal(store.getDefaultModel()?.modelId, 'claude-haiku-4-5');
  store.deleteProvider(p.id);
  assert.equal(store.getDefaultModel(), null);
});

console.log('store');
const created = store.createProvider({
  name: 'DeepSeek',
  preset: 'deepseek',
  apiStyle: 'openai-chat-completions',
  baseUrl: 'https://api.deepseek.com',
  apiKey: SECRET,
  models: [
    { modelId: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 128000, maxTokens: 8192, reasoning: true },
  ],
});
store.setDefaultModel(created.id, 'deepseek-chat');

await check('a short key masks to bullets, not a slice of itself', () => {
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(SECRET).includes(SECRET), false);
});

await check('updating without a new key keeps the old one', () => {
  const next = store.updateProvider(created.id, {
    ...created, name: 'DeepSeek renamed', apiKey: created.apiKey,
  });
  assert.equal(next?.name, 'DeepSeek renamed');
  assert.equal(next?.apiKey, SECRET);
});

await check('echoing the mask does not replace the key', async () => {
  const { parseProviderBody } = await import('../src/pi/providers.ts');
  const parsed = parseProviderBody({
    name: 'DeepSeek renamed',
    preset: 'deepseek',
    apiStyle: 'openai-chat-completions',
    baseUrl: 'https://api.deepseek.com',
    apiKey: maskKey(SECRET),
    models: created.models,
  }, SECRET);
  assert.equal(parsed.apiKey, undefined);
});

await check('a new key replaces, an empty key clears', () => {
  const swapped = store.updateProvider(created.id, { ...store.getProvider(created.id)!, apiKey: 'sk-rotated-secret-9999' });
  assert.equal(swapped?.apiKey, 'sk-rotated-secret-9999');
  const cleared = store.updateProvider(created.id, { ...swapped!, apiKey: '' });
  assert.equal(cleared?.apiKey, '');
  assert.equal(toPublic(cleared!).hasKey, false);
  store.updateProvider(created.id, { ...cleared!, apiKey: SECRET });
});

await check('redact strips the key from an error a gateway echoed', () => {
  const blown = redact(`auth failed for ${SECRET} at gateway`, [SECRET]);
  assert.equal(blown.includes(SECRET), false);
  assert.match(blown, /•••/);
});

await check('openai-chat-completions is shaped as chat completions with max_tokens', () => {
  const req = connectionRequest({
    apiStyle: 'openai-chat-completions', preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com/', apiKey: SECRET, modelId: 'deepseek-chat',
  });
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(req.body.model, 'deepseek-chat');
  assert.equal(req.body.stream, false);
  assert.equal(req.body.max_tokens, 1);
  assert.equal('max_completion_tokens' in req.body, false);
  const doc = modelsDocument([store.getProvider(created.id)!]);
  const entry = doc.providers[created.id] as { api: string; apiKey: string; compat: { thinkingFormat: string; maxTokensField: string } };
  assert.equal(entry.api, 'openai-completions');
  assert.equal(entry.apiKey.startsWith('$GB_KEY_'), true);
  assert.equal(entry.apiKey.includes(SECRET), false);
  assert.equal(entry.compat.thinkingFormat, 'deepseek');
  assert.equal(entry.compat.maxTokensField, 'max_tokens');
});

await check('anthropic-messages is shaped as /v1/messages with x-api-key', () => {
  const req = connectionRequest({
    apiStyle: 'anthropic-messages', preset: 'anthropic',
    baseUrl: 'https://api.anthropic.com', apiKey: SECRET, modelId: 'claude-sonnet-5-5',
  });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], SECRET);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal('authorization' in req.headers, false);
  assert.equal(req.body.max_tokens, 1);
  assert.equal(req.body.stream, false);
});

await check('official OpenAI uses max_completion_tokens', () => {
  const req = connectionRequest({
    apiStyle: 'openai-chat-completions', preset: 'openai',
    baseUrl: 'https://api.openai.com/v1', apiKey: SECRET, modelId: 'gpt-4.1',
  });
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.body.max_completion_tokens, 1);
  assert.equal('max_tokens' in req.body, false);
});

await check('dropping a model id releases bots that were using it', () => {
  const bot = store.createBot('local', 'Pinned', 'job');
  store.setBotModel(bot.id, created.id, 'deepseek-reasoner');
  store.setDefaultModel(created.id, 'deepseek-reasoner');
  const kept = store.getProvider(created.id)!;
  store.updateProvider(created.id, {
    ...kept,
    models: kept.models.filter((m) => m.modelId !== 'deepseek-reasoner'),
  });
  store.releaseBotsFromMissingModels(created.id, ['deepseek-chat']);
  assert.equal(store.getBot(bot.id)?.providerId, null);
  assert.equal(store.getBot(bot.id)?.modelId, null);
  if (store.getDefaultModel()?.modelId === 'deepseek-reasoner') {
    store.setDefaultModel(created.id, 'deepseek-chat');
  }
  store.updateProvider(created.id, { ...store.getProvider(created.id)!, models: kept.models });
});

await check('a bot model is cleared when its provider is deleted', () => {
  const bot = store.createBot('local', 'Keyed', 'job');
  store.setBotModel(bot.id, created.id, 'deepseek-chat');
  assert.equal(store.getBot(bot.id)?.modelId, 'deepseek-chat');
  const other = store.createProvider({
    name: 'Other', preset: 'custom', apiStyle: 'openai-chat-completions',
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-other-secret-value',
    models: [{ modelId: 'm', name: 'm', contextWindow: 8000, maxTokens: 1024, reasoning: false }],
  });
  store.setDefaultModel(other.id, 'm');
  store.deleteProvider(created.id);
  assert.equal(store.getBot(bot.id)?.providerId, null);
  assert.equal(store.getBot(bot.id)?.modelId, null);
  assert.equal(store.getDefaultModel()?.providerId, other.id);
  store.deleteProvider(other.id);
});

await check('PI accepts the generated models.json', async () => {
  const p = store.createProvider({
    name: 'Loaded', preset: 'custom', apiStyle: 'openai-chat-completions',
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET,
    models: [{ modelId: 'loaded-model', name: 'Loaded', contextWindow: 8000, maxTokens: 1024, reasoning: false }],
  });
  const file = writeModelsConfig(path.join(agentDir, 'load'));
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const rt = await ModelRuntime.create({ modelsPath: file, refreshOnCreate: false });
  const model = rt.getModel(p.id, 'loaded-model');
  assert.ok(model, rt.getError() ?? 'model missing');
  assert.equal(model!.api, 'openai-completions');
  assert.equal(readFileSync(file, 'utf8').includes(SECRET), false);
  store.deleteProvider(p.id);
});

interface Recorded {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw) as Record<string, unknown>); }
      catch (e) { reject(e); }
    });
  });
}

function listen(handler: (rec: Recorded, res: ServerResponse) => void) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const rec = { url: req.url ?? '', headers: req.headers, body };
    requests.push(rec);
    handler(rec, res);
  });
  return new Promise<{ port: number; requests: Recorded[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        requests,
        close: () => new Promise((done) => {
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

console.log('connection probe');
{
  const openai = await listen((rec, res) => {
    assert.equal(rec.headers.authorization, `Bearer ${SECRET}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
  });
  const { testConnection } = await import('../src/pi/providers.ts');
  await check('a probe hits /chat/completions and reports success', async () => {
    const r = await testConnection({
      apiStyle: 'openai-chat-completions', preset: 'custom',
      baseUrl: `http://127.0.0.1:${openai.port}/v1`, apiKey: SECRET, modelId: 'm',
    });
    assert.equal(r.ok, true, r.detail);
    assert.equal(openai.requests[0]!.url, '/v1/chat/completions');
    assert.equal(openai.requests[0]!.body.max_tokens, 1);
    assert.equal(JSON.stringify(openai.requests[0]!.body).includes(SECRET), false);
  });
  await openai.close();

  const anthropic = await listen((_rec, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bad key ${SECRET}` } }));
  });
  await check('an anthropic probe hits /v1/messages and the echoed key is redacted', async () => {
    const r = await testConnection({
      apiStyle: 'anthropic-messages', preset: 'anthropic',
      baseUrl: `http://127.0.0.1:${anthropic.port}`, apiKey: SECRET, modelId: 'claude',
    });
    assert.equal(r.ok, false);
    assert.equal(r.detail.includes(SECRET), false);
    assert.match(r.detail, /鉴权失败/);
    assert.equal(anthropic.requests[0]!.url, '/v1/messages');
    assert.equal(anthropic.requests[0]!.headers['x-api-key'], SECRET);
  });
  await anthropic.close();
}

function oaiChunk(delta: unknown, finish: string | null, usage?: Record<string, number>) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

function writeSse(res: ServerResponse, events: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function toolStream(name: string, args: unknown) {
  const id = `call_${name}`;
  return [
    oaiChunk({
      role: 'assistant', content: '',
      tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
    }, null),
    oaiChunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null),
    oaiChunk({}, 'tool_calls'),
    {
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
      choices: [], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    },
  ];
}

function textStream(text: string, usage: Record<string, number>) {
  return [
    oaiChunk({ role: 'assistant', content: text }, null),
    oaiChunk({}, 'stop'),
    {
      id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
      choices: [], usage,
    },
  ];
}

console.log('openai-compatible runner');
{
  let phase = 0;
  const seen: Recorded[] = [];
  const fake = await listen((rec, res) => {
    seen.push(rec);
    const blob = JSON.stringify(rec.body);
    if (blob.includes('structured context checkpoint') || blob.includes('<conversation>')) {
      writeSse(res, textStream('summary: a routine was scheduled', {
        prompt_tokens: 20, completion_tokens: 8, total_tokens: 28,
      }));
      return;
    }
    phase += 1;
    if (phase === 1) {
      writeSse(res, toolStream('ask_choice', { question: '先做哪件？', options: ['看日志', '先停一下'] }));
      return;
    }
    if (phase === 2) {
      writeSse(res, toolStream('schedule_routine', {
        title: '日报', prompt: '总结今天做了什么', time: '9:00', why: '每天看一眼',
      }));
      return;
    }
    writeSse(res, textStream('安排好了。', {
      prompt_tokens: 18000, completion_tokens: 2000, total_tokens: 20000,
    }));
  });

  const provider = store.createProvider({
    name: 'Fake', preset: 'custom', apiStyle: 'openai-chat-completions',
    baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: SECRET,
    models: [{
      modelId: 'fake-model', name: 'Fake', contextWindow: 1000, maxTokens: 1024, reasoning: false,
    }],
  });
  store.setDefaultModel(provider.id, 'fake-model');

  const { sessionFor, dropSession } = await import('../src/pi/runner.ts');
  const bot = store.createBot('prov', 'Wire', 'do the task');
  const session = await sessionFor(bot);
  const events: { type?: string }[] = [];
  const run = store.createRun(bot.id);

  const task = session.prompt('请开始。', run.id, (e) => events.push(e as { type?: string }));
  const timed = Promise.race([
    task,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
      `timed out after phases=${phase} requests=${seen.length} ` +
      seen.map((r) => (JSON.stringify(r.body).includes('structured context checkpoint') ? 'summary' : 'turn')).join(','),
    )), 40_000)),
  ]);

  let approval: ReturnType<typeof store.openApprovals>[number] | undefined;
  for (let i = 0; i < 80; i++) {
    approval = store.openApprovals('prov')[0];
    if (approval) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (approval) store.resolveApproval(approval.id, true);

  let promptError: unknown;
  try { await timed; } catch (e) { promptError = e; }

  await check('the run finished through the fake server', () => {
    if (promptError) throw promptError;
    assert.equal(store.getRun(run.id)!.status, 'done', store.getRun(run.id)?.error ?? '');
  });

  await check('the first request streams, names the model, and offers the tools', () => {
    const first = seen[0];
    assert.ok(first, 'no request reached the fake server');
    assert.equal(first.url, '/v1/chat/completions');
    assert.equal(first.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(first.body.stream, true);
    assert.equal(first.body.model, 'fake-model');
    assert.equal('max_completion_tokens' in first.body, false);
    const tools = (first.body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    for (const name of ['ask_choice', 'schedule_routine', 'bash', 'read', 'write', 'edit', 'ls']) {
      assert.ok(tools.includes(name), `missing ${name} in ${tools.join(',')}`);
    }
    assert.equal(JSON.stringify(first.body).includes(SECRET), false);
  });

  await check('ask_choice ran without an approval and reached the UI', () => {
    assert.ok(events.some((e) => e.type === 'question.asked'), 'question.asked was not emitted');
    const calls = store.listSteps(run.id).filter((s) => s.kind === 'tool_call' && s.tool === 'ask_choice');
    assert.ok(calls.length > 0, 'ask_choice was not called');
  });

  await check('schedule_routine was parked and then ran', () => {
    assert.ok(approval, 'schedule_routine was not parked');
    assert.equal(approval!.tool, 'schedule_routine');
    assert.ok(events.some((e) => e.type === 'approval.requested'));
    const routines = store.listRoutines(bot.id);
    assert.equal(routines.length, 1);
    assert.equal(routines[0]!.title, '日报');
  });

  await check('the reply arrived as streamed text', () => {
    // ask_choice already put the question on screen, so a later reply in the
    // same turn is withheld rather than shown twice. The note is the proof the
    // streamed text got here.
    const bodies = store.listSteps(run.id).map((s) => s.body).join('\n');
    assert.match(bodies, /安排好了/);
  });

  await check('context was summarized through the same endpoint', () => {
    const summary = seen.filter((r) => JSON.stringify(r.body).includes('structured context checkpoint')
      || JSON.stringify(r.body).includes('<conversation>'));
    assert.ok(summary.length > 0, `no summary request in ${seen.length} calls`);
    assert.equal(summary[0]!.body.stream, true);
    assert.equal(summary[0]!.url, '/v1/chat/completions');
    const notes = store.listSteps(run.id).filter((s) => s.kind === 'note').map((s) => s.body);
    assert.ok(notes.some((n) => n.includes('compacted')), notes.join(' | ') || '(no note)');
  });

  await dropSession(bot.id);
  await fake.close();
  store.deleteProvider(provider.id);
}

console.log('anthropic-messages runner');
{
  const seen: Recorded[] = [];
  const fake = await listen((rec, res) => {
    seen.push(rec);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'fake-claude',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    });
    send('content_block_start', {
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    });
    send('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'anthropic ok' },
    });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });

  const provider = store.createProvider({
    name: 'Fake Claude', preset: 'anthropic', apiStyle: 'anthropic-messages',
    baseUrl: `http://127.0.0.1:${fake.port}`, apiKey: SECRET,
    models: [{
      modelId: 'fake-claude', name: 'Fake Claude', contextWindow: 8000, maxTokens: 1024, reasoning: false,
    }],
  });
  store.setDefaultModel(provider.id, 'fake-claude');
  const { sessionFor, dropSession } = await import('../src/pi/runner.ts');
  const bot = store.createBot('prov', 'Anth', 'reply');
  const session = await sessionFor(bot);
  const run = store.createRun(bot.id);
  let promptError: unknown;
  try {
    await Promise.race([
      session.prompt('hi', run.id, () => {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('anthropic turn timed out')), 30_000)),
    ]);
  } catch (e) { promptError = e; }

  await check('an anthropic-messages turn hits /v1/messages with tools and the key header', () => {
    if (promptError) throw promptError;
    const first = seen[0];
    assert.ok(first, 'no request');
    assert.equal(first.url?.split('?')[0], '/v1/messages');
    assert.equal(first.headers['x-api-key'], SECRET);
    assert.equal(first.body.stream, true);
    assert.equal(first.body.model, 'fake-claude');
    const tools = (first.body.tools as { name: string }[]).map((t) => t.name);
    assert.ok(tools.includes('ask_choice'), tools.join(','));
    assert.ok(tools.includes('schedule_routine'), tools.join(','));
    assert.equal(JSON.stringify(first.body).includes(SECRET), false);
    const texts = store.listSteps(run.id).filter((s) => s.kind === 'assistant_text').map((s) => s.body);
    assert.ok(texts.some((t) => t.includes('anthropic ok')), texts.join(' | ') || store.getRun(run.id)?.error || '(no text)');
  });

  await dropSession(bot.id);
  await fake.close();
}

console.log = origLog;
console.error = origErr;
await check('nothing logged the api key', () => {
  assert.equal(logs.some((l) => l.includes(SECRET) || l.includes('ada_other_secret_token') || l.includes('sk-ant-other-secret')), false);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(process.exitCode);
