# Agents & Delegation — Design Spec

**Date:** 2026-07-10
**Status:** Approved design → implementation

## Summary

Add an **orchestrator-worker ("master/slave") delegation** capability to the session manager. From any session (the *master*), you delegate a follow-up job — review it, publish it to npm, write a migration guide, whatever — to a **background agent** that runs headless, unattended, with a self-contained briefing of what the master session did. You don't wait; a status card tells you when it's done and lets you open the result.

Agents are **user-definable from the UI** — not a fixed hardcoded set. An agent is a tiny config bundle (name, prompt, model, permission), so users create their own for their own pain points.

## Prior art (why this shape)

- **Anthropic's multi-agent research system** — orchestrator-worker; each subagent gets a *self-contained task description + fresh context window*, no shared live memory. Minimal info-sharing is intentional.
- **Claude Code subagents** — "the only channel from parent to subagent is the prompt string; that delegation message is the subagent's entire briefing."
- **opencode-background-agents** — async "waiter model": fire a task, keep working, retrieve later; results persisted to markdown on disk; lifecycle `registered → running → terminal`; background delegation defaults read-only.

The design follows this consensus: **context crosses as a briefing baked into the prompt, not as shared memory** — which we already generate via the context-extraction digest.

---

## Concepts

### Agent

A reusable delegation profile. Stored in `data/agents.json` as `{ [id]: Agent }`.

```ts
type Agent = {
  id: string;
  name: string;
  emoji: string;            // shown on the dock tile
  prompt: string;           // the instruction, e.g. "Review these changes for security bugs and write tests"
  model: string | null;     // "sonnet" | "opus" | "haiku" | "fable" | null (inherit default)
  permission: "read-only" | "edit";
};
```

- **read-only** → launched with `--disallowedTools "Edit,Write,NotebookEdit"`. Can read the whole repo, run commands, search the web/MCPs — just can't mutate files. (Research, analysis, audits.)
- **edit** → launched with `--dangerously-skip-permissions`. Full write access, auto-approved. (Publish, codegen, fixes.)

**Seeded presets** (first run, if `agents.json` is absent) — ordinary editable agents, no special-casing:
- 🔬 **Research** (read-only) — "Research and think through the topic; report options, tradeoffs, and a recommended plan. Do not edit files."
- 📦 **Publish to npm** (edit) — "Verify the package builds and tests pass, bump the version appropriately, and publish it to npm. Report exactly what you published."

### Delegation

One background job = one run of an agent against a master session. Stored one-file-per-job at `data/delegations/<id>.json`.

```ts
type Delegation = {
  id: string;
  agentId: string;
  agentName: string;        // denormalized so the card renders even if the agent is later deleted
  agentEmoji: string;
  sessionId: string;        // the master session
  sessionLabel: string;     // denormalized master name/first-message for the card
  cwd: string;              // master's project dir; the agent runs here
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt: number | null;
  result: string | null;    // markdown, on success
  error: string | null;     // stderr / message, on failure
  pid: number | null;        // the detached claude process, for liveness
};
```

---

## Context handoff (the master→slave briefing)

When a delegation starts, the prompt handed to the agent is composed as:

```
<agent.prompt>

--- CONTEXT FROM THE SESSION YOU ARE CONTINUING ---
<briefing>

Files that session changed (read/inspect as needed — you are NOT limited to these):
- <path 1>
- <path 2>
--- END CONTEXT ---
```

- `<briefing>` is produced by the **existing `buildTranscriptDigest(masterTranscriptPath)`** — a bounded, recency-weighted condensation of the master's transcript (first message for grounding + most recent activity within a char budget). Fast, no extra model call, handles multi-MB transcripts.
- The **changed-files list** comes from the master session's `changedFiles` (already parsed from its `Edit`/`Write` tool calls during `scanTranscript`).

**Scope of what the agent reads:** the changed-files list *focuses* the agent; it does **not** sandbox it. The agent runs `cd`'d into the master's `cwd` with normal read tools, so it can (and for review/publish, must) read surrounding code, config, run `git diff`, etc. Read-only agents simply cannot *write*.

*Future refinement (not v1):* optionally inject actual `git diff` text for review-type agents so they see precise deltas, not just current file state.

---

## Delegation lifecycle & the fire-and-forget mechanism

This is the one genuinely new backend piece. Existing headless calls (`runClaudeHeadless`) **await** completion inside the HTTP request — fine for the ~20-40s review/extract, wrong for an unattended job you don't want to block on.

**Non-blocking spawn with disk-persisted completion:**

1. `POST /api/delegations` → build briefing, compose prompt, write the delegation record with `status:"running"` **immediately**, then `spawn` `claude -p …` **detached** (not awaited). Return `{ ok:true, delegationId }` right away.
2. The child's `stdout` is accumulated in memory; on `close`:
   - exit 0 → write `status:"done"`, `result:<stdout>`, `finishedAt`.
   - non-zero / error → write `status:"error"`, `error:<stderr or message>`, `finishedAt`.
