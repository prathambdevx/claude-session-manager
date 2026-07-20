# Data migrations

`data/` is gitignored — every teammate's board/view state is local, built up over however long
they've had the app running, so a `git pull` never touches it directly. When a refactor removes a
field from `BoardColumn` (or any other persisted shape), an old field can keep sitting in someone's
`group-board.json`/`saved-views.json` indefinitely, since nothing ever writes that key away again on
its own.

The house style for this (see CLAUDE.md) is: stop reading a removed field, don't force a migration
— an unread extra key on a JS object is inert, never crashes, never misbehaves. That's still true
here. `sanitizeLegacyBoardData()` (`backend/src/store.ts`) is a courtesy on top of that guarantee,
not a correctness requirement: it strips known-dead column fields (`isAll`, `neverPopulated`) off
the two *live* board files so they don't accumulate cruft forever, in case a field ever gets reused
for something else later. It runs once at every server boot (`backend/server.ts`) — teammates
already restart automatically after every auto-pulled update (`src/polling/autoUpdater.ts`), so
this doesn't need its own git hook or separate migration step.

Genuinely dead files (`board.json`, `project-boards.json`, `board-settings.json`, and any
`*.backup.json`) are left alone — they haven't been read by any route since the Views-only and
auto-hide-empty removals, so there's nothing in them worth cleaning.

To add a new legacy field to the sweep, add its name to `LEGACY_COLUMN_FIELDS` in `store.ts`.
