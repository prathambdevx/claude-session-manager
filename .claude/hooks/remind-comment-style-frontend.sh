#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

case "$FILE_PATH" in
  *frontend/src/*.js) ;;
  *) exit 0 ;;
esac

MSG="Comment-style check for $FILE_PATH: verify comments follow .claude/rules/comments-frontend.md — a one-line // label above a distinct template-literal HTML block (this app has no JSX), inline // comments only for non-obvious intent (the *why*, e.g. DOM/event wiring or polling decisions), short /** ... */ docstring only for non-obvious function behavior. Never add comments that restate what the code obviously does."

jq -n --arg msg "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
exit 0
