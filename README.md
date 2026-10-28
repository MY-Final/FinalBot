# FinalBot

FinalBot is a single-Owner personal assistant control plane. It receives messages from
Web, OneBot/NapCat, and the QQ official bot API, then routes each conversation to a
configurable Bot backed by Codex or another coding-agent adapter.

```text
IM / Web
  -> Channel adapter
  -> durable message + cursor
  -> Owner / group policy / Discuss gate
  -> Bot and tool snapshot
  -> workspace + Codex app-server
  -> streaming output, approvals, interruption
  -> SQLite checkpoint + outbox / SSE
```

## Included

- Platform-neutral Channel API with Web, OneBot v11, and QQ official adapters
- Durable inbound messages, run-to-message links, cursor recovery, and SSE replay
- One-time Owner pairing across private and group identities
- Per-conversation Bot routing, mention-only defaults, and observe-all mode
- Discuss gate for ambient group messages with a durable 3-second batch window
- Owner, Bot, and Scratchpad memory scopes with FTS5 keyword search
- Immutable tool snapshots for built-in memory tools, remote MCP tools, and Code Mode
- QuickJS Code Mode with persisted call journals and safe resume
- Sub Agents, guarded cross-Bot dispatch, and durable cron schedules
- Git worktrees, shared directories, or isolated scratch workspaces
- SQLite WAL recovery, chunked outbox retries, and a responsive React console
- Single-file Windows launcher and a Debian-based Docker image

## Requirements

- Bun 1.4+
- Git
- Codex CLI for real Codex runs
- Docker only when using the container image

## Quick Start

```powershell
bun install
Copy-Item .env.example .env
$env:FINALBOT_FAKE_AGENT = "1"
bun run dev
```

Open `http://127.0.0.1:8787`. The fake agent exercises the API, event stream, approvals,
messages, and recovery paths without starting Codex.

For real runs:

```text
FINALBOT_FAKE_AGENT=0
FINALBOT_REPO_PATH=D:\WorkSpace\your-project
FINALBOT_CODEX_BIN=codex
```

The repository must contain at least one commit before FinalBot can create a detached
worktree for a coding Run.

## OneBot / NapCat

NapCat exposes a forward WebSocket. FinalBot connects directly and does not require a
bridge plugin.

```text
NAPCAT_WS_URL=ws://192.168.1.20:3001
NAPCAT_ACCESS_TOKEN=...
NAPCAT_ACCOUNT_ID=...
NAPCAT_PRIVATE_USER_IDS=10001
NAPCAT_IGNORED_USER_IDS=
NAPCAT_GROUP_REQUIRE_MENTION=1
```

Private messages from users outside `NAPCAT_PRIVATE_USER_IDS` are rejected. Group
messages can be observed for context, but only the paired Owner can trigger Runs,
execute IM commands, or resolve approvals.

## QQ Official Bot

The first QQ integration supports C2C private messages and group
`GROUP_AT_MESSAGE_CREATE` events. Guilds and channels are intentionally out of scope.

```text
FINALBOT_QQ_ENABLED=1
FINALBOT_QQ_APP_ID=...
FINALBOT_QQ_APP_SECRET=...
```

QQ official replies require the inbound `msg_id` and a monotonic `msg_seq`. The adapter
declares `proactiveSend=false`; schedules cannot target a QQ official conversation.
Long output is split up to the passive reply quota and visibly marked as truncated.

`FINALBOT_QQ_TOKEN_URL`, `FINALBOT_QQ_API_BASE_URL`, and
`FINALBOT_QQ_GATEWAY_URL` are optional test/proxy overrides.

## Owner Pairing

1. Open the Web console and generate a 10-minute pairing code.
2. Send `/pair <code>` from the intended Owner account in a private chat.
3. Group and thread identities can then be matched through shared platform aliases.

Unbound group members can contribute observed context but cannot trigger work. Group
approval details are sent privately to the Owner; the group only receives a safe notice.

## IM Commands

```text
/help
/status
/approve [approval-id]
/approve_session [approval-id]
/deny [approval-id]
/cancel
/bots
/use <bot>
/bot <bot> <task>
```

Only the paired Owner can execute these commands.

## Memory And Tools

Memory tools are explicit; FinalBot does not automatically extract memories every turn.

- Owner memory is shared across Bots and channels.
- Bot memory is isolated by `botId`.
- Scratchpad data is isolated by `conversationId + botId`, defaults to a 7-day TTL, and
  uses revision-based optimistic concurrency.
- Writes larger than 16 KiB, secret-looking content, stale revisions, and cross-Bot reads
  are rejected.

MCP servers support local stdio and Streamable HTTP. Credentials are never stored
directly: configuration contains environment-variable references only. Tool policies
default to `ask` and can be set to `auto` or `deny`. Each Run records an immutable tool
snapshot hash and revision.

## Code Mode

Code Mode executes JavaScript in QuickJS. It exposes `tools.<namespace>.<tool>()` only:
file, shell, network, process, `require`, and timer APIs are not bridged.

```js
const found = await tools.memory.search({ query: "release checklist" });
return found.map((item) => item.id);
```

Approval waits persist the code and completed tool calls by deterministic call index.
`code/resume` replays the journal in a fresh QuickJS runtime so completed side effects
are not called again.

## Scripts

```powershell
bun run check
bun run lint
bun run build
bun run build:windows
bun run build:desktop
```

`build` creates the platform server executable with the compiled Web UI embedded.
`build:windows` and `build:desktop` produce launchers under `dist/`.

## Docker

```powershell
$env:FINALBOT_ADMIN_TOKEN = "replace-with-a-long-random-value"
$env:FINALBOT_PROJECT_PATH = "D:\WorkSpace\your-project"
docker compose up --build
```

The image runs Bun and Codex in one Debian container, persists `/data`, and mounts the
configured project at `/workspaces/project`.

## Security Defaults

- Default listen address is `127.0.0.1`.
- A non-loopback listen address refuses to start without `FINALBOT_ADMIN_TOKEN`.
- `/api/*` requires `Authorization: Bearer <token>` when the token is configured.
- The Web console stores the token in `sessionStorage`, not persistent local storage.
- Channel credentials are read from environment variables, not the Web UI or database.

## Verification

`bun run check` must pass before delivery. The test suite covers channel mapping, Owner
routing, migration, FTS memory, tool snapshots, Code Mode limits and resume, MCP
transports, Discuss recovery, outbox behavior, Sub Agents, cross-Bot guards, schedules,
and restart recovery.

## License

FinalBot is currently private. Reference repositories in parent directories are not
vendored into this codebase.
