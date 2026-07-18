#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# Leading * so the patterns match the absolute file_path the hook receives.
case "$FILE_PATH" in
  *backend/src/*.ts|*backend/*.ts) ;;
  *) exit 0 ;;
esac

MSG="Comment-style check for $FILE_PATH: verify comments follow .claude/rules/comments-backend.md — type field inline // for units/encoding/invariants, inline // only for non-obvious OS/CLI quirks or defensive logic, one-line // summary above exported handlers, one-line /** */ docstring only for non-obvious exported function behavior. If an explanation needs more than one line, it belongs in docs/ with a one-line pointer, not inline. Never restate what the code already says."

jq -n --arg msg "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
exit 0
