# Claude Session Manager

A local, single-page dashboard for managing every [Claude Code](https://claude.com/claude-code)
session on your Mac — the way you manage files and folders. It reads directly from what Claude Code
already writes to `~/.claude/`, so there's no database, no cloud, and nothing to sync: it's a thin,
fast layer over state you already have.

List every past session across every project, search them (including a Claude-powered semantic
search), organize them on a drag-and-drop kanban board, resume or fork any of them into a real
terminal, and run purpose-built agents (reviewer, research, context-extractor, and your own custom
agents) against them.

> **macOS only.** It launches real Terminal windows and installs a `launchd` agent, both of which
> are macOS-specific.

---

## Install

Requires [Bun](https://bun.sh) and the `claude` CLI on your PATH.

```bash
git clone https://github.com/prathambdevx/claude-session-manager.git ~/tools/claude-sessions
cd ~/tools/claude-sessions
bun run setup          # installs auto-start, launches the server, then open http://127.0.0.1:4321
```

`bun run setup` does the important part: it installs a `launchd` user agent so the server
**starts automatically on every login and restarts itself if it ever dies** — so it's always
running at `http://127.0.0.1:4321` without you having to start it again after a reboot. It figures
out your machine's real `bun` path and install location automatically (nothing hardcoded).

- **Just run it once, no auto-start:** `bun run start`
- **Remove auto-start later:** `bun run setup -- --uninstall`

The server reads your local `~/.claude/projects/**/*.jsonl`, so it shows all your own sessions.

---

## What it does

- **Every session, browsable** — grouped by project, sorted by most recent activity (the session
  you're actively working in floats to the top). A green dot marks sessions whose `claude` process
  is still alive (verified by PID, not guessed).
- **Board & list views** — a kanban board (All sessions / In Progress / Priority / Research / Done,
  columns renamable + reorderable) or a flat list. Drag sessions between columns.
- **Resume / Fork** — opens the session in a new Terminal window (`claude --resume <id>` /
  `--fork-session`), `cd`'d into its real project directory. Resume reuses an already-open tab if the
  session is still running instead of spawning a duplicate.
- **Tickets** — note-only cards (no session started) for work to do later, in a distinct color,
  convertible into a real session in one click.
- **Context-usage bar** — green/yellow/red gauge of how full each session's context window is, read
  from the token counts Claude logs per turn.
- **Auto-descriptions** — one click summarizes a session into a short label so you don't have to
  guess what "session 3" was.

## Search

Two searches: a fast keyword filter (names, branches, tags), and a **Claude-powered global search** —
describe a session in your own words ("the one where I refactored the hamburger menu into
sub-components") and it finds it even across hundreds of sessions. It works as a pipeline: broad
keyword recall → co-occurrence density re-rank → a Claude call that reads the actual matched snippets
and picks the genuine matches. Optional date scoping (last 7 / 30 days / all time).

## Agents

Run scoped agents against any session, using that session's transcript + changed files as context:

- **Reviewer** — read-only senior-engineer code review of exactly what a session changed, as a
  numbered plain-English report; fix findings selectively or all at once.
- **Research** — read-only (physically blocked from editing files); researches and reports a plan.
- **Context extractor** — condenses a long session into a short briefing to seed a fresh session
  when you're near the context limit.
- **Custom agents + delegation** — define your own reusable agents (name, prompt, model, permission)
  and delegate a session to one as a background job, with a live activity feed and a saved report.

---

## How it works

- **Backend** — a small [Bun](https://bun.sh) HTTP server (`server.ts` + `src/`), split into focused
  modules: `config`, `store` (JSON-file persistence), `sessions` (transcript scanning + search),
  `claude` (CLI + Terminal launching + prompt builders), `html` (report pages), `routes`.
- **Frontend** — a buildless single page (`public/index.html` + `styles.css` + `app.js`). No
  framework, no bundler.
- **Storage** — plain JSON files under `data/` (gitignored): your tickets, per-session metadata,
  custom agents, review reports, context briefings, and delegation outputs. Board *column
  definitions* live in browser `localStorage`.
- **Sessions themselves are never stored here** — they're read live from `~/.claude/projects/`, so
  the tool always reflects the machine it runs on and never copies your transcripts anywhere.

### Data & privacy

The only writes this tool makes to `~/.claude/` are deletes you explicitly confirm. Everything it
persists lives in `data/`, which is gitignored — your session names, tickets, notes, and review
reports stay on your machine and are never committed.

---

## Configuration

Everything works out of the box on a standard Claude account. To override defaults, create
`data/settings.json` (gitignored, per-machine) — every field is optional:

```json
{
  "port": 4321,
  "claudeBin": "/Users/you/.local/bin/claude",
  "effort": "medium",
  "extendedContext": false
}
```

- **`extendedContext`** — set to `true` only if your account has the extended **1M-context**
  Sonnet/Opus models. When on, launched sessions use the `[1m]` model variant and the context gauge
  measures against 1M. **Leave it `false` (the default) on a standard account** — otherwise launches
  would request a model your account can't use and fail. This is the one setting that matters for
  portability; the rest are conveniences.
