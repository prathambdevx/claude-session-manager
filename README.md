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
bun run setup          # installs auto-start, then open http://127.0.0.1:4321
```

- `bun run setup` installs a `launchd` agent so it starts on login and stays running.
- `bun run start` — just run it once, no auto-start.
- `bun run setup -- --uninstall` — remove auto-start.

## Features

- **Browse every session**, grouped by project, most recently active first. A green dot marks a
  live process; a live "busy" chip shows when Claude is actually working right now.
- **Kanban board with a sidebar** — Main board (your own columns), a **Projects** view (one column
  per project, always kept in sync, draggable/hideable but not deletable), each project's own
  board, and any number of **saved views**. Every board has Manage Columns + Undo. Dragging a
  session into a column only affects that one board — never bleeds into another.
- **Resume / Fork** into a real terminal, reusing an already-open window instead of duplicating it.
  **Close terminal** closes it again without stealing focus.
- **Quick Prompt (⚡)** — send a follow-up task without opening a terminal; runs in the background
  or types into an open one, with live progress on the card. Paste images directly into any prompt
  field.
- **Tickets** — note-only cards for later, one click to convert into a real session.
- **Context-usage gauge** per session, accurate through compaction and mid-session model switches.
- **Auto-descriptions** — one click to summarize a session into a short label.
- **Search** — fast keyword filter, plus a Claude-powered semantic search across all your sessions.
- **Agents** — Reviewer, Research, Context extractor, and your own custom agents you can delegate a
  session to as a background job.

## How it works

- **Backend** (`backend/`) — a Bun HTTP server. `config.ts`/`constants.ts` for settings vs. fixed
  paths, `store.ts` for JSON persistence, `sessions/` for transcript scanning, `claude/` for CLI +
  Terminal/Ghostty control, `routes/` per resource.
- **Frontend** (`frontend/`) — plain ES modules, no framework, no bundler. Edit a file, reload.
- **Storage** — everything this tool persists (tickets, notes, board layouts, agents, reports)
  lives in `data/` (gitignored). Sessions themselves are never copied — always read live from
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
