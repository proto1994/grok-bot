# Bots

Persistent AI teammates with their own sandbox computers. You create a bot, give
it a job, and it keeps working on that job across restarts — on your machine or
on a remote sandbox, with you approving the actions that matter.

Modeled on [Cursor's Grok Bot](https://cursor.com/docs/grok-bot), built to run
against an internal AI gateway rather than a vendor API key.

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
cp .env.example .env     # fill in ADA_TOKEN and ADA_BASE_URL
pnpm dev                 # http://localhost:4000
```

The API is behind a bearer token. One is generated into `.env` on first run if
`AUTH_TOKEN` is empty; the web UI picks it up automatically on localhost.

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
pnpm test        # offline: typecheck, store, policy, routines, egress, targets
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
