# Bug log

Running, chronological log of logical/backend bugs fixed in this app — process behavior, API
correctness, OS-integration quirks (Ghostty/AppleScript, filesystem, git). Not for UI/CSS/layout
tweaks; those live in commit history and don't need a standing log entry.

Newest entries at the top. Each entry: date, one-line summary, root cause, fix, and a doc pointer if
a fuller write-up exists elsewhere.

---

### 2026-07-21 — Forked sessions closed immediately ("Process exited")

**Symptom:** clicking "Fork" opened a new Ghostty window that closed within a second, showing
`Process exited. Press any key to close the terminal.`

**Root cause (two-stage):** `/resume` with `fork: true` skipped the title-tag machinery entirely
(`opts = {}` vs a real resume's `{ ghosttyTitleFile, ghosttyTag }`), so `retileGhosttyWindows` never
ran for it — no `activate` + settle-time poll after window creation, which a fresh window/pty can
need. A first fix pass gave fork the same treatment, but reused the *original* session's tag —
Ghostty can leave a dead window on screen with its old tag still in the title after a process exits,
so the retile poll's "has the new window appeared?" check matched that stale window instantly and
never actually waited for the real new one.

**Fix:** fork now gets its own tag, generated fresh (`crypto.randomUUID()`) instead of reusing the
original session's id — `backend/src/routes/sessions.ts`.

**Full details:** `docs/ghostty-instance-bug-explainer.md` ("Follow-up: forked sessions closing
immediately").
