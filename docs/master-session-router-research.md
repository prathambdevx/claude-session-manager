# Master Session Router — Feasibility Research

**Date:** 2026-08-27
**Status:** Research only — no design/implementation yet

## The idea

A single "master" Claude Code session that receives any incoming task/prompt and decides:

1. **Which existing session** (already running, already has relevant context/project loaded) should handle it, and forwards the prompt into that session, **or**
2. If nothing existing fits, **spin up a new session** to handle it.

This is different from the delegation feature in [`agents-and-delegation.md`](./agents-and-delegation.md), which is one-directional (master → fresh background agent, self-contained briefing, no existing-session awareness). This idea is a *router*: pick from a pool of live sessions based on their current context, not always spawn fresh.

## Verdict: buildable, but the "intelligence" is entirely on us

Claude Code gives real plumbing for every mechanical piece of this. It does **not** give you the routing decision itself — there is no built-in "supervisor session" primitive that reads other sessions' context and decides where a task belongs. That logic is 100% our code.

## What Claude Code already provides

| Need | Mechanism | Source |
|---|---|---|
| Enumerate existing sessions + state | `claude agents --json` (state: Needs input / Working / Completed / Ready for review; includes `cwd`, `sessionId`) | [agent-view.md](https://code.claude.com/docs/en/agent-view.md) |
| Enumerate sessions from *within* a session | `/list-agents` command, or the `ListAgents` tool (also exposed to us directly — confirmed it's in our own toolset) | [agent-view.md](https://code.claude.com/docs/en/agent-view.md) |
| Forward a prompt into a specific existing session | `claude --resume <session_id> -p "<prompt>"` (headless, callable repeatedly by an external process) | [headless.md](https://code.claude.com/docs/en/headless.md) |
| Continue the *most recent* session in a dir | `claude --continue` | [headless.md](https://code.claude.com/docs/en/headless.md) |
| One session messaging another directly | `SendMessage` tool — plain-text, by session name; rate-limited, ~1M char cap, refuses rapid bursts | [cross-session-messaging.md](https://code.claude.com/docs/en/cross-session-messaging.md) |
| Spin up a brand new session for a task | `claude --bg "prompt"`, or `@<repo>` mention / `--cwd` to target a directory | [agent-view.md](https://code.claude.com/docs/en/agent-view.md) |
| Native experimental multi-agent orchestrator | **Agent Teams** (disabled by default) — one session is "team lead," coordinates via a shared task list; teammates each get their own context window and can talk to each other directly | community sources (Shipyard, Anthropic release notes) — worth double-checking current docs before relying on it, this is newer/experimental |
| In-session subagent dispatch (not the same thing) | Subagents — natural-language routing via each agent's `description` field, or forced via `@agent-name` / `claude --agent <name>`. 20 concurrent, 200/session cap, 3 levels of nesting | community sources + our own agent-teams tooling in this session |

## What it does NOT provide

- **No routing intelligence.** Nothing in Claude Code decides "this task is about the payments repo, session B has that context loaded, send it there." We'd have to build that — e.g. an LLM call (or the master session itself, via tool use) that reads session metadata (cwd, recent transcript summary, project name) and picks a target.
- **No documented concurrency guarantees for `--resume`.** No official guidance on what happens if `--resume -p` is called while that session's own terminal window is also active and someone is mid-keystroke. **Our own CLAUDE.md already encodes the answer we settled on for Quick Prompt: "Resume refuses to open a second terminal while a headless job is still running."** Any router needs the same discipline — never send into a session that's mid-turn.
- **No cross-session shared memory.** Each session's context is its own; a router can only see what session metadata/transcripts expose from the outside (which is exactly what claude-session-manager already reads from `~/.claude/projects/*.jsonl` and `~/.claude/sessions/*.json`).

## Why this is a good fit for claude-session-manager specifically

We already have every read-side ingredient:

- Session enumeration + live state (`sessions.ts`, the `~/.claude/sessions/*.json` poll + SSE push)
- Transcript access for context (`~/.claude/projects/**/*.jsonl`)
- A working "inject a prompt into a session" path with **both** delivery modes already built (`routes/quickPrompts.ts`): AppleScript keystroke injection when the terminal is open, headless `claude --resume <id> -p …` when it's closed — including the exact "don't double-send while headless job running" guard this research flagged as necessary.

So the router wouldn't need new plumbing to *deliver* — it needs a **new decision step** in front of the existing Quick Prompt delivery path: given an incoming task, look at all sessions' cwd/project/recent-transcript-summary, either pick one and route the prompt through the existing Quick Prompt mechanism, or launch a new session (existing launch path) if nothing fits.

## Rough shape of a v1 (not a commitment — for discussion)

1. **Master entry point**: a special "route this" input (own view/command, not a normal session) that takes free text.
2. **Candidate gathering**: pull `{ sessionId, cwd, projectName, lastNTranscriptLines/summary, liveState }` for every active/recent session — data we already have.
3. **Routing decision**: one Claude call (Haiku/Sonnet, cheap+fast) given the task + candidate list, asked to pick an existing session ID **or** "new session in <suggested dir>", with a short justification.
4. **Delivery**: reuse Quick Prompt's existing dual-path (keystroke vs headless resume) for an existing-session match; reuse the existing session-launch path for a new one.
5. **Guardrail**: never route into a session whose live state shows it's mid-turn (headless job running or actively streaming) — queue or reject instead.

## Open questions to resolve before building

- Does "Agent Teams" (native, experimental, disabled by default) end up being a better foundation than hand-rolling this once it matures — worth re-checking docs periodically.
- What signal is "context" for routing — raw last-N transcript lines, an LLM-generated running summary per session (cached, updated on new turns), or just cwd/project name for a cheap v1?
- Where does an ambiguous/unroutable task go — new session by default, or ask the user?

## Sources

- [Claude Code — Agent View docs](https://code.claude.com/docs/en/agent-view.md)
- [Claude Code — Headless mode docs](https://code.claude.com/docs/en/headless.md)
- [Claude Code — Cross-session messaging docs](https://code.claude.com/docs/en/cross-session-messaging.md)
- [Claude Agent SDK — Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [MindStudio — Orchestrate Multiple Claude Code Sessions](https://www.mindstudio.ai/blog/orchestrate-multiple-claude-code-sessions-ralf-loop)
- [MindStudio — Claude Code Parallel Sessions](https://www.mindstudio.ai/blog/claude-code-parallel-sessions)
- [Shipyard — Multi-agent orchestration for Claude Code in 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [DEV Community — Orchestrator-worker system for Claude Code](https://dev.to/mohamed9974/how-i-built-an-orchestrator-worker-system-for-claude-code-2i37)
- Existing project doc: [`agents-and-delegation.md`](./agents-and-delegation.md) (related, one-directional prior art already implemented here)
