#!/bin/bash
# Fires when a process-flow file is edited and nudges Claude to reconcile docs/process-lifecycle.md.
# A hook can't judge staleness itself — it pins the doc against the change so the flow can't drift
# silently. Keep this file list in sync with the "Who kills a claude process" section of the doc.
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# The doc itself — editing it is the reconciliation, so don't nag about that.
case "$FILE_PATH" in
  *docs/process-lifecycle.md) exit 0 ;;
esac

# The files that define what starts/tracks/kills a session. An edit to any of these can invalidate
# the doc. Match on the tail so it works against the absolute file_path the hook receives.
case "$FILE_PATH" in
  *backend/src/polling/orphanWatcher.ts) ;;
  *backend/src/polling/autoUpdater.ts) ;;
  *backend/src/claude/terminal/terminalLaunch.ts) ;;
  *backend/src/claude/terminal/terminalFocus.ts) ;;
  *backend/src/claude/headless.ts) ;;
  *backend/src/claude/detachedRunner.ts) ;;
  *backend/src/store.ts) ;;
  *backend/src/routes/quickPrompts.ts) ;;
  *backend/src/routes/delegations.ts) ;;
  *) exit 0 ;;
esac

MSG="Process-lifecycle check: you just edited $FILE_PATH, which is one of the files docs/process-lifecycle.md documents (a start/track/kill path for a session). Re-read docs/process-lifecycle.md now and verify it still matches this change — especially the 'Who kills a claude process' table, the orphan-watcher section (miss-threshold, invariants), the csm-<id> tag behavior, and the liveness signals. If the flow changed (a new kill path, a changed trigger, a different debounce/threshold, a new liveness signal), update the doc in the same turn so it never drifts behind the code. If nothing in the doc is affected, do nothing."

jq -n --arg msg "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
exit 0
