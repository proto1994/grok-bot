import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GROUP_MAX, GROUP_MIN, PERMISSION_MODES, type PermissionMode } from '../protocol.ts';
import { store } from '../agent/store.ts';
import { TOOLS } from '../agent/tools.ts';
import { riskOf } from '../pi/gate.ts';
import { describe as describeRoutine } from '../agent/routines.ts';
import { dropSession, PEER_TOOLS, PI_TOOLS, PI_TOOL_DESCRIPTIONS } from '../pi/runner.ts';
import { startScheduler } from './scheduler.ts';
import { forgetSession } from '../pi/sessions.ts';
import { loadMcpServers, stopMcpServers } from '../mcp/registry.ts';
import { describePolicy } from '../sandbox/egress.ts';
import {
  describeTarget, forgetSandbox, initSandboxConfig, probeTarget, sandboxConfig, targetEgress,
} from '../sandbox/index.ts';
import { authorized, loadAuth, originAllowed } from './auth.ts';
import { isLoopbackOnly, lanAddresses, qrToText } from './lan.ts';
import {
  isBusy, isGroupBusy, reconcileOnBoot, sendToGroup, setBroadcast, startRun, stopRun,
} from './runtime.ts';

const PORT = Number(process.env.PORT ?? 4000);
/*
 * BIND=lan is the same as HOST=0.0.0.0, spelled so the intent is obvious at a
 * glance in a shell history or a launch script.
 */
const HOST = process.env.BIND === 'lan' ? '0.0.0.0' : (process.env.HOST ?? '127.0.0.1');
/** Stage 0 is single-user. Identity is a placeholder, not authentication. */
const OWNER = process.env.OWNER_ID ?? 'local';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(here, '../web/index.html');

const sockets = new Set<import('ws').WebSocket>();
const emit = (e: unknown) => {
  const msg = JSON.stringify(e);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
};

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const auth = loadAuth();

