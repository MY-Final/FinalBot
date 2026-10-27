# FinalBot

FinalBot is a personal agent control plane. It connects messaging channels to isolated
coding-agent runs, keeps the run state durable, and exposes the whole lifecycle through a
web console.

The first supported path is intentionally narrow:

```text
NapCat / OneBot v11 -> FinalBot -> Git worktree -> Codex app-server -> web console
```

## What Is Here

- Bun + TypeScript control plane
- SQLite WAL persistence with inbox, run, phase, approval, cursor and outbox tables
- OneBot v11 WebSocket adapter for private and group messages
- Codex app-server JSON-RPC adapter with streaming, approval and interrupt
- Isolated Git worktree per run
- Responsive React console with live execution, approvals and checkpoints
- Single-file server build, Docker image and desktop launcher

## Quick Start

Requirements:

- Bun 1.4+
- Git
- Codex CLI for real agent runs

```powershell
bun install
Copy-Item .env.example .env
$env:FINALBOT_FAKE_AGENT = "1"
bun run dev
```

Open `http://127.0.0.1:8787`. The fake agent exercises the full UI and persistence path.

For a real run, set `FINALBOT_REPO_PATH` to a Git repository root and set
`FINALBOT_FAKE_AGENT=0`. The path must have at least one commit because FinalBot creates a
detached worktree for every run.

## NapCat

Configure NapCat to expose a forward WebSocket, then set:

```text
NAPCAT_WS_URL=ws://192.168.1.20:3001
NAPCAT_ACCESS_TOKEN=...
NAPCAT_ACCOUNT_ID=...
NAPCAT_PRIVATE_USER_IDS=10001,10002
NAPCAT_IGNORED_USER_IDS=
```

FinalBot connects to NapCat directly. It is not an AstrBot plugin and does not require a
bridge process.

Group messages are ignored unless they mention `NAPCAT_ACCOUNT_ID`. Set
`NAPCAT_GROUP_REQUIRE_MENTION=0` only when the bot is intentionally listening to all group
traffic. Private messages only work for accounts listed in `NAPCAT_PRIVATE_USER_IDS`; an
empty list rejects all private messages. `NAPCAT_IGNORED_USER_IDS` is a global denylist for
known bot accounts and other senders that must never trigger an agent run.

## Commands

```powershell
bun run check
bun run build
bun run build:windows
bun run build:desktop
docker compose up --build
```

`build:windows` and `build:desktop` produce standalone executables under `dist/`.

## Design Boundaries

- FinalBot owns routing, run state, approvals, recovery and notifications.
- A coding agent owns its native thread and execution details. FinalBot stores only the
  native thread ID and turn ID needed to resume.
- Recovery is at-least-once. External side effects must be made idempotent rather than
  assumed to be exactly-once.
- The Docker image runs the control plane and agent in the same container for the first
  release. A separate execution runner is a later scaling boundary.

## License

FinalBot is currently private. Reference repositories in the parent directory are not
vendored into this codebase.
