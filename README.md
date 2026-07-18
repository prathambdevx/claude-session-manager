# Claude Session Manager

A local dashboard for managing your [Claude Code](https://claude.com/claude-code) sessions on Mac.
Reads directly from `~/.claude/` — no database, no cloud, nothing to sync.

> **macOS only** — it launches real Terminal/Ghostty windows and installs a `launchd` agent.

---

## Install

Requires [Bun](https://bun.sh) and the `claude` CLI on your PATH.

```bash
git clone https://github.com/prathambdevx/claude-session-manager.git ~/tools/claude-sessions
cd ~/tools/claude-sessions
bun run setup
```

That's it — one command. It starts the server and keeps it running in the background (auto-starts
on login too), then open `http://127.0.0.1:4321`.

To remove auto-start later: `bun run setup -- --uninstall`

## Features

- **Session list** — every session, grouped by project, most recently active first. Green dot =
  live process, live chip = actually working right now.
- **Kanban board** — Main board, a Projects view (auto-organized by project), each project's own
  board, and saved views. Drag sessions between columns.
- **Resume / Fork** — reopen a session in a real terminal, or fork it into a new one.
- **Close terminal** — close a session's terminal window straight from its card.
- **Quick Prompt** — send a prompt in the background and see its live progress, no terminal needed.
- **Image paste** — paste an image straight into any prompt field.
- **Tickets** — notes for later, one click to turn into a real session.
- **Context gauge** — how full each session's context window is, updated live.
- **Auto-description** — one click to summarize a session into a short label.
- **Search** — keyword filter, plus Claude-powered semantic search across all sessions.

## How it works

- **Backend** (`backend/`) — a Bun HTTP server. `config.ts`/`constants.ts` for settings vs. fixed
  paths, `store.ts` for JSON persistence, `sessions/` for transcript scanning, `claude/` for CLI +
  Terminal/Ghostty control, `routes/` per resource.
- **Frontend** (`frontend/`) — plain ES modules, no framework, no bundler. Edit a file, reload.
- **Storage** — everything this tool persists (tickets, notes, board layouts, reports) lives in
  `data/` (gitignored). Sessions themselves are never copied — always read live from
  `~/.claude/projects/`.

## Configuration

Edit `backend/src/config.ts`:

```ts
export const DEFAULT_MODEL = "sonnet"; // sonnet | opus
export const DEFAULT_EFFORT = "medium"; // low | medium | high
export const EXTENDED_CONTEXT = true; // 1M-context — only if your plan actually has access
```

Then run `bun run config` to push `model`/`effortLevel` into your real `~/.claude/settings.json`,
so the same defaults apply everywhere, not just from this app.