// Handoffs and replies happen outside any request, so the runtime needs its own
// way to reach connected clients.
setBroadcast((e) => emit(e));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const seg = url.pathname.split('/').filter(Boolean);

  try {
    // The UI itself is served unauthenticated; it carries the token to the API.
    const isApi = seg[0] === 'api';

    if (isApi && !originAllowed(req, HOST, PORT, req.headers.host)) {
      // A page on another origin asked for this. Refuse before looking at the
      // token: a leaked token should not be usable from an arbitrary site.
      return json(res, 403, { error: 'cross-origin requests are not allowed' });
    }
    if (isApi && !authorized(req, auth)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'a bearer token is required' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      // The token is injected into the page rather than fetched by it: a page
      // on another origin cannot read this HTML, so it cannot learn the token,
      // while our own page gets it without a login step.
      const html = (await readFile(UI, 'utf8')).replace(
        '</head>',
        `<script>window.__TOKEN__ = ${JSON.stringify(auth.token)};</script></head>`,
      );
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
      return;
    }

    // GET /api/bots — with the preview line the sidebar shows
    if (req.method === 'GET' && url.pathname === '/api/bots') {
      const last = store.lastLines(OWNER);
      return json(res, 200, store.listBots(OWNER).map((b) => ({
        ...b,
        preview: last[b.id] ?? null,
        needsAttention: store.openApprovals(OWNER).some((a) => a.botId === b.id),
      })));
    }

    // POST /api/bots
    if (req.method === 'POST' && url.pathname === '/api/bots') {
      const b = await readBody(req);
      const name = String(b.name ?? '').trim();
      if (!name) return json(res, 400, { error: 'name is required' });
      /*
       * A job is optional. Creating a bot should be as light as naming it; what
       * it is for comes out of the first thing you ask it, which is also how
       * the model reads it. A default keeps the prompt coherent until then.
       */
      const job = String(b.job ?? '').trim() || '按用户说的做事。第一次对话会说明你负责什么。';
      const target = b.sandboxTarget == null ? null : String(b.sandboxTarget);
      if (target !== null && !sandboxConfig().targets[target]) {
        return json(res, 400, {
          error: `unknown sandbox target: ${target}`,
          available: Object.keys(sandboxConfig().targets),
        });
      }
      const mode = (b.permissionMode ?? 'balanced') as PermissionMode;
      if (!PERMISSION_MODES.includes(mode)) {
        return json(res, 400, { error: `permissionMode must be one of ${PERMISSION_MODES.join(', ')}` });
      }
      const bot = store.createBot(OWNER, name, job, target, mode, {
        shape: b.shape == null ? null : String(b.shape),
        color: b.color == null ? null : String(b.color),
      });
      emit({ type: 'bot.created', bot });
      return json(res, 201, bot);
    }

    // The page imports this as a module, so it has to be served alongside it.
    if (req.method === 'GET' && url.pathname === '/shapes.js') {
      const js = await readFile(path.join(here, '../web/shapes.js'), 'utf8');
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(js);
      return;
    }

    // An inline icon, so the tab is not a generic page and the console stays clean.
    if (req.method === 'GET' && url.pathname === '/favicon.svg') {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" rx="8" fill="#2563eb"/>' +
        '<circle cx="16" cy="13" r="5" fill="#fff"/>' +
        '<rect x="7" y="20" width="18" height="6" rx="3" fill="#fff"/></svg>';
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      res.end(svg);
      return;
    }

    // GET /api/targets — where a bot's computer can live
    if (req.method === 'GET' && url.pathname === '/api/targets') {
      const cfg = sandboxConfig();
      return json(res, 200, {
        default: cfg.default,
        targets: Object.entries(cfg.targets).map(([name, t]) => ({
          name,
          kind: t.kind,
          description: t.description ?? describeTarget(name, t),
          egress: describePolicy(targetEgress(t)),
          isDefault: name === cfg.default,
        })),
      });
    }

    // GET /api/targets/:name/probe — is this target's daemon reachable
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'targets' && seg[2] && seg[3] === 'probe') {
      const t = sandboxConfig().targets[seg[2]];
      if (!t) return json(res, 404, { error: `unknown target: ${seg[2]}` });
      if (t.kind === 'local') return json(res, 200, { ok: true, detail: 'this host' });
      return json(res, 200, await probeTarget(t));
    }

    // PATCH /api/bots/:id  { name?, job?, shape?, color? }
    if (req.method === 'PATCH' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && !seg[3]) {
      const b = await readBody(req);
      const patch: Record<string, string> = {};
      for (const k of ['name', 'job', 'shape', 'color']) {
        if (typeof b[k] === 'string' && b[k].trim()) patch[k] = String(b[k]).trim();
      }
      const updated = store.updateBot(OWNER, seg[2], patch);
      if (!updated) return json(res, 404, { error: 'no such bot' });
      return json(res, 200, updated);
    }

    // DELETE /api/bots/:id
    if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && !seg[3]) {
      const bot = store.getBot(seg[2]);
      if (!bot || bot.ownerId !== OWNER) return json(res, 404, { error: 'no such bot' });
      if (isBusy(bot.id)) {
        return json(res, 409, { error: '这个 Bot 正在工作，先停下来再删' });
      }
      await dropSession(bot.id);
      store.deleteBot(OWNER, bot.id);
      // The transcript is a file, so the store cannot take it with the rows.
      forgetSession(bot.id);
      return json(res, 200, {
        ok: true,
        note: '对话记录和它记住的上下文都删了。沙箱里的文件和登录状态是共用的，没有动。',
      });
    }

    // PATCH /api/bots/:id/permission  { mode }
    if (req.method === 'PATCH' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && seg[3] === 'permission') {
      const bot = store.getBot(seg[2]);
      if (!bot || bot.ownerId !== OWNER) return json(res, 404, { error: 'no such bot' });
      const b = await readBody(req);
      const mode = String(b.mode ?? '') as PermissionMode;
      if (!PERMISSION_MODES.includes(mode)) {
        return json(res, 400, { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` });
      }
      const updated = store.setPermissionMode(bot.id, mode);
      if (mode === 'full') {
        // Worth a line in the log: afterwards nothing in the transcript shows
        // that a tool call was never offered for review.
        console.log(`[permission] bot ${bot.name} (${bot.id}) set to FULL — the approval gate is off for it`);
      }
      return json(res, 200, {
        bot: updated,
        note: mode === 'full'
          ? '这个 Bot 现在不会再就任何操作征求同意，包括删除文件和访问网络。'
          : undefined,
      });
    }

    // PATCH /api/bots/:id/target  { target: string | null }
    if (req.method === 'PATCH' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && seg[3] === 'target') {
      const bot = store.getBot(seg[2]);
      if (!bot || bot.ownerId !== OWNER) return json(res, 404, { error: 'no such bot' });
      const b = await readBody(req);
      const next = b.target === null ? null : String(b.target ?? '');
      if (next !== null && !sandboxConfig().targets[next]) {
        return json(res, 400, {
          error: `unknown target: ${next}`,
          available: Object.keys(sandboxConfig().targets),
        });
      }
      forgetSandbox(bot.ownerId, bot.sandboxTarget);
      const updated = store.setBotTarget(bot.id, next);
      return json(res, 200, {
        bot: updated,
        note:
          'The workspace on a target is separate. Files, logins, and installed packages ' +
          'from the previous target do not follow this bot.',
      });
    }

    // GET /api/groups
    if (req.method === 'GET' && url.pathname === '/api/groups') {
      return json(res, 200, store.listGroups(OWNER).map((g) => ({
        ...g,
        memberNames: store.groupMembers(g.id).map((b) => b.name),
      })));
    }

    // POST /api/groups  { name, members: botId[] }
    if (req.method === 'POST' && url.pathname === '/api/groups') {
      const b = await readBody(req);
      const name = String(b.name ?? '').trim();
      const members = Array.isArray(b.members) ? b.members.map(String) : [];
      if (!name) return json(res, 400, { error: 'name is required' });
      if (members.length < GROUP_MIN || members.length > GROUP_MAX) {
        return json(res, 400, {
          error: `a group needs ${GROUP_MIN} to ${GROUP_MAX} bots`,
        });
      }
      const mine = new Set(store.listBots(OWNER).map((x) => x.id));
      if (members.some((id) => !mine.has(id))) {
        return json(res, 400, { error: 'one of those bots is not yours' });
      }
      const group = store.createGroup(OWNER, name, members);
      emit({ type: 'group.created', group });
      return json(res, 201, group);
    }

    // GET /api/groups/:id
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'groups' && seg[2] && !seg[3]) {
      const group = store.getGroup(OWNER, seg[2]);
      if (!group) return json(res, 404, { error: 'no such group' });
      const members = store.groupMembers(group.id);
      return json(res, 200, {
        group,
        members: members.map((b) => ({ id: b.id, name: b.name, job: b.job })),
        messages: store.groupMessages(group.id),
        busy: isGroupBusy(group.id),
      });
    }

    // POST /api/groups/:id/messages  { text }
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'groups' && seg[2] && seg[3] === 'messages') {
      const group = store.getGroup(OWNER, seg[2]);
      if (!group) return json(res, 404, { error: 'no such group' });
      const b = await readBody(req);
      const text = String(b.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'text is required' });
      if (isGroupBusy(group.id)) {
        return json(res, 409, { error: '这个群里已经有 Bot 在说话了' });
      }
      // Returns immediately; the conversation plays out over the websocket.
      void sendToGroup(OWNER, group.id, text).catch((e) => {
        console.error(`[group ${group.id}]`, e);
      });
      return json(res, 202, { ok: true });
    }

    // DELETE /api/groups/:id
    if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'groups' && seg[2]) {
      if (!store.deleteGroup(OWNER, seg[2])) return json(res, 404, { error: 'no such group' });
      return json(res, 200, { ok: true });
    }

    // GET /api/tools — what the model can currently reach, and at what risk
    if (req.method === 'GET' && url.pathname === '/api/tools') {
      // PI's own tools live inside pi, so they are listed explicitly; without
      // them this panel would claim the model can only reach MCP servers.
      const builtin = [...PI_TOOLS, ...PEER_TOOLS].map((name) => ({
        name,
        risk: riskOf(name),
        description: PI_TOOL_DESCRIPTIONS[name] ?? 'pi built-in tool, wired to the sandbox',
      }));
      const mcpTools = Object.entries(TOOLS).map(([name, t]) => ({
        name, risk: t.risk, description: t.schema.description.slice(0, 160),
      }));
      return json(res, 200, [...builtin, ...mcpTools]);
    }

    // GET /api/approvals
    if (req.method === 'GET' && url.pathname === '/api/approvals') {
      return json(res, 200, store.openApprovals(OWNER));
    }

    // POST /api/approvals/:id  { approved: boolean }
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'approvals' && seg[2]) {
      const b = await readBody(req);
      const approved = b.approved === true;
      // Scoped: an approval id alone must not let anyone release a tool call
      // on another owner's sandbox.
      const a = store.resolveApprovalFor(OWNER, seg[2], approved);
      if (!a) return json(res, 404, { error: 'no such approval' });
      emit({ type: 'approval.resolved', approvalId: a.id, approved });
      // No nudge needed: the gate's handler is already awaiting this decision.
      return json(res, 200, a);
    }

    // GET /api/bots/:id/runs
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && seg[3] === 'runs') {
      return json(res, 200, store.listRunsFor(OWNER, seg[2]));
    }

    // GET /api/bots/:id/routines
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && seg[3] === 'routines') {
      const bot = store.getBot(seg[2]);
      if (!bot || bot.ownerId !== OWNER) return json(res, 404, { error: 'no such bot' });
      return json(res, 200, store.listRoutines(bot.id).map((r) => ({
        ...r,
        when: describeRoutine(r),
      })));
    }

    // PATCH /api/routines/:id  { enabled }
    if (req.method === 'PATCH' && seg[0] === 'api' && seg[1] === 'routines' && seg[2]) {
      const b = await readBody(req);
      const updated = store.setRoutineEnabled(OWNER, seg[2], b.enabled === true);
      if (!updated) return json(res, 404, { error: 'no such routine' });
      emit({ type: 'routines.changed', botId: updated.botId, routines: store.listRoutines(updated.botId) });
      return json(res, 200, { ...updated, when: describeRoutine(updated) });
    }

    // DELETE /api/routines/:id
    if (req.method === 'DELETE' && seg[0] === 'api' && seg[1] === 'routines' && seg[2]) {
      const routine = store.getRoutine(OWNER, seg[2]);
      if (!routine) return json(res, 404, { error: 'no such routine' });
      store.deleteRoutine(OWNER, seg[2]);
      emit({ type: 'routines.changed', botId: routine.botId, routines: store.listRoutines(routine.botId) });
      return json(res, 200, { ok: true });
    }

    // POST /api/bots/:id/greet — the opening turn for a bot that was just made
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && seg[3] === 'greet') {
      const bot = store.getBot(seg[2]);
      if (!bot || bot.ownerId !== OWNER) return json(res, 404, { error: 'no such bot' });
      if (store.listRuns(bot.id).length > 0) {
        return json(res, 409, { error: 'this bot has already been spoken to' });
      }
      /*
       * A prompt the person never sees, phrased as an instruction to the bot.
       *
       * The create sheet asks only for a name, so this is where "what is it
       * for" gets settled: the bot introduces itself and asks, with ask_choice,
       * what to take on first.
       */
      void startRun(
        bot.id,
        '这是你和用户的第一次对话。用一两句话介绍你能做什么（可以用沙箱里的命令行和文件、' +
          '也能通过已连接的工具做事），然后用 ask_choice 问他想先让你做哪方面的事，' +
          '给 4 到 5 个具体的方向，最后一项留个「只是先随便试试」这类出口。' +
          '不要说这是系统提示，像正常打招呼一样。',
        emit,
      ).catch((e) => console.error(`[greet ${bot.id}]`, e));
      return json(res, 202, { ok: true });
    }

    // POST /api/bots/:id/messages  { text }
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'bots' && seg[2] && seg[3] === 'messages') {
      const bot = store.getBot(seg[2]);
      if (!bot || bot.ownerId !== OWNER) return json(res, 404, { error: 'no such bot' });
      const b = await readBody(req);
      const text = String(b.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'text is required' });

      /*
       * Accepted even while the bot is working: the message queues behind the
       * current turn. Returning 409 here threw away what someone had typed,
       * which is the opposite of what adding to a running task should do.
       */
      void startRun(bot.id, text, emit).catch((e) => {
        console.error(`[bot ${bot.id}]`, e);
      });
      return json(res, 202, { queued: true, busy: isBusy(bot.id) });
    }

    // GET /api/runs/:id
    if (req.method === 'GET' && seg[0] === 'api' && seg[1] === 'runs' && seg[2]) {
      const run = store.getRunFor(OWNER, seg[2]);
      if (!run) return json(res, 404, { error: 'no such run' });
      return json(res, 200, {
        run,
        steps: store.listStepsFor(OWNER, run.id),
        approvals: store.pendingApprovalsFor(OWNER, run.id),
      });
    }

    // POST /api/runs/:id/stop
    if (req.method === 'POST' && seg[0] === 'api' && seg[1] === 'runs' && seg[2] && seg[3] === 'stop') {
      const run = store.getRunFor(OWNER, seg[2]);
      if (!run) return json(res, 404, { error: 'no such run' });
      await stopRun(run.id, emit);
      return json(res, 200, store.getRunFor(OWNER, run.id));
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

// Events carry conversation content, so the handshake is authenticated too.
// Browsers cannot set headers on a WebSocket, so the token arrives as a query
// parameter; auth.ts accepts either.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req, origin }, done) => {
    // req.headers.host matters here as much as on the http path: a phone
    // connects by LAN address, so that is the origin it sends. Omitting it
    // refused every websocket from a phone, which left the live event stream
    // dead and approval cards never appearing.
    if (typeof origin === 'string' && origin !== '' && !originAllowed(req, HOST, PORT, req.headers.host)) {
      return done(false, 403, 'cross-origin');
    }
    done(authorized(req, auth), 401, 'unauthorized');
  },
});
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
});

const MCP_CONFIG = process.env.MCP_CONFIG ?? './mcp.json';

const SANDBOX_CONFIG = process.env.SANDBOX_CONFIG ?? './sandboxes.json';

try {
  await initSandboxConfig(SANDBOX_CONFIG);
} catch (e) {
  console.error(`sandbox config is invalid: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopMcpServers();
    process.exit(0);
  });
}

// MCP tools are registered before the port opens, so no run can start against a
// half-populated tool table.
const mcp = await loadMcpServers(MCP_CONFIG).catch((e) => {
  console.error(`mcp           load failed: ${e instanceof Error ? e.message : e}`);
  return [] as { server: string; tools: string[] }[];
});

server.listen(PORT, HOST, () => {
  const onLan = !isLoopbackOnly(HOST);
  console.log(`orchestrator  http://${onLan ? '0.0.0.0' : HOST}:${PORT}`);
  if (onLan) {
    for (const { iface, address } of lanAddresses()) {
      console.log(`  on ${iface.padEnd(10)} http://${address}:${PORT}`);
    }
  }
  const cfg = sandboxConfig();
  for (const [name, t] of Object.entries(cfg.targets)) {
    const mark = name === cfg.default ? '*' : ' ';
    console.log(`sandbox     ${mark} ${describeTarget(name, t)} — ${describePolicy(targetEgress(t))}`);
  }
  if (mcp.length) {
    for (const s of mcp) console.log(`mcp           ${s.server}: ${s.tools.length} tool(s)`);
  } else {
    console.log(`mcp           none (${MCP_CONFIG} missing or empty)`);
  }
  const anyRestricted = Object.values(cfg.targets).some((t) => targetEgress(t).mode !== 'allow_all');
  if (mcp.length && anyRestricted) {
    // Worth stating plainly: these servers are host processes, so the sandbox
    // network policy does not apply to their own outbound traffic.
    console.log(
      'NOTE: stdio MCP servers run on this host, outside the sandbox network. ' +
        'The egress policy does not cover what they connect to.',
    );
  }
  if (Object.values(cfg.targets).some((t) => t.kind === 'local')) {
    console.log('WARNING: a "local" target runs commands on its host with no isolation.');
  }

  if (onLan) {
    const addr = lanAddresses()[0]?.address;
    if (addr) {
      const url = `http://${addr}:${PORT}/?token=${encodeURIComponent(auth.token)}`;
      const qr = qrToText(url);
      console.log('');
      console.log('Open on a phone on this network:');
      console.log(`  ${url}`);
      if (qr) {
        console.log('');
        console.log(qr);
      }
    }
    console.log('');
    console.log('WARNING: this port is now reachable by anything on the network.');
    console.log('  The token is the only thing in the way, and a bot set to 完全权限');
    console.log('  runs commands on this machine. Do not leave it bound on a network');
    console.log('  you do not control.');
  }
  if (auth.generated) {
    console.log(`auth          a token was generated and written to .env as AUTH_TOKEN`);
  } else {
    console.log(`auth          bearer token required (AUTH_TOKEN)`);
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(
      `WARNING: bound to ${HOST}, so this port is reachable from the network. ` +
        'The token is the only thing protecting it.',
    );
  }
  const n = reconcileOnBoot(emit);
  if (n) console.log(`ended ${n} run(s) left in flight by the previous process`);

  /*
   * Routines start ticking once the port is open.
   *
   * Nothing catches up on what was missed while the process was off: isDue only
   * fires inside a window after the scheduled time, so opening a laptop at noon
   * does not set the morning's jobs running at once.
   */
  startScheduler({
    ownerId: OWNER,
    startRun: (botId, text) => startRun(botId, text, emit),
    isBusy,
    onFired: (routine, runId) => {
      console.log(`[routine] ${routine.title} → run ${runId.slice(0, 8)}`);
      emit({ type: 'routine.fired', botId: routine.botId, title: routine.title, runId });
    },
  });
  const routineCount = store.listBots(OWNER).reduce((t, b) => t + store.listRoutines(b.id).length, 0);
  if (routineCount) console.log(`routines      ${routineCount} scheduled`);
});
