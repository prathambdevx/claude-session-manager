---
paths: ["backend/src/**/*.ts", "backend/*.ts"]
---

# Comment style for backend TypeScript

> Scope: `backend/` — the Bun HTTP server, `claude/*` (CLI/AppleScript driving), `store.ts`
> persistence, `sessions.ts` transcript scanning, `routes/*`.
> Frontend comment style lives in `.claude/rules/comments-frontend.md` (scoped to `frontend/src/**/*.js`).

Keep comments short, human-readable, and focused on *why* — not *what*. Add them only where they
help a reader who knows TypeScript/Bun but doesn't know this app's own conventions or the OS-level
quirks it works around. Default to no comment.

Four categories apply: **type field annotations**, **inline `//` intent comments**, **one-line
handler summaries**, and **one-line `/** */` docstrings**. Everything else is noise — and if an
explanation genuinely needs more than a line, it belongs in `docs/`, not inline (see `docs/ghostty-
instance-bug-explainer.md` for the pattern: a full write-up in `docs/`, a one-line pointer at the
call site).

---

## 1. Type field annotations — explain units, encoding, invariants

Add a short `//` on the same line when the field name alone doesn't convey its shape or a
non-obvious invariant.

```ts
// ✅ Good — encoding/shape not obvious from the name alone
lastActivity: string | null; // last tool-use/thinking/text line seen — "what is it doing" now
pid: number | null;          // null once the process exits; job stays on disk as history

// ✅ Good — a real invariant a reader would otherwise have to discover empirically
contextPct: number | null;   // null until the first assistant usage entry appears in the transcript

// ❌ Bad — restates what the type already says
id: string;      // the session's id
cwd: string;     // the working directory
```

---

## 2. Inline `//` comments — explain non-obvious intent

Write a comment when a reader would stop and ask *"why?"*. If the next line reads naturally on its
own, skip it.

**OS/CLI quirks this app works around:**

```ts
// Ghostty windows are found by their csm-<id> title tag, not pid — `open -na` used to spawn a new
// process per launch, so pid was never a reliable "is this session's terminal open" signal.
// Full story: docs/ghostty-instance-bug-explainer.md
if (usingGhostty()) return ghosttyTag ? sendTextToGhosttyTerminal(ghosttyTag, prompt) : false;

// Claude Code's own status file can get stuck reporting stale "waiting" indefinitely — a recent
// transcript write counts as "actively working" too, not just status === "busy".
export function computeActivelyWorking(...) { ... }
```

**Defensive / fallback logic:**

```ts
// Ignore malformed/stale files rather than let one bad JSON entry break the whole scan
try { ... } catch { continue; }

// No transcript on disk yet — any future write counts as new
try { baselineMtimeMs = (await stat(transcriptPath)).mtimeMs; } catch { }
```

**Non-obvious conditions and ordering:**

```ts
// background:true polls must never rebuild the board out from under an open menu/rename
if (opts.background && isTransientUiOpen()) return;

// fork always creates a new session, so there's never an existing window to reuse for it
if (!fork) { ... }
```

A good inline comment explains intent, not mechanics:

```ts
// ❌ Bad — narrates the next line
// loop over the files
for (const f of files) { ... }

// ✅ Good — explains the invariant
// readdir order isn't guaranteed sorted, so re-sort by mtime before picking "most recent"
for (const f of files.sort(...)) { ... }
```

---

## 3. Route handler `//` summary comments — one line above the function

Add a single `//` comment above each exported route handler or non-trivial exported function.
Describe what it does and any non-obvious behavior — think "what you'd tell a teammate."

```ts
// Resumes an existing session's terminal if one's open; otherwise launches a new one.
export async function handleSessionsRoutes(...) { ... }

// Delivers straight into the session's open terminal if one exists; otherwise runs headless in
// the background. Never opens a new terminal itself.
export async function handleQuickPromptRoutes(...) { ... }
```

Skip it if the function name + signature already tell the full story.

---

## 4. One-line `/** */` docstrings — non-obvious function behavior

When an exported function has a subtle responsibility a reader cannot infer from its name and
signature, add a single-line JSDoc.

```ts
/** Scans the OS process table for a live `claude --resume <sessionId>` of any kind. */
export function findLiveResumeProcs(sessionId: string): Promise<LiveResumeProc[]> { ... }

/** Returns null once the pid has exited — callers must not assume a saved job is still running. */
export function pidAlive(pid: number): boolean { ... }
```

Keep it to one line. If you need more, either the function is doing too much or the explanation
belongs in `docs/`.

---

## Do not add

- Comments that **restate the code** — `// loop over sessions`, `// return the result`, `// parse JSON`.
- **Change-log notes** — `// added for quick prompt`, `// fix for resume bug`, `// refactored`.
- **References to callers or tasks** — `// used by the board`, `// for the ghostty fix`.
- **Multi-paragraph `//` blocks or docstrings.** One short line max — extract to `docs/` instead and
  leave a one-line pointer.
- **Decorative dividers** — `// ====`, `// --------`.
- **Author tags** — git blame is authoritative.
- **Commented-out code** — delete it.

---

## Final rule

When in doubt, **skip the comment**. A well-named function and a small scope beat any comment. Only
comment where a future reader — who knows TypeScript but not this app's own OS-level quirks or
conventions — would otherwise have to stop and ask *"why?"*. If the answer needs more than one line,
write it in `docs/` and point to it, don't inline an essay.
