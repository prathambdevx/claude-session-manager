# Claude Session Manager.

A local dashboard for managing your [Claude Code](https://claude.com/claude-code) sessions.
Reads directly from `~/.claude/` — no database, no cloud, nothing to sync.

> **Full support is Mac-only** — it launches real Terminal/Ghostty windows. Windows has early,
> partial support: the dashboard runs and auto-starts, but terminal-launching features (Resume,
> New Task, etc.) aren't wired up yet there.

---

## Install

**Mac:**

```bash
curl -fsSL https://raw.githubusercontent.com/prathambdevx/claude-session-manager/main/bootstrap.sh | bash
```

**Windows (early support):**

```powershell
powershell -c "irm https://raw.githubusercontent.com/prathambdevx/claude-session-manager/main/bootstrap.ps1 | iex"
```

Then open `http://127.0.0.1:4321`. To remove auto-start later: `bun run setup -- --uninstall`

The server runs as a long-lived background process, so editing a file under `backend/` doesn't
take effect until it restarts:

```bash
bun run restart
```

Frontend files (`frontend/`) don't need this — they're served raw from disk, so a browser refresh
alone picks up the change.

## Features

- **Resume** — double-click any session card to resume it in a real terminal.
- **Quick Prompt** — send a prompt in the background and see its live progress, no terminal needed.
- **Kanban board** — organize sessions into columns, drag and drop between them.
- **Context gauge** — how full each session's context window is, updated live.
- **Search** — keyword filter, plus Claude-powered semantic search across all sessions.
- **Prompt modal** — write a prompt directly in a modal, paste an image straight into it.

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
