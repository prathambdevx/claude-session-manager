---
paths: ["frontend/src/**/*.js"]
---

# Comment style for frontend JavaScript

> Scope: `frontend/src/` — vanilla ES modules, no framework, no JSX. HTML is built as template-
> literal strings and wired up with plain `addEventListener`/`onclick` after insertion.
> Backend comment style lives in `.claude/rules/comments-backend.md` (scoped to `backend/src/**/*.ts`).

Keep comments short, human-readable, and focused on *why* — not *what*. Add them only where they
help a reader; default to no comment.

Three categories apply: **template-literal section labels**, **inline `//` intent comments**, and
**one-line `/** ... */` docstrings**. Everything else is noise.

---

## 1. Template-literal section labels — label logical blocks of markup

This app has no JSX, so HTML lives in template-literal strings. Use a one-line `//` label above a
block that renders a distinct region, the same way a JSX section marker would — a reader scanning
the file should be able to find each region instantly.

```js
// Job chip — spinner + step text + progress bar while a background job is running
function jobChipHtml(job) {
  return `<div class="job-chip job-running">...</div>`;
}

// Done chip — only shown once, hidden again as soon as the session goes active again
function doneChipHtml(s) {
  if (s.activelyWorking || !s.lastActivity?.startsWith("💭")) return "";
  ...
}
```

Label the *role* the block plays, not the tag:

```js
// ❌ Bad — restates the element
// div
`<div class="card">...</div>`

// ✅ Good — labels the role
// Card footer — action icons + the live/idle dot
`<div class="card-footer">...</div>`
```

---

## 2. Inline `//` comments — explain non-obvious intent

Explain *why* a step exists or what edge case it handles. If the next line reads naturally on its
own, skip it.

**DOM/event wiring quirks:**

```js
// close card menus on outside click
document.addEventListener("click", () => {
  document.querySelectorAll(".bc-dropdown.open").forEach((d) => d.classList.remove("open"));
});

// never call apRenderNodes() again mid-tick — it would tear down and recreate every card,
// killing the pop-in animation, the drag listeners, and the edges
setInterval(() => { /* patch specific DOM nodes by id instead */ }, 900);
```

**Polling / live-update decisions:**

```js
// background:true so an automatic refresh never rebuilds the board under an open menu/rename
setInterval(() => loadSessions({ background: true }), 15000);

// re-fetch the moment the tab regains focus — a card's session id can go stale otherwise
window.addEventListener("focus", () => loadSessions({ background: true }));
```

**State that isn't obvious from the variable name alone:**

```js
// only assign x/y the first time a node exists — re-rendering must never reset a dragged card
if (n.x == null) { n.x = colX; n.y = rowY; }
```

A good inline comment explains intent, not mechanics:

```js
// ❌ Bad — narrates the next line
// set the class to active
el.classList.add("active");

// ✅ Good — explains why it matters
// mark it active so the next render doesn't replay the pop-in animation
el.classList.add("active");
```

---

## 3. One-line `/** ... */` docstrings — non-obvious function behavior

When an exported/shared function has a subtle responsibility a reader cannot infer from its name
and params, add a single-line JSDoc. Skip it if the name already tells the whole story.

```js
/** Skips the destructive full-board render() while a ⋮ menu or inline rename is open. */
export function isTransientUiOpen() { ... }

/** Resolves each sub-agent to a wave and its dependency automatically, from the drafted plan. */
function apResolveWaves() { ... }
```

Keep it to one line. If you need more, the function is probably doing too much — split it instead.

---

## Do not add

- Comments that **restate the code** — `// set state`, `// return the html`, `// loop over sessions`.
- **Change-log style notes** — `// added X`, `// fix for the menu bug`, `// removed Y`.
- **References to callers / tasks / PRs** — `// used by the board`, `// for the auto-plan feature`.
- **Multi-paragraph docstrings** or **multi-line `//` blocks**. One short line max.
- **Decorative dividers** — `// ====`, `// --------`, ASCII boxes.
- **Author tags** — git blame is authoritative.
- **Commented-out code** — delete it.

---

## Final rule

When in doubt, **skip the comment**. A clear identifier and a small function beat any comment. Good
code reads top-to-bottom and only needs a comment where a reader would otherwise have to stop and
ask *"why?"*.