3. The record is **persisted before** anything else, so a result survives even if the UI never polled (mirrors opencode's "persistence before notification").
4. The server keeps a small in-memory map of live child processes only for liveness/cancel; the **source of truth is the on-disk record**, so a server restart doesn't lose finished results (in-flight jobs whose process died are reconciled to `error` on next read if their pid is dead and status still `running`).

**Command construction** (reuses `claude.ts` helpers):
```
claude -p "<composed prompt>" --model <modelAliasWithContext(agent.model) or default> --effort medium \
  <--disallowedTools "Edit,Write,NotebookEdit"  |  --dangerously-skip-permissions>
```
Run via a new `runClaudeHeadlessDetached(...)` in `claude.ts` (spawn + return child immediately + onClose callback), rather than the awaited `runClaudeHeadless`.

**Timeout:** a generous cap (e.g. 20 min) after which the child is killed and the job marked `error: "timed out"`.

---

## API

| Method + path | Purpose |
|---|---|
| `GET /api/agents` | list all agents |
| `POST /api/agents` | create `{name, emoji, prompt, model, permission}` |
| `PUT /api/agents/:id` | update fields |
| `DELETE /api/agents/:id` | delete an agent (existing delegations keep their denormalized copy) |
| `GET /api/delegations` | list all delegations (newest first) |
| `POST /api/delegations` | start one: `{agentId, sessionId}` → builds briefing, spawns detached, returns `{delegationId}` |
| `GET /api/delegations/:id` | one delegation record (for polling / result) |
| `GET /delegations/:id` | server-rendered result page (reuses `markdownToHtml`), opened in a new tab |
| `GET /delegations` | server-rendered history index |

`GET /api/sessions` additionally returns `agents` and `delegations` arrays so the board renders in one round-trip (same pattern as `tickets`).

---

## UI — top Agents dock (board view)

A horizontal band pinned directly under the toolbar, above the columns. Board-only by design (list view intentionally omits it).

```
├─ toolbar ─────────────────────────────────────────────┤
│ AGENTS ▾   🔬 Research   📦 Publish-npm   ＋ New agent  │  ← drop a session card up onto a tile
│ JOBS       ⏳ Research→wishlist   ✓ Publish→sdk ↗       │  ← click a finished job to open its result
├────────────────────────────────────────────────────────┤
│ All sessions │ In Progress │ Priority │ … │  ＋         │
```

- **Agent tile** = drop target. Dropping a session card on it → `POST /api/delegations` → a ⏳ chip appears in the JOBS row.
- **Click an agent tile** → edit modal (name+emoji, prompt, model, permission).
- **＋ New agent** → same modal, blank → `POST /api/agents`.
- **JOBS row** = the recent delegations (running + latest done/error) as chips: ⏳ running, ✓ done, ✗ error. Click ✓/✗ → opens `/delegations/:id` in a new tab. A "see all" link → `/delegations` history page.
- **AGENTS ▾** collapses the whole band for max column room (state persisted in localStorage).
- Drag mechanics reuse the existing board drag payload (`"card:<id>"`); the dock tiles are new drop zones alongside the existing column drops. The pre-existing single 🔎 Reviewer drop-zone is removed in favor of this dock.
- Polling: the existing 15s `loadSessions()` refresh updates job chip status; no new polling loop.

Colors: agent tiles use the accent/ticket palette to read as "actions," visually distinct from session cards.

---

## Decisions

- **Execution model:** fully autonomous headless (chosen option A). No interactive terminal for delegations.
- **Chaining:** one-shot only (chosen option A). To publish a reviewed change, drop the session onto Publish yourself. No auto-pipelines in v1.
- **Custom agents:** yes — user-definable via the ＋ New agent form (4 fields).
- **Open decision #4 (resolved, since superseded):** at the time this was written, a specialized 🔎 Review → Fix (all/selected) flow existed separately with a richer report+fix loop than a generic agent, so the Agents system stayed additive rather than seeding a generic "Reviewer" preset. That standalone review feature has since been removed entirely (unused); presets remain Research + Publish-to-npm.
- **Cost note:** multi-agent delegation multiplies token spend (Anthropic saw ~15x for their research fan-out). One-shot single delegations are far cheaper than that, but each still runs a full agent — worth surfacing in the UI copy ("runs a full Claude session in the background").

---

## Reuse map (how little is actually new)

| Need | Reuse |
|---|---|
| briefing of master | `buildTranscriptDigest` (exists) |
| changed files | `Session.changedFiles` (exists) |
| command flags (model[1m], effort, dangerous, disallowed) | `claude.ts` builders (exist) |
| result page HTML | `markdownToHtml` (exists) |
| history index page | modeled on the now-removed `/reviews` page's index-list pattern |
| sidecar CRUD pattern | mirror tickets store (exists) |
| board drag + poll | existing board dnd + 15s refresh (exists) |

**Genuinely new:** `runClaudeHeadlessDetached` (non-blocking spawn + onClose persist), the agents + delegations stores/routes, and the dock UI.

## Error handling & edge cases

- Master session not found / no transcript → 404, no job created.
- Agent deleted mid-flight → job unaffected (denormalized name/emoji/permission captured at creation).
- Server restart with a job still `running` whose pid is dead → reconciled to `error: "process ended without result"` on next `GET`.
- Empty stdout on exit 0 → `done` with a "(agent produced no output)" result body.
- Delete a delegation → removes its file; running one is killed first.
