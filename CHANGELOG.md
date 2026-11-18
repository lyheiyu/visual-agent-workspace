# Changelog

## Unreleased

- Reliability: review baselines persist across reloads; agent writes and write-target commands that would undo manual edits are blocked before they run; Codex receives decline reasons/feedback via turn/steer (delivery recorded); "Generating; review available when complete" state; write labels marked as heuristic; Codex created/deleted files show real diffs and line counts.
- Explain This File (Explorer, editor title, editor menu): purpose, execution flow, dependencies (with importing project files), modification impact; function explanations describe their role in the project.
- Command rows show purpose, status, duration and a WRITES FILES label; full command/output collapsed with copy; on-demand Explain command (not executed).
- Review before writing: conflict-checked Accept, Edit before applying (Apply my version), Regenerate with feedback; live preview for runtimes that stream edits.
- Check my changes / Continue from my changes, with an automatic check that your edits survived the agent's turn.
- Clickable file references in conversations: `file:line[:col]`, `#L` anchors, Markdown links (absolute Windows paths with spaces), relative/multi-root resolution, ambiguity picker, open to the side; safe Markdown rendering (tables, code, lists) in agent replies.
- Explain Code in Detail with the local Ollama reviewer: selected code, function/class or entire file; structured or line-by-line with clickable line ranges; syntax-aware chunking with explicit partial-analysis notes; stale-source warnings; copy/export/re-run.

## 0.5.0

- Conversation list and inline follow-ups, with saved project/model selection.
- Native OpenCode/Ollama session restoration across process restarts.
- Accurate busy, approval and waiting-for-input states, and factual per-turn results.
- Explain the current function using the same coding model/session.
- Open the selected project in VS Code Explorer and retain conversations across workspace conversion.
- Official Claude Code subscription authentication, checked before prompting without API billing fallback.
- Portable VSIX packaging and GitHub build/draft-release workflows.
