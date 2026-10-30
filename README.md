# Bots

Persistent AI teammates with their own sandbox computers. You create a bot, give
it a job, and it keeps working on that job across restarts — on your machine or
on a remote sandbox, with you approving the actions that matter.

Modeled on [Cursor's Grok Bot](https://cursor.com/docs/grok-bot). A bot calls
whatever provider you configure — Anthropic, OpenAI, or any OpenAI-compatible
endpoint — and that choice is stored in the app, not hard-wired in `.env`.

## What it does

- **A bot per job.** Name it, pick a face, say what it's for. Each bot has its
  own workspace, its own conversation history, and its own permission mode.
- **Its own computer.** Tools (`bash`, `read`, `write`, `edit`, `ls`) run inside
  a sandbox, either a Docker container or — for development only — your own
  machine. Switching a bot between sandbox targets is a config change; the
  workspace on each target is separate and does not follow.
- **Approval, not trust.** Every tool call is classified `read` / `write` /
  `external` and held for approval according to the bot's mode. Rules may only
  tighten what a mode allows, never loosen it.
- **Network isolation.** The Docker driver can put a sandbox on an `--internal`
  network behind a bridging proxy, so only an allowlist gets out. MCP servers
  are a separate egress path and are only covered when `applyToMcp` is set.
- **Routines.** Ask for something regularly and the bot schedules it itself; you
  get a list you can switch off.
- **Bots talk to each other.** A bot can hand work to another bot
  asynchronously, or several can share a group chat addressed with `@name`.
- **Anywhere you are.** Web UI, a macOS desktop app, and your phone over the
  LAN with the same token.

## Running it

Needs Node 22 or newer (`node:sqlite`), and Docker if you want real isolation.

```bash
pnpm install
cp .env.example .env     # optional: seed a provider on first run
pnpm dev                 # http://localhost:4000
```

The API is behind a bearer token. One is generated into `.env` on first run if
`AUTH_TOKEN` is empty; the web UI picks it up automatically on localhost.

## Models

Open the sidebar and choose **模型**. Add a provider (a preset fills the base
URL, the API style, and a couple of model ids), paste an API key, and use
**测试连接** before saving. Pick a default model there. Each bot can override
it from its own settings sheet. Keys are stored in sqlite and only ever shown
back masked (`sk-a…wxyz`); they are not written into logs or into the
`models.json` PI reads (that file holds a `$ENV` reference).

On a database that has no providers yet, the first launch imports one from the
environment so an existing install keeps working:

- `ADA_TOKEN` + `ADA_BASE_URL` (+ optional `PI_MODEL`) — the previous
  Anthropic-messages gateway. This stays the default when both seeds are set.
- `ANTHROPIC_API_KEY` (+ optional `MODEL_ID`) — Anthropic directly.

After that, `.env` is not consulted again. Edit providers in the UI.

### DeepSeek

In **模型 → 添加提供商** the DeepSeek preset is the one the form opens on. It fills:

| Field | Value |
| --- | --- |
| 接口 | `openai-chat-completions` |
| Base URL | `https://api.deepseek.com` |
| 模型 | `deepseek-chat` (and `deepseek-reasoner`, which you can remove) |

Create a key at [platform.deepseek.com](https://platform.deepseek.com), paste it,
hit **测试连接**, save, and set `deepseek-chat` as the default. `deepseek-chat`
is the one that tool-calls. A single bot can be pointed at a different model
from **设置 → 模型** without changing the default.

Desktop app:

```bash
pnpm app                 # run from source
pnpm dmg                 # signed DMG (needs an Apple Developer ID)
```

## Layout

| Path | What lives there |
| --- | --- |
| `src/pi/` | The agent loop: PI session per bot, approval gate, tools |
| `src/agent/` | Store, permission policy, bash classification, routines |
| `src/sandbox/` | Local and Docker drivers, egress proxy, target resolution |
| `src/server/` | HTTP + WebSocket, run lifecycle, scheduler, group chat |
| `src/web/` | The UI, one file |
| `desktop/` | Electron wrapper |
| `scripts/` | Tests (see below) |
| `website/` | Product site, static. See `website/README.md` |

## Tests

```bash
pnpm test        # offline: typecheck, store, policy, routines, egress, providers
pnpm test:live   # needs ADA_TOKEN; drives a real model and a real browser
```

`pnpm test:live` includes `pnpm intent` (does the model actually reach for
`ask_choice` and `schedule_routine`?), `pnpm budget` (does a hung turn get cut
off, and does a slow human decision avoid counting as a stall?), and
`pnpm browser` (54 checks through a real Chrome).

## Known limits

- The `local` sandbox driver provides **no isolation at all** and needs
  `SANDBOX_ALLOW_LOCAL=1` to start. It's for development.
- Sandbox lifecycle is per-owner; multi-user deployment needs work beyond this.
- `Sandbox.exec` takes a timeout but no `AbortSignal`, so a running command
  can't be interrupted — only waited out or timed out. The turn budget works
  around this by abandoning the session rather than blocking on it.
- App Store distribution is structurally impossible: App Sandbox forbids
  spawning shells and talking to the Docker socket. A signed DMG is the path.
