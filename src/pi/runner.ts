import {
  createAgentSession, createBashToolDefinition, createEditToolDefinition,
  createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  DefaultResourceLoader, getAgentDir, ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { store } from '../agent/store.ts';
import type { Bot } from '../protocol.ts';
import { getSandbox } from '../sandbox/index.ts';
import { assertToken, DEFAULT_MODEL, DEFAULT_PROVIDER, writeGatewayConfig } from './gateway.ts';
import { createGate } from './gate.ts';
import {
  listBotsTool, messageBotTool, type HandoffChain, type HandoffDeps,
} from './handoff.ts';
import { askTool } from './ask.ts';
import { listRoutinesTool, scheduleTool } from './schedule-tool.ts';
import { sessionFor as persistentSession } from './sessions.ts';
import { mcpToolDefinitions, mcpToolNames, toPiTool } from './mcp-bridge.ts';
import {
  sandboxBashOperations, sandboxEditOperations, sandboxLsOperations,
  sandboxReadOperations, sandboxWriteOperations,
} from './sandbox-ops.ts';

/**
 * One PI session per bot, held open across messages.
 *
 * PI owns the loop, the tool set, compaction, and the transcript. We own where
 * the tools run (the sandbox), what needs approval (the gate), and what the
 * person sees (the step log).
 */

type Emit = (e: unknown) => void;

const CONFIG_DIR = process.env.PI_CONFIG_DIR ?? path.join(tmpdir(), 'grok-bot-lite-pi');

/**
 * How long a single turn may spend working.
 *
 * Time spent waiting for a person does not count: an approval can legitimately
 * sit for an hour. What this bounds is the model's own work, which has stalled
 * indefinitely in practice and taken the whole queue with it.
 */
const TURN_BUDGET_MS = Number(process.env.MAX_WALLCLOCK_MS ?? 900_000);

export interface BotSession {
  botId: string;
  /** Identifies this build, so a session only ever evicts itself. */
  instanceId: string;
  prompt(
    text: string, runId: string, emit: Emit, chain?: HandoffChain,
    opts?: { inGroup?: boolean },
  ): Promise<void>;
  /** The text of this bot's last reply, for a bot that asked it something. */
  lastReply(): string;
  stop(): Promise<void>;
}

const sessions = new Map<string, Promise<BotSession>>();

/**
 * Forgets a session, but only if it is still the live one for that bot.
 *
 * A timed-out turn evicts itself so the next message starts clean. By then the
 * map may already hold a newer session — dropping that one would discard a
 * working session and lose its conversation state.
 */
async function evictIfCurrent(botId: string, instanceId: string): Promise<void> {
  const held = sessions.get(botId);
  if (!held) return;
  const live = await held.catch(() => null);
  if (live?.instanceId === instanceId) sessions.delete(botId);
}

/**
 * How a bot reaches another bot.
 *
 * Injected rather than imported: starting a run belongs to the runtime, and
 * importing it here would make runner and runtime depend on each other.
 */
let handoffDeps: HandoffDeps | null = null;
export function setHandoffDeps(deps: HandoffDeps): void {
  handoffDeps = deps;
}

async function build(bot: Bot): Promise<BotSession> {
  assertToken();
  const modelsPath = writeGatewayConfig(CONFIG_DIR);
  const modelRuntime = await ModelRuntime.create({ modelsPath });
  const model = modelRuntime.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL);
  if (!model) throw new Error(`model ${DEFAULT_PROVIDER}/${DEFAULT_MODEL} not found in ${modelsPath}`);

  const sandbox = await getSandbox(bot.ownerId, bot.sandboxTarget);
  // What the model is told must match what `pwd` prints, or it spends turns
  // doubting its tools.
  const workdir = sandbox.workdir;

  let currentRun: string | null = null;
  let emit: Emit = () => {};
  const controller = new AbortController();
  // Per-prompt, not per-session: the same bot can be reached through different
  // chains, and the cycle check is only meaningful against the current one.
  let chain: HandoffChain = { path: [bot.id] };
  let lastReply = '';
  /*
   * Group turns withhold message_bot.
   *
   * A group already hands over with @, and a bot that did both sent two prompts
   * into the same session at once — pi refused the second with "Agent is
   * already processing" and the chain died silently. One mechanism per context.
   */
  let inGroup = false;
  /** Milliseconds this turn spent waiting for a person, which do not count. */
  let parkedMs = 0;
  const instanceId = randomUUID();
  /**
   * Whether this turn has already put a question on screen.
   *
   * A card is the question, so anything the model writes after one is a second
   * copy of it. Reset at the start of every turn.
   */
  let asked = false;

  const step = (kind: Parameters<typeof store.appendStep>[1], body: string, tool: string | null = null) => {
    if (!currentRun) return;
    emit({ type: 'step.appended', botId: bot.id, step: store.appendStep(currentRun, kind, body, tool) });
  };

  const gate = createGate({
    botId: bot.id,
    runId: () => currentRun,
    // Read fresh each call: changing the mode must not need a new session.
    mode: () => store.getBot(bot.id)?.permissionMode ?? 'balanced',
    signal: controller.signal,
    hooks: {
      onCall: (toolName, args) => step('tool_call', JSON.stringify(args).slice(0, 2000), toolName),
      onWaited: (ms) => { parkedMs += ms; },
      onPark: (id) => {
        const a = store.getApproval(id);
        if (a) emit({ type: 'approval.requested', approval: a });
      },
      onDecide: (_id, approved) => {
        if (!approved) step('tool_result', 'denied by the user', null);
      },
    },
  });

  const loader = new DefaultResourceLoader({
    cwd: workdir,
    agentDir: getAgentDir(),
    // Only our gate runs: anything discovered on disk could change tool
    // behaviour without being visible here.
    noExtensions: true,
    noContextFiles: true,
    extensionFactories: [gate.extension],
    systemPrompt: [
      `You are ${bot.name}, a persistent teammate.`,
      ``,
      `Your job: ${bot.job}`,
      ``,
      `Write only what you mean the user to read, in their language. Working out`,
      `what to do, deciding which tool to reach for, reminding yourself to keep`,
      `it short — none of that belongs in a reply. It shows up on screen as a`,
      `stray line of English above the actual answer.`,
      ``,
      `After ask_choice, say nothing. The buttons are the question; repeating it`,
      `underneath gives the user the same question twice.`,
      ``,
      `You work on a sandbox computer. Your working directory is ${workdir} and`,
      `durable files belong there. Paths you are given are relative to it, and`,
      `there is nothing to look for elsewhere on the filesystem.`,
      ``,
      `A shell command has no time limit unless you set one. If something may`,
      `take a while, run it and wait rather than splitting it up.`,
      ``,
      `You keep your own schedule. schedule_routine puts work on it and the user`,
      `gets a list they can switch off; say what you scheduled rather than`,
      `promising to "remember".`,
      ``,
      `Use it both ways. When the user asks for something regular, schedule it.`,
      `But also schedule the recurring work your job implies without being asked:`,
      `if you are here to watch something, watch it on a cadence instead of`,
      `waiting to be told to look again. Decide this once you know what you are`,
      `for — at the end of your first real exchange, and again when the job`,
      `turns out to be different from what you assumed.`,
      ``,
      `Judgement, not reflex. Call list_routines first; never schedule something`,
      `you already run. Schedule only work that produces something worth reading`,
      `every time it runs, at the rate the thing it watches actually changes — a`,
      `daily digest of something that moves weekly is noise. Start with one or`,
      `two and say why; let the user ask for more rather than filling the list.`,
      `A routine arrives with no conversation around it, so its prompt has to`,
      `stand on its own and say what finished looks like.`,
      ``,
      `When one decision would let you start and the sensible answers are few,`,
      `ask_choice puts them in front of the user as buttons rather than making`,
      `them retype an option you already listed. One question at a time, and not`,
      `for anything you can settle yourself.`,
      ``,
      `You are one of several bots on this account. list_bots shows the others and`,
      `what each is for; message_bot asks one of them for something and waits for`,
      `the reply. Use it when another bot owns the system or the context — not to`,
      `pass along work you can do. Give one bot one stage: it cannot see your`,
      `conversation, so say what you need and what finished looks like. It works`,
      `under its own permissions and may stop to ask its owner.`,
      `Some actions need the user's approval; you are told the outcome. A denial`,
      `is a decision, not an error: adapt instead of retrying the same call.`,
      `Be concrete about what you verified and what you only assumed.`,
    ].join('\n'),
  });
  await loader.reload();

  // Tools execute through the sandbox, not in this process.
  const ops = {
    bash: sandboxBashOperations(sandbox, workdir),
    read: sandboxReadOperations(sandbox, workdir),
    write: sandboxWriteOperations(sandbox, workdir),
    edit: sandboxEditOperations(sandbox, workdir),
    ls: sandboxLsOperations(sandbox, workdir),
  };

  /*
   * grep and find are deliberately not offered.
   *
   * Both spawn a child process (ripgrep, find) on whichever machine this code
   * runs on, and their *Operations hooks only supply context lines — the search
   * itself bypasses the sandbox seam entirely. On the docker target they would
   * search the orchestrator's filesystem, not the bot's computer: wrong answers
   * at best, a path out of the sandbox at worst.
   *
   * Searching still works: the model runs grep or find through `bash`, which
   * does execute inside the sandbox.
   */

  const toolCtx = { botId: bot.id, ownerId: bot.ownerId, sandboxTarget: bot.sandboxTarget };

  // MCP tools reach their servers from this process, not from the sandbox.
  const mcp = mcpToolDefinitions(toolCtx);

  // Talking to other bots. The deliver function is injected by the caller so
  // this module does not have to know how runs are started.
  /*
   * Asking the person a question with buttons.
   *
   * Always available, unlike the peer tools: narrowing something down with one
   * tap is useful whether or not other bots exist.
   */
  const choiceTool = toPiTool('ask_choice', askTool(toolCtx, (q) => {
    asked = true;
    emit({ type: 'question.asked', botId: bot.id, question: q.question, options: q.options });
  }), toolCtx);

  /*
   * Putting work on a schedule.
   *
   * schedule_routine is a write: it commits the bot to acting unprompted, and
   * those runs cost money and touch real systems, so it goes through the gate
   * like any other change.
   */
  const routineTools = [
    toPiTool('schedule_routine', scheduleTool(toolCtx, () => {
      emit({ type: 'routines.changed', botId: bot.id, routines: store.listRoutines(bot.id) });
    }), toolCtx),
    toPiTool('list_routines', listRoutinesTool(toolCtx), toolCtx),
  ];

  const peerTools = handoffDeps
    ? [
        toPiTool('message_bot', messageBotTool(toolCtx, () => chain, {
          ...handoffDeps,
          deliver: async (to, text, next) => {
            if (inGroup) {
              return (
                'Not available in a group: mention the bot with @ in your reply and ' +
                'the group hands them the next turn. Using both at once sends two ' +
                'requests to the same bot.'
              );
            }
            return handoffDeps!.deliver(to, text, next);
          },
        }), toolCtx),
        toPiTool('list_bots', listBotsTool(toolCtx), toolCtx),
      ]
    : [];

  const { session } = await createAgentSession({
    cwd: workdir,
    model,
    thinkingLevel: 'off',
    modelRuntime,
    resourceLoader: loader,
    // Replace the built-ins (which would run in this process) with the
    // sandbox-backed definitions below, then enable exactly those by name.
    noTools: 'builtin',
    tools: [
      ...PI_TOOLS, ...mcpToolNames(), 'ask_choice',
      ...routineTools.map((t) => t.name), ...peerTools.map((t) => t.name),
    ],
    // Each factory returns a ToolDefinition bound to its own schema, which does
    // not unify with the invariant ToolDefinition<TSchema> the option expects.
    // The shapes are PI's own; the cast is at that boundary only.
    customTools: [
      createBashToolDefinition(workdir, { operations: ops.bash }),
      createReadToolDefinition(workdir, { operations: ops.read }),
      createWriteToolDefinition(workdir, { operations: ops.write }),
      createEditToolDefinition(workdir, { operations: ops.edit }),
      createLsToolDefinition(workdir, { operations: ops.ls }),
      ...mcp,
      choiceTool,
      ...routineTools,
      ...peerTools,
    ] as unknown as NonNullable<Parameters<typeof createAgentSession>[0]>['customTools'],
    // On disk, so a restart does not wipe what the bot remembers.
    sessionManager: persistentSession(bot.id, workdir),
  });

  // A silently-unregistered extension looks identical to having no gate, so
  // refuse to serve rather than run wide open.
  gate.assertRegistered();

  session.subscribe((event: any) => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      for (const b of event.message.content ?? []) {
        if (b.type === 'text' && String(b.text ?? '').trim()) {
          /*
           * Nothing follows a card.
           *
           * ask_choice already put the question on screen as buttons, and no
           * tool can end a turn, so the model carries on and writes the same
           * question out again underneath — in the case this was found from,
           * re-listing both options it had just offered as taps. The prompt
           * asks it not to; this makes it so regardless.
           */
          if (asked) {
            step('note', `withheld after a question card: ${String(b.text).slice(0, 500)}`);
            continue;
          }
          step('assistant_text', b.text);
          // Kept so a bot that asked this one something gets the answer rather
          // than having to read the step log.
          lastReply = b.text;
        }
      }
    } else if (event.type === 'tool_execution_end') {
      const text = (event.result?.content ?? [])
        .map((c: { type: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
        .join('\n')
        .slice(0, 4000);
      step('tool_result', text || '(no output)', event.toolName ?? null);
    } else if (event.type === 'compaction_end') {
      step('note', 'compacted context: older turns were summarized by pi');
    }
  });

  return {
    botId: bot.id,
    instanceId,

    async prompt(text, runId, e, incoming, opts) {
      currentRun = runId;
      emit = e;
      inGroup = opts?.inGroup === true;
      // A direct message from a person starts a fresh chain at this bot.
      chain = incoming ?? { path: [bot.id] };
      lastReply = '';
      asked = false;
      try {
        // followUp rather than a refusal: a message sent while the bot is still
        // working is nearly always a correction or an addition, and queueing it
        // is what the person meant.
        const work = session.prompt(text, { streamingBehavior: 'followUp' });

        /*
         * A ceiling on the model's own time.
         *
         * Checked against a clock that excludes whatever this turn spent parked
         * on an approval, so a slow human decision never counts as a stall.
         */
        const startedAt = Date.now();
        let timer: NodeJS.Timeout | null = null;
        const ceiling = new Promise<never>((_, reject) => {
          const check = () => {
            const working = Date.now() - startedAt - parkedMs;
            if (working >= TURN_BUDGET_MS) {
              reject(new Error(
                `这一轮已经跑了 ${Math.round(working / 1000)} 秒还没结束，先停下来了。` +
                '再说一次就能重试。',
              ));
              return;
            }
            timer = setTimeout(check, 5_000);
          };
          timer = setTimeout(check, 5_000);
        });

        try {
          await Promise.race([work, ceiling]);
        } finally {
          if (timer) clearTimeout(timer);
          // The prompt may still be running; its rejection must not surface as
          // an unhandled one after we have already reported the timeout.
          void work.catch(() => {});
        }
        const run = store.updateRun(runId, { status: 'done', endedAt: Date.now() });
        emit({ type: 'run.updated', run });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        step('note', `run failed: ${msg}`);
        const run = store.updateRun(runId, { status: 'failed', endedAt: Date.now(), error: msg });
        emit({ type: 'run.updated', run });

        /*
         * A timed-out turn has to be let go of, not waited on.
         *
         * abort() only returns once pi unwinds, and pi cannot interrupt a tool
         * call already in flight — sandbox exec takes a timeout, not a signal,
         * so a `sleep 120` runs to completion regardless. Waiting here would
         * hold the bot busy for exactly as long as the hung work, which is what
         * the ceiling exists to prevent.
         *
         * So: give it a moment to come back cleanly, and if it does not, forget
         * the session. The next message builds a fresh one rather than queueing
         * behind a turn nobody is waiting for. The abandoned session finishes on
         * its own and is garbage once nothing points at it.
         */
        if (/先停下来了/.test(msg)) {
          const letGo = new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 3_000));
          const stopped = session.abort?.().then(() => 'clean' as const).catch(() => 'clean' as const)
            ?? Promise.resolve('clean' as const);
          if (await Promise.race([stopped, letGo]) === 'stuck') {
            await evictIfCurrent(bot.id, instanceId);
            step('note', '这个会话卡在一个停不下来的命令上，下一条消息会开一个新的。');
          }
        }
      } finally {
        currentRun = null;
      }
    },

    lastReply: () => lastReply,

    async stop() {
      controller.abort();
      await session.abort?.();
    },
  };
}

export function sessionFor(bot: Bot): Promise<BotSession> {
  let s = sessions.get(bot.id);
  if (!s) {
    s = build(bot).catch((e) => {
      sessions.delete(bot.id);
      throw e;
    });
    sessions.set(bot.id, s);
  }
  return s;
}

export async function dropSession(botId: string): Promise<void> {
  const s = sessions.get(botId);
  sessions.delete(botId);
  if (s) await (await s).stop().catch(() => {});
}

/** Tools pi exposes to the model, all wired to the sandbox above. */
export const PI_TOOLS = ['bash', 'read', 'write', 'edit', 'ls'] as const;

/** Tools for reaching other bots, listed separately for the UI. */
export const PEER_TOOLS = [
  'ask_choice', 'schedule_routine', 'list_routines', 'list_bots', 'message_bot',
] as const;

export const PI_TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: '在沙箱里运行 shell 命令',
  read: '读取沙箱里的文件',
  write: '创建或覆盖沙箱里的文件',
  edit: '按片段修改沙箱里的文件',
  ls: '列出沙箱里的目录内容',
  grep: '在沙箱的文件里搜索内容',
  find: '按文件名在沙箱里查找',
};
