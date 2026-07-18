# Claude Session Manager

A local, single-page dashboard for managing every [Claude Code](https://claude.com/claude-code)
session on your Mac — the way you manage files and folders. It reads directly from what Claude Code
already writes to `~/.claude/`, so there's no database, no cloud, and nothing to sync: it's a thin,
fast layer over state you already have.

Browse every past session across every project, search them (including a Claude-powered semantic
search), organize them on a drag-and-drop kanban board (with an always-fresh "Projects" view and
saved custom views), resume or fork any of them into a real terminal, dispatch a follow-up prompt
in the background with no terminal at all, and run purpose-built agents (reviewer, research,
context-extractor, and your own custom agents) against them.

> **macOS only.** It launches real Terminal/Ghostty windows and installs a `launchd` agent, both of
> which are macOS-specific.

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
  is still alive; a live "busy" chip and progress bar show when a session is actually working right
  now, not just running.
- **A real kanban board, with a sidebar** — switch between **Main board** (your own columns —
  drag-reorder, rename, hide, delete, or add custom ones), an always-fresh **Projects** view (one
  column per project, auto-kept in sync — draggable, hideable, and renameable, but never
  deletable, since it's not something you build by hand), each **individual project's own board**,
  and any number of **saved views** (named snapshots of a column layout you can jump back to).
  Every board has its own "⋮ Manage columns" panel (hide/reorder/rename in one place) and its own
  Undo.
- **Independent per-board card placement** — dragging a session into a custom column only affects
  *that* board. The same session can sit in different columns on Main board, a saved view, and a
  project's own board simultaneously, with zero cross-talk.
- **Resume / Fork** — opens the session in a Terminal/Ghostty window (`claude --resume <id>` /
  `--fork-session`), `cd`'d into its real project directory. Resume reuses an already-open window
  instead of spawning a duplicate; a **Close terminal** action on the card can close that window
  again without ever stealing your focus.
- **Quick Prompt (⚡)** — hand a session a follow-up task without opening a terminal at all. It
  delivers straight into an already-open terminal if there is one, or resumes the session headless
  in the background otherwise; progress shows as a live chip right on the card. Prompt fields
  (Quick Prompt, New Task) support pasting an image directly, shown inline as `[Image 1]` just like
  Claude Code's own CLI.
- **Tickets** — note-only cards (no session started) for work to do later, in a distinct color,
  convertible into a real session in one click.
- **Context-usage bar** — a per-session green/yellow/red gauge of how full the context window is,
  correct even when a session compacts mid-conversation or switches model tier partway through.
- **Auto-descriptions** — one click summarizes a session (sampling its opening *and* its ending, so
  a session that pivoted partway through still gets an accurate label) into a short line so you
  don't have to guess what "session 3" was.

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

- **Backend** (`backend/`) — a small [Bun](https://bun.sh) HTTP server (`server.ts` + `src/`),
  split into focused modules: `config`/`constants` (the handful of user-facing settings vs. fixed
  internal paths), `store` (JSON-file persistence), `sessions/` (transcript scanning, search,
  auto-summary, context extraction — split by concern), `claude/` (CLI invocation, Terminal/Ghostty
  launching + focusing + closing, prompt builders — one file per concern), `routes/` (one file per
  resource), `fsWatcher`/`sse` (live push updates instead of pure polling).
- **Frontend** (`frontend/public/`) — a buildless page (`index.html` + `styles.css`), with the
  JS split into small ES modules under `frontend/src/` (`ui/` primitives → `subcomponents/` →
  `components/` → `pages/`, wired up by `main.js`). No framework, no bundler — editing a module is
  live on the next browser reload.
- **Storage** — plain JSON files under `data/` (gitignored): your tickets, per-session metadata,
  custom agents, review reports, context briefings, delegation/quick-prompt outputs, and every
  board's own column layout (Main board, the Projects view, each project's own board, and every
  saved view each get their own file — none of this lives in browser `localStorage`).
- **Sessions themselves are never stored here** — they're read live from `~/.claude/projects/`, so
  the tool always reflects the machine it runs on and never copies your transcripts anywhere.

### Data & privacy

The only writes this tool makes to `~/.claude/` are deletes you explicitly confirm, plus (only if
you run `bun run config`, see below) `model`/`effortLevel` in your real `~/.claude/settings.json`.
Everything else it persists lives in `data/`, which is gitignored — your session names, tickets,
notes, and review reports stay on your machine and are never committed. Pasted images are written
to a temp file in the OS temp directory (not this repo), referenced by path in the prompt text.

---

## Configuration

Open `backend/src/config.ts` — it's three plain values, meant to be hand-edited:

```ts
export const DEFAULT_MODEL = "sonnet"; // sonnet | opus
export const DEFAULT_EFFORT = "medium"; // low | medium | high
export const EXTENDED_CONTEXT = true; // 1M-context model variant — needs a plan with real access to it
```

- **`DEFAULT_MODEL`/`DEFAULT_EFFORT`** — what new terminals launch with.
- **`EXTENDED_CONTEXT`** — whether launched Sonnet/Opus sessions use the **1M-context** `[1m]`
  model variant (and whether the context gauge measures against 1M vs. 200k). Only turn this on if
  your plan actually has access to extended context — a non-entitled account will fail to launch.
- **`--effort` compatibility** — the tool probes your installed `claude` CLI once at startup and
  simply omits `--effort` entirely on older installs that don't support the flag yet, instead of
  crashing every launch.

After changing any of these, run:

```bash
bun run config
```

This pushes `model`/`effortLevel` into your **real** `~/.claude/settings.json` (read-merge-write —
only those two keys are ever touched, everything else in that file is left exactly as it was), so
the same defaults apply everywhere you run `claude`, not just from this app.
