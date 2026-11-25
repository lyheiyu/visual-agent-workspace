# Agent guidance

- Follow-up messages in a conversation continue the same session: reuse what you already read and decided in it. Do not re-list the project or re-read this file unless something changed.
- Inspect only the files the task needs, and read the current version before changing a file.
- If a message says files changed (a "Context update from the editor" note), re-read those files before relying on earlier content.
- Keep the user's manual edits. Never revert them to an earlier version.
- Source changes go through patches so they can be reviewed and approved. Do not write files with shell commands.
- If a command or edit may have run but its outcome is unknown, check the current state; do not repeat it automatically.
- Tests: `npm run compile && npm test` (unit). The integration suites (`npm run test:integration`, `test:codex`, …) start VS Code and, for real agents, use quota: run them only when asked.
