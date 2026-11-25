# Visual Agent Workspace (v0.5)

Conversation attachments: use **Attach**, drag local files into the conversation, or paste an image into the input. Preview/remove attachments before sending. Text/code files are sent as UTF-8 reference content; PNG/JPEG/WebP/GIF images use native image inputs for Codex, Claude and OpenCode. Local models must advertise Ollama's `vision` capability. Limits: 8 files, 5MB per image, 100KB per text file, 10MB combined. PDF/Office/binary files are not parsed. No files are copied into the project. Failed sends retain attachments for retry. Unsent attachment bytes exist only in the open panel; history records attachment names, not their bytes, so attach them again when needed after restoring a conversation in a new provider session. Native provider history may retain previous attachments. No background explanation or model switching is triggered.

Install the VSIX from this project's GitHub release or build artifact using **Extensions → … → Install from VSIX…**. Then open your real project and click **Visual Agent → Conversations**; F5 is only needed for developing the extension. See [中文安装与迁移说明](INSTALL.zh-CN.md).

A VS Code extension that makes AI coding agents **observable, interruptible and auditable**. You can see each operation an agent performs, follow it in the editor, inspect proposed changes as diffs, and approve or reject them before they proceed.

Coding agents, chosen in **New Agent Task** (see [Multi-agent coding](#multi-agent-coding-v04)):

| Agent | Runtime | Status |
|---|---|---|
| **Codex** | Codex App Server (isolated session) | Available. Live-tested. |
| **Local agent** | [OpenCode](https://opencode.ai) runtime with your **local Ollama** model | Available. Live-tested with `qwen3:8b`, `gpt-oss:20b` and `qwen3.8:27b`. |
| **Claude Code** | Official Claude Code runtime + Agent SDK | Experimental integration. Official subscription login, API-key, Bedrock, Vertex or Foundry auth. Pro subscription read-only and follow-up tested live. |
| Mock demo | Scripted, simulated | Unchanged since v0.1 |

v0.3 adds function-level live tracking, an optional **Local AI Reviewer** (Ollama), and **review-context export**. It has two independent layers:

| Layer | What it does | LLM usage |
|---|---|---|
| **A. Real-time observer** | Records the agent's real tool events: files, functions (parsed), diffs, commands, output. Updates the timeline and navigates. | **None.** No observer inference calls or automatic analysis. Coding workflow instructions accompany user-requested agent turns. |
| **B. Local AI Reviewer** (optional) | Explain a function, review a change, impact analysis, explain a failure. | **Only when you click**, only on your local Ollama (`127.0.0.1` by default). No cloud tokens, no Codex quota. Can be disabled completely. |

> Design principle: **Propose → Inspect → Approve/Reject → Execute → Record → Review**

Local coding defaults to a short overall plan, sequential file edits, then validation. Multi-file plans identify file responsibilities, shared interfaces and implementation order; small fixes need only a sentence. Implementation requests proceed after the plan, subject to existing tool approvals. Follow-ups reuse the plan and check actual files. This uses the same Ollama model without a separate planning call. Set `visualAgent.local.workflow` to `direct` to omit the staged workflow. These are model instructions, not a guarantee of model compliance; runtime permissions still enforce access. Codex and Claude prompts are unchanged.

---

## Quick start

Requirements: VS Code ≥ 1.85 and Node.js ≥ 18.

```bash
npm install
npm run compile
```

**Launch with F5:**

1. Open this folder in VS Code.
2. Press **F5** (or pick *Run and Debug → "Run Visual Agent Workspace (demo workspace)"*). This compiles the extension and opens an **Extension Development Host** window with `demo-workspace/` as its folder.
3. In that window, click the **eye icon (Visual Agent)** in the Activity Bar.
4. Click **▶ Start demo** in *Agent Activity*.

## Using it

| Feature | Where |
|---|---|
| Timeline of operations (step #, time, type, status, file › function) | *Agent Activity* sidebar |
| Operation details, command, result, audit trail | Click an operation (lower part of the sidebar) |
| Jump to code and highlight the function | Click an operation, or **Go to code** |
| Follow Agent toggle | Checkbox in the sidebar, or the eye icon in the view title |
| Pause / Resume / Stop | Sidebar buttons, view-title icons, Command Palette (`Visual Agent: …`) |
| Approve / Reject | Pending proposal in Conversation or Agent Activity, or the Command Palette; the notification follows the pending state and has no duplicate decision buttons |
| Review a proposed change (diff) | **Review diff** opens VS Code's diff editor: original ↔ proposed (not applied) |
| Command details (cwd, timestamps, exit code, stdout/stderr) | *Agent Commands* view; click an entry for the full output |
| Task summary | `…` menu → *Show Task Summary*, or the notification at the end of a task |
| Past tasks | Task selector in the sidebar (history persists per workspace) |

### Demo task: "Inspect and improve a data import validation function"

1. **Read** `importer.py`
2. **Analyze** `load_data()`
3. **Read** `validation.py`
4. **Analyze** `validate_samples()`
5. **Edit** (proposed): stricter `validate_samples()`. The diff opens beside the code and the agent **waits for your decision**.
6. **Test** (simulated): `python -m pytest tests/test_validation.py -v`
   - If you approved the edit, the simulated output is *5 passed* (exit 0).
   - If you rejected it, the simulated output is *3 failed, 2 passed* (exit 1). The original function lets bad rows through.
7. **Summary**: built from the recorded events, not written by a model.

Whether you approve or reject, `validation.py` on disk is never modified.

### Timeline

Agent Activity groups steps by conversation turn. Completed turns collapse automatically, while the running turn and any turn awaiting your decision stay open. Your own toggles are remembered. The active step, pending approval or latest unrecovered failure expands automatically unless you expanded another step yourself. Manually expanded details remain available when Follow selects newer steps. Repetitive finished reads and identical failed retries are grouped without deleting their audit records.

Each step has **one action** beside it: **Review changes** (pending edit), **View diff**, **View error**, **View command**, **View file** or **View result**. Files and diffs open in the editor. Clicking the step title toggles brief inline details: the full command (collapsed when long), working directory, exit code, output, the error, changed functions, and the decision. Approve/Reject live in the pending proposal card; buttons disable while a decision is being processed. The approval notification closes when its proposal is approved, rejected or cancelled from either panel. New approval cards scroll into view once, rather than on every update.

UI validation (2026-11-24): 176 unit tests and 33 VS Code integration tests pass. Real Codex and OpenCode (qwen3:8b, with an 8192-context temporary test tag) both reached a file diff before approval and changed only the intended test file after approval; notifications cleared. The incorrect first local-model proposal was rejected without writing, and a corrected proposal was then accepted. Automatic/manual expansion and cancellation also have automated regression coverage. These checks do not guarantee that a model's proposed code is correct. Evidence is kept under `.vscode-test/`.

Failed steps show a short reason taken from the recorded result or output. Secondary actions sit in **…**: go to code, command output, copy command or output, explain command, AI review, export context, and **Full record (audit trail)**, which opens the complete read-only record. The full audit trail is also folded into each step's details. Nothing here calls a model.

### Live Tracking and Live Follow

- **Live Tracking** is always on for a connected session. Every event is recorded and the timeline updates as events arrive. It's shown as "● Live tracking · now: …" in the header.
- **Live Follow** (checkbox) is optional editor navigation. Turning it off never stops recording.
- **On**: when the agent touches a file, that file opens in a preview tab with the function highlighted, and proposed edits open as a diff beside it. Keyboard focus stays where it was (`preserveFocus`), and the details pane tracks the newest operation. Bursts are coalesced: the editor moves at most once per 300 ms, always to the latest operation.
- **Off**: new events never change the editor. Navigation only happens when you click.
- The setting is stored in VS Code's workspace state, not `settings.json`, so toggling it never writes workspace files.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `visualAgent.stepDelayMs` | `1500` | Pause between mock operations, so each one is visible |
| `visualAgent.followAgentByDefault` | `true` | Initial Follow state for a new workspace |
| `visualAgent.requireApprovalForCommands` | `false` | Also gate Execute/Test operations behind approval. Edits are always gated. |
| `visualAgent.allowNavigationOutsideWorkspace` | `false` | Allow opening files outside the workspace folder |

### Function-level change tracking (v0.3)

For every real patch, Visual Agent:
- extracts the **changed line ranges** from the hunks (added or modified lines in the patched file; pure removals in the original);
- finds the **affected functions** by parsing the actual file text, both before and after the patch (Python indentation, TypeScript/JavaScript braces). Lines outside any parsed definition get **no** function name, so names are never invented;
- labels an edit with a single function only when exactly one was found.

In the details pane, **Affected functions** jumps to each one and **Changed lines** lists the ranges. Clicking an applied patch highlights its actual changed lines on disk. A patch that is still proposed jumps to where it will land, and the diff shows its content.

### Local AI Reviewer (v0.3)

Panel: **Visual Agent → Local AI Reviewer**. Commands are also in the editor context menu and the Command Palette (`Visual Agent: … (Local AI)`).

| Action | Input it uses (minimal context) |
|---|---|
| **Explain function** | The function at the cursor: language-server symbols first, then the text parser, then your selection. Includes import lines and line numbers. |
| **Review change** | The selected Edit operation, or the latest recorded change to the function at the cursor: the **recorded diff**, plus the original and modified function |
| **Explain diff** | The selected Edit operation's **diff hunks only** (removed, added and 3 unchanged lines with before/after line numbers, plus the enclosing function's signature when the hunk does not show it), never the complete before/after files. See *Explain diff and the context window* below. |
| **Impact analysis** | The function, plus call sites from language-server references (or a labeled heuristic text search), plus workspace functions it calls |
| **Explain error** | The selected failed command or test: command, exit code, the last 80 output lines, and code at `file:line` references found in the output (workspace only) |

- **Models:** discovered with `GET /api/tags` when the panel is first shown or on refresh. Pick any installed model from the dropdown. `qwen3:8b` is preselected if installed; otherwise `visualAgent.reviewer.model`, otherwise the first model. Nothing is hardcoded or downloaded.
- **Streaming and cancellation:** `POST /api/chat` with `stream: true`. Results stream into the panel and into a read-only document beside the code. **■ Cancel** aborts the HTTP request.
- **Read-only:** the reviewer returns text. It can't edit files, run commands, apply patches, or talk to the coding agent. Results are labeled *"Model-generated, not verified by execution."*
- **Privacy and quota:** only the configured endpoint is used, and non-loopback hosts are refused unless `visualAgent.reviewer.allowRemoteEndpoint` is on. Context is redacted for secrets and capped at `maxContextChars`; lower-priority sections are dropped first.
- **Caching:** results are cached in memory, keyed by a SHA-256 of model, thinking mode and the exact prompt (which includes the code), so unchanged code isn't re-analysed.

**Explain diff and the context window.**
- **Budget per request.** The window is `visualAgent.reviewer.contextWindow` (the `num_ctx` sent), capped by the model's trained context length from `POST /api/show` (metadata only, no inference). If Ollama doesn't report a length, the setting is used as is. From that window the reviewer reserves room for the instructions, the answer (25%, or 35% with thinking on) and a 10% safety margin. `maxContextChars` still caps one request. Token counts are estimated conservatively before sending: about 3 characters per token for ASCII, 1 token per other character.
- **One request** when the whole diff fits. It includes one *Overall* item, which covers how the files relate when several files changed.
- **Otherwise, batches.** Hunks are grouped by file (a file is split only if it doesn't fit, and a single oversized hunk into parts). The batches are sent **one after another, never in parallel**, and the panel shows *Analysing batch 2 of 4*. A final request then combines the verified per-file findings into one explanation of the whole change and the cross-file relationships.
- **Answer length.** Each answer is capped at the reserved size (`num_predict`). A batch that hits the context limit or is cut off is split once and retried.
- **Nothing is dropped silently.** The result lists every file and hunk under *Coverage*. Hunks that couldn't be analysed are named with their line ranges and the reason, and the result is marked **incomplete** (not cached).
- **Findings are checked.** Each finding must quote the line it cites from the code that was sent; other claims are left out. The combined explanation is labeled as model synthesis, and open questions are listed under *Needs more context*. Use **Explain function** on those lines to inspect them; no further request is made automatically.
- **Storage.** Intermediate batch results stay in memory for that one review and are never stored.
- **Copy / Export .md** of each result is available. If Ollama is offline, the panel shows *Ollama unavailable* with the reason, and everything else keeps working.

| Setting | Default | Meaning |
|---|---|---|
| `visualAgent.reviewer.enabled` | `true` | `false` = no requests to Ollama at all; AI buttons hidden |
| `visualAgent.reviewer.endpoint` | `http://127.0.0.1:11434` | Ollama endpoint (loopback only by default) |
| `visualAgent.reviewer.model` | *(auto)* | Preferred installed model |
| `visualAgent.reviewer.thinking` | `off` | Reasoning mode. gpt-oss can't disable it; `off` maps to `low`. |
| `visualAgent.reviewer.contextWindow` | `8192` | `num_ctx`. Larger uses more GPU/RAM. |
| `visualAgent.reviewer.maxContextChars` | `12000` | Context budget per request |

### Language / 语言

The language selector (top right of *Agent Activity* and *Local AI Reviewer*, or **Visual Agent: Select Language**) offers **中文** (default), **English** and **中英双语**. The choice is stored in the user setting `visualAgent.language`, so it survives restarts. It never affects the coding agent.

- **UI labels** come from a static string table ([src/i18n/i18n.ts](src/i18n/i18n.ts)); no LLM is involved. Manifest strings use `package.nls.json` and `package.nls.zh-cn.json`, which follow VS Code's display language. Commands, code, paths, tool output, stack traces and agent text are never translated.
- **New reviews** ask the local model to answer **directly** in the selected language. 中英双语 produces both languages from **one** request. Identifiers, code, paths, commands, exception and API names stay unchanged. The language is part of the cache key.
- **Translate / 翻译** on an existing result uses the currently selected local model, never a cloud API. The original is kept, and output streams and can be cancelled. Translations are cached by (hash of the original text, source language, target language, model), so switching between *Original*, *中文*, *English* and *中英双语* makes no new request. A warning appears if any code span from the original is missing from the translation.
- Nothing is translated automatically: not tool events, not reviews. Nothing is added to Codex or Claude Code sessions.

Real check (`npm run test:ollama:i18n`, `qwen3:8b`, 9/9):
- The Chinese and English answers came back in the requested language, with identifiers kept.
- The bilingual answer came from one request.
- The English-to-Chinese translation kept all 12 of 12 code spans.
- Switching cached versions made no request, and cancelling a translation stopped it within 2 ms.

### Export review context (v0.3)

Use **Export…** in an operation's details, the *Agent Activity* `…` menu, or the editor context menu. Pick a scope: **function at the cursor**, **a change**, **several operations**, or **the entire task**. The result is a Markdown report that opens as a **read-only preview first** (secrets redacted). It's copied or saved only when you click **Copy to Clipboard** or **Save As…**. It's never sent anywhere.

Every item is labeled:
- **[verified]**: recorded from the agent's tool events or read from disk. This covers diffs exactly as reported, command, exit code and output, decisions, and code on disk.
- **[derived]**: computed from verified data, for example the modified function produced by applying the recorded diff.
- **[inferred]**: local parsing or heuristics, for example affected functions and related call sites.

Exports never include model-generated text. Simulated (mock) commands are marked **SIMULATED**.

---

## Conversations and turn results

Click **Conversations / 会话** in Agent Activity, or run **Visual Agent: 会话 / Conversations**. The editor opens a session list and chat with an inline composer. New agent tasks open there automatically. Clicking a session restores its retained transcript, project and model; the last selected conversation is remembered in the same VS Code workspace. Drafts are kept per conversation while the panel is retained/reloaded. The operation timeline stays available in the sidebar for navigation and detailed audit records.

Selecting or browsing a project now opens its **actual folder in VS Code Explorer**, rather than changing only the agent's working directory. In a window already using a workspace file, a project not already open is added alongside existing roots and revealed without restarting the extension host. Entering a saved conversation reveals its project too; **Show project in Explorer / 打开项目文件夹** in the conversation header returns to the file tree at any time. Existing roots remain open.

F5 now prepares a local, ignored `.vscode/visual-agent.local.code-workspace` file so adding projects works without a restart. For an existing single-folder/empty window, the first new project converts it to a managed workspace file under extension storage. VS Code reloads once: retained conversations are transferred, an idle provider session is closed normally, and a pending task form is restored. A busy turn must finish or be stopped before that conversion. Subsequent additions do not require another conversion. No project source files are moved or copied.

**Local Ollama sessions:** when a turn completes, the UI says **Turn complete · waiting for input**, not Running. Send another message in the composer to continue the same OpenCode session. **End session** closes the idle runtime; **Stop** interrupts work. Switching to another conversation automatically closes the previous idle runtime; switching while a turn or approval is pending is blocked. After closing or reloading, sending in that conversation uses the running OpenCode server (or starts it) and restores the persisted session ID, validating its project directory. It sends only the new message, not a reconstructed transcript. If restoration fails, the error is shown; choose **Continue with saved context instead** explicitly to start a new provider session under the same visible conversation. Models and permissions are not silently changed. The native history depends on OpenCode data under the extension's global storage remaining available.

**Codex and Claude Code: native sessions.** A conversation creates one native agent session, records its ID and sends each follow-up into that session. Earlier messages are not replayed.
- **Codex:** one thread for the whole conversation. Follow-ups are new turns on that thread. After **End session**, a reload or a restart, the next message calls `thread/resume` with the recorded ID. It first checks that the thread is the same one and that the project folder and model still match. Threads are stored as normal Codex history under `~/.codex`.
- **Claude Code:** the session is persisted under `~/.claude/projects` and resumed with the SDK's `resume` option, after checking the project folder.
- **OpenCode:** continues as described above.

A conversation never reuses another conversation's session or another provider's session.

**When a session can't be continued** (it was deleted, belongs to another project, model or provider, or you chose **Continue with saved context instead**), a new session starts. It receives a short reconstructed summary of about 8 KB: the task, the last few messages, the files changed and inspected, and any operation whose outcome was not confirmed. The summary tells the agent not to repeat those operations automatically. The chat labels this **Recovered context**, and the reason is in the session operation and the Visual Agent output log.

**Changed files are named, unchanged files are not re-sent.** For each conversation, the extension records the files the agent read or edited, together with a content fingerprint (SHA-256; no file content). When you send a message, it checks those fingerprints. If a file changed outside the agent's own edits (for example, you edited it), a one-line note is added to the message: *these files changed: re-read them*. Unchanged files are not mentioned, and the agent can still read any file whenever it needs to. Nothing limits how often a file may be read. This check uses no model calls.

**Metrics** (Visual Agent output log, one line per turn): threads started and resumed, native turns, reconstructed sessions, reads and repeated reads of unchanged files, exploration steps (listing the project, re-reading `AGENTS.md`), and input, cached and output tokens as reported by the agent. They are stored with the fingerprints in `session-context.json` in workspace storage (at most 50 conversations).

Older tasks without saved provider/model settings use **Copy history into a new task…** to configure them. Conversations from the separate Codex/Claude extension chat panels are not imported.

**Every turn has a result immediately**, before closing the session: recorded file edits and their statuses, commands/test exit codes, failures, rejections and cancellations. Reports are built from tool events with no additional model request; they do not claim that unrecorded changes or tests happened. An interrupted/reloaded turn is marked Stopped. The final task summary remains available when the session ends.

**Use one Ollama model:** ask the coding agent to explain code in the same conversation, or open a source file, place the cursor in a function, and click **Explain the current function / 解释当前函数** in chat. This sends a read-and-explain instruction to the same coding model and session, without starting the independent reviewer. The separate reviewer is blocked while a local coding turn is busy; local coding is also blocked while the reviewer is generating.

Defaults retain 20 tasks, 200 messages and 100 turn reports per task in VS Code workspace storage. Long fields are truncated and secrets redacted on a best-effort basis. The sidebar previews recent messages; chat and transcript documents show all retained messages. Clear History deletes extension records; it does not erase the OpenCode runtime's own database. Older records recover known assistant replies where available; missing or previously truncated text cannot be recovered.

Single-model real acceptance (GPU inference in a disposable JS repository): `npm run test:local-conversation`. It refuses to load a second Ollama model and checks explain → approved edit → real test → follow-up → new process/native resume with a remembered marker. Set `VAW_CONVERSATION_MODEL` to use another installed tool-capable model.

## Clickable code references and Explain Code in Detail

### File references in conversations

Agent replies in **Conversations** are rendered as Markdown (headings, lists, tables, code spans, fenced code, block quotes and links). File references in them are clickable:

| Written by the agent | Opens |
|---|---|
| `mujoco_optimizer.py:167`, `a.py:12:5`, `src/x.ts#L4C2`, `x.ts#L10-L20` | that file at the line (and column); a range is highlighted |
| `[mujoco_optimizer.py:167](C:/D/projects/Orca robot hand/orca sim/…/mujoco_optimizer.py:167)` | absolute Windows path with spaces (Markdown link destinations may contain spaces) |
| `src/orca_sim/mujoco_optimizer.py`, `./x.py`, `file:///C:/a%20b/c.py#L3`, `/c/Users/…` (Git Bash) | relative, file URL and MSYS paths |
| ```python scripts/run.py --cfg conf/a.yaml:3``` | the paths inside a code span, not the command |

**Resolution:** absolute paths open directly. Relative paths are tried first in the conversation's project, then in the other workspace roots (a match in the conversation's project wins). A bare filename or a path written relative to another folder is found by a bounded path-suffix search that skips `node_modules`, `.git`, virtual envs and build folders. Several matches open a picker; nothing is guessed. A missing file shows *File not found* inline and nothing is created. A file outside the open folders asks for confirmation first (or follows `visualAgent.allowNavigationOutsideWorkspace`). A line past the end of the file opens the last line with a notice.

**Clicking** opens the file in another editor group, so the conversation stays visible. The target line is revealed, the cursor is placed, and the line is highlighted. **Right-click** a reference for **Open Reference to the Side**, **Copy Reference** and **Explain Code in Detail**. Middle-click also opens to the side.

**Not references:** numbers, times, versions (`v0.4`, `3.14`, `12:30`), `Node.js`, `np.linalg.norm`, a bare `config.json` in prose (it is clickable in a code span or with a line number), URLs, and anything inside fenced code blocks.

**Safety:** the extension host parses Markdown into a whitelisted tree. The webview builds DOM nodes with `textContent` only, so raw HTML in agent output is shown as text. Links never navigate the webview. `javascript:`, `command:`, `vscode:` and `data:` links render as plain text. External `http(s)`/`mailto` links open only after a confirmation dialog. Clicking a reference sends only `{path, line, column}`. The host validates it again and its only effect is opening a text editor; it never runs a command. Stored messages are not modified.

### Explain Code in Detail (local Ollama)

Entry points (all run only when you click):

- the editor context menu: **Explain Code in Detail (Local AI)**;
- a file reference in a conversation (right-click);
- **Explain** next to each changed function in Agent Activity (function-level navigation);
- **Explain in detail…** in the Local AI Reviewer panel;
- the command palette.

Choose the **scope**:
- **Selected code**: the selected lines.
- **Function / class**: the innermost function, method or class containing the line. It uses the language server, falling back to the built-in Python/TS/JS parser.
- **Entire file.**

Choose the **mode** in the panel:
- **Structured**: 7 fixed sections. Purpose; inputs/outputs; execution flow; important functions, classes and dependencies; algorithms and math; errors, edge cases and assumptions; relationships with other components.
- **Line by line**: sections headed `Lines A–B: title`, in source order, using the real line numbers.

Every claim is labelled **[Fact]** (visible in the code), **[Inference]** or **[Issue]**.

The panel opens beside the source editor. It shows:
- the file, scope, analyzed lines, model, document version and SHA-256 of the analyzed text;
- a model picker and a mode selector. Switching mode shows an earlier result for the same code, or waits for **Explain**; it never runs the model by itself;
- **Re-run**, which bypasses the cache, plus **Cancel**, **Copy** and **Export .md**;
- expandable sections with clickable line ranges. "Lines X–Y" mentions inside the text are clickable too.

Line ranges outside the analyzed code are shown as *outside the analyzed lines (not linked)*. Lines the model skipped in line-by-line mode are listed as *Not covered by the model*.

**Large code:** code is split at function/class boundaries from the existing parser into parts that fit the local context. The budget is about half of `visualAgent.reviewer.contextWindow`, capped by `maxContextChars`. Each part carries its enclosing class/function signatures, the file's imports and the module definitions it uses. Structured mode adds one combining request when there are several parts. At most `visualAgent.reviewer.explainMaxParts` parts (default 8) are analyzed. If more would be needed, the panel, the prompt and the export all say **partial analysis** and list the lines that were **not** analyzed.

**Grounding and accuracy:**
- Only the target code, its enclosing signatures, imports and used module-level definitions, and (for a function) up to 8 call-site snippets found by local text search are sent. Unrelated files are not.
- Secrets are redacted.
- Unsaved editor contents are analyzed as shown and labelled as such.
- Editing or reloading the file after the analysis shows a **stale** warning, based on the hash of the analyzed text. Line navigation still works but warns.
- The explanation never writes the source file. Export refuses to overwrite it.
- Requests use the Local AI Reviewer's service: the same loopback-only endpoint check, model list, inference guard against loading a second model while the local coding agent is busy, cancellation and read-only guarantees.
- There is no cloud fallback. Agent observation never triggers it.


**Start a task:** click **▶ New agent task…** in Agent Activity (or run *Visual Agent: New Agent Task…*). The panel asks for:

| Field | Behavior |
|---|---|
| Coding agent | Codex, Claude Code or Local agent. Unavailable providers stay visible with the reason (for example "Ollama not reachable" or "sign in through official Claude Code"). |
| Coding model | **Discovered from the provider** when you select it. Codex uses `model/list`, the local agent uses Ollama `/api/tags` plus `/api/show`, and Claude Code uses the SDK's `supportedModels()`. Nothing is hardcoded. Local models without tool-calling are listed as *incompatible* and can't be chosen. |
| Reasoning effort | Shown only when the model reports supported levels (Codex `supportedReasoningEfforts`, Claude `supportedEffortLevels`) |
| Workspace | Follows changes to the open workspace folders; in multi-root windows, defaults to the active file's project. **Browse project…** can select another local project. Existing tasks stay pinned to their original project; the task header shows that path and recorded operations navigate within that task's root. |
| Execution profile | Read-only, or approve each edit and command (Codex keeps its three v0.2 profiles) |
| Instructions | The task |

- **No silent substitution.** The launcher refuses a model the provider didn't report. Codex must echo the selected model in `thread/start`, or the task aborts before any turn. For the local agent, every assistant message must report `ollama/<selected model>`, or the task aborts.
- **The timeline's first entry shows the provider and model actually running**, for example `Codex session started: gpt-5.6-sol (effort low)` or `Local agent session started: OpenCode + Ollama qwen3:8b`.
- **Remembered per provider:** the last selection whose task *completed successfully* (stored in VS Code global state).
- **Multi-turn (local agent, Claude Code):** the session stays open after each turn and the header shows *Waiting for your next instruction*. **✎ Send follow-up** continues the **same** session, and **■ End session** finishes it. **Stop** interrupts at any time.

### Local agent (OpenCode + Ollama)

Visual Agent doesn't implement its own agent loop. It runs the existing **OpenCode** runtime (`opencode serve`, HTTP + SSE API) and observes it.

OpenCode makes successive model requests as it reads, searches, edits, and tests. Tool results go back into the native session. Follow-ups reuse that session and can receive a short notice about files changed outside the agent. Reads and searches should target the relevant code, and edits still require checking the current text. OpenCode handles automatic conversation compaction. A local turn also stops if the runtime reports more than 48 distinct model steps, so it can be inspected and resumed. The separate OpenCode repeated-tool guard stays enabled.

Local task checks retain the original request and the pending OpenCode checklist in subsequent requests. Restoring a native session reloads its checklist. Native todo events and actual tool outcomes drive an end-of-turn warning when pending items or recorded tool errors remain. These checks do not prove semantic correctness or detect every omitted user requirement when the model fails to create an accurate checklist. Identical tool arguments failing three times stop the turn while retaining the native session ID. A successful edit resolves older failed edits to the same file. A passing rerun resolves a failure of the same command even if its description changes. Other failures retain their evidence for review.

Local coding validation uses the existing TypeScript parser to identify new JS/TS parse errors, duplicate top-level bindings, removed named exports and CommonJS interface changes. New syntax errors are declined before approval. Explicitly requested preservation of public exports is checked before edits. Other interface/dependency risks appear through existing approval warnings. Post-edit checks inspect actual files, small relevant local dependencies and available VS Code error diagnostics. New syntax issues or recorded failing tests can trigger one correction request in the existing session. User rejection and explicitly read-only follow-ups suppress that retry. This uses the existing approval flow, and static findings do not establish general semantic correctness.

Run `node scripts/benchmark-coding.js` after compilation for two attempts per task on qwen3:8b and authenticated Codex. The benchmark uses temporary CommonJS projects for single-file fixes, multi-file fix/document tasks with initially failing tests, and module extraction with public-interface preservation. It continues each available session with an explanation follow-up, checks actual tests and changed paths, and saves JSON metrics under `.vscode-test/`. `VAW_BENCH_PROVIDERS`, `VAW_BENCH_CASES`, `VAW_BENCH_REPEATS` and `VAW_BENCH_REPORT` restrict repeat runs. Its automatic approval policy permits only the fixture's requested source paths and read/test commands, and is confined to this test script. Reported token totals include input and output under each provider's tokenizer/cache accounting.

Real coding benchmark observations (2026-11-25; three tasks, two attempts each):

| Model / run | Code contract passed | Full workflow passed | Mean seconds | Tool calls, total | Tokens, total including cache |
| --- | --- | --- | --- | --- | --- |
| qwen3:8b, initial candidate | 3/6 | 3/6 | 48.5 | 49 | 322,641 |
| Codex, initial comparison | 6/6 | 6/6 | 20.8 | 30 | 597,210 |
| gpt-oss:20b, latest candidate | 5/6 | 4/6 | 17.4 | 40 | 347,055 |

Full workflow requires the task-specific checks, an actual passing agent-run test, reproduction and correction of the initially failing multi-file test, and a successful same-session follow-up. Independent tests passing alone are insufficient. The latest 20b run missed connecting an extracted function in one attempt and skipped executing tests in another despite claiming success. No unexpected file edits occurred under the fixture approval policy. The qwen experiments still failed module extraction; these checks reduce unsafe changes but do not make small models reliable.

These are exploratory observations, not a controlled model ranking: checks/instructions were refined between runs, the latest extraction oracle additionally checks function identity, and sample sizes are small. Early qwen runs used a 4K output budget; the 20b run used a temporary model alias with 16K context and 4K output, then removed the alias. OpenCode totals were reconciled from fixture-session input/output/reasoning/cache counters; 262,714 qwen and 299,721 latest-20b tokens were cached input. The initial Codex report did not capture its cache split. Tokenizers and context configurations differ. Detailed observations and accounting are in `.vscode-test/coding-benchmark-normalized.json`; rerun the benchmark for comparisons with identical current checks. Coverage is limited to small JS/CommonJS fixtures, not arbitrary languages or production projects. Caller/dependency discovery still depends on the model's targeted inspection; available language-server diagnostics are supplementary and may be delayed.

Real validation with qwen3:8b and OpenCode 1.19.6 observed automatic `session.compacted` events with an 8192-token request window after reading a long reference file. A follow-up retained the original requirement marker and pending documentation task. Multi-file recovery has both successful and unsuccessful runs: one run fixed the failure and edited both files, while a later run broke module exports, failed tests, attempted an out-of-scope test edit (rejected), and was reported as unresolved. The model's final wording never establishes correctness. Test logs are under `.vscode-test/local-compaction-real.log` and `.vscode-test/local-completion-real-final.log`.

The local context budget is capped by the model's declared window, its explicit `num_ctx` if present, and the live runner context when Ollama reports it. The output budget reserves at least three quarters of the window for input. Oversized new text and attachments are refused before inference, with the live session available for a smaller follow-up. This is an estimate and does not include native session history, image token costs or the runtime's tool schemas. The setting budgets OpenCode requests and does not reconfigure Ollama's runner.

- **Local inference only.** OpenCode's built-in cloud provider (`opencode`) is disabled, only `ollama` is enabled, and both `model` and `small_model` (used for titles and summaries) point at your local model. Each assistant message is checked for `providerID=ollama` and the selected `modelID`.
- **Isolation.** The server runs on `127.0.0.1` with a private home (`XDG_*` directories under the extension's global storage) and an inline config (`OPENCODE_CONFIG_CONTENT`), started with `--pure` (no external plugins). Your own `~/.config/opencode` is never read or changed. The binary is spawned without a shell. Each server gets a random password (`OPENCODE_SERVER_PASSWORD`), so other local programs cannot use it or answer its permission requests.
- **Server lifecycle (no terminal needed).** You never start OpenCode yourself, including under F5:
  - **Started when needed.** A local-agent task starts the server and waits until `/global/health` answers (with the password) and `/config` confirms the local-only model, providers and permission profile. Only then is anything sent. Set `visualAgent.local.server.autoStart` to `onActivation` to also start it when the extension starts, with the last local model and profile.
  - **Reused.** Later turns and conversations with the same model, profile and limits use the running server (no duplicate). Different settings replace it, but never while a session is using it.
  - **Status bar:** `OpenCode: Starting / Running / Stopped / Error`. The tooltip shows the PID, port, version, model, profile and active connections. Clicking it offers **Start**, **Restart**, **Stop** and **Show log** (also available as commands). The log ("Visual Agent Workspace" output) shows the server's startup, its own output, health failures, exits and restarts. Errors are shown with **Restart** / **Show log**.
  - **Recovery.** An unexpected exit, or 3 failed health checks in a row, sets **Error**. The running turn fails with a message saying so, and the server restarts automatically (at most 3 times within 5 minutes; after that use **Restart**). Send your message again: the same OpenCode session continues on the new server.
  - **Ownership.** Only a server this window started is ever stopped: on **Stop**, on settings changes, after `visualAgent.local.server.idleStopMinutes` (default 15) without a session, and when the extension shuts down. Its PID, port and password are recorded in workspace storage. After an extension restart, a recorded server that still runs and answers with that password is re-adopted instead of starting a second one. A recorded PID that does not answer with the password (for example a reused PID) is never stopped. On Windows a crashed extension host takes its server with it, so nothing is left running.
  - Servers you start yourself in a terminal are not used: they would run with your own OpenCode configuration and providers.
- **Permissions are enforced by OpenCode itself.**

  | Profile | edit | bash | read of `.env`, keys, `.git` | web, sub-agents, outside-workspace |
  |---|---|---|---|---|
  | Read-only | deny | deny | deny | deny |
  | Approve each edit and command | **ask** | **ask** | deny | deny |

  An `ask` blocks the tool until Visual Agent replies (`permission.asked` → `POST /permission/:id/reply`). That's real interception: in the live test, `math.js` stayed byte-for-byte unchanged while approval was pending. Before asking you, Visual Agent itself declines edits outside the workspace or to protected files, and any permission the profile doesn't grant. Commands like `rm`, `git reset --hard` or `git push` are flagged ⚠ *potentially destructive* in the approval.
- **Diffs before approval.** OpenCode sends the unified diff with the edit permission request. Visual Agent also computes it from the tool input against the file on disk, then finds affected functions and changed lines with the v0.3 parser.
- **Resources.** Before starting, Visual Agent checks Ollama `/api/ps`. If a *different* model is loaded, it asks first (**Unload Others and Start**, **Start Anyway**, or cancel), so two large models are never loaded automatically. The same check runs before a Local AI Review would load a second model while the local agent is running. `visualAgent.local.contextLimit` (default 32768, capped by the model's own limit) and `visualAgent.local.outputLimit` bound the context and output size.
- **Requirements.** Ollama running, plus OpenCode (`npm install -g opencode-ai`, or set `visualAgent.local.opencodePath`). During development it's taken from this project's `node_modules`. On first use, OpenCode downloads its `@ai-sdk/openai-compatible` provider package from npm into its private cache. That's a package download, not inference.

### Claude Code (experimental)

The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, the Claude Code harness as a library) runs the session in your workspace.

- **Authentication.** The extension locates the official Claude Code binary and asks it for safe login metadata (`claude auth status --json`); it never reads, copies or stores credentials. An existing Claude subscription login can be used. Set `visualAgent.claude.authMode` to `subscription` to use only that login, with API/cloud/proxy overrides removed from the child process environment. `auto` retains configured API/cloud auth, otherwise uses subscription login. `api` never falls back to subscription. Before sending a task prompt, SDK `accountInfo()` must confirm the chosen auth kind. A subscription session will not silently switch to API-key billing, including when continuing a saved conversation. Log in through official Claude Code if needed; do not put credentials in this repository.
- **Runtime.** Install the official Claude Code VS Code extension or CLI. Auto-discovery uses its native executable; `visualAgent.claude.executablePath` can override it. The VSIX includes the SDK library but excludes the platform-specific bundled Claude binary, so it stays portable and small. SDK-reported dollar estimates are labeled as estimates when using subscription quota, not an API invoice.
- **Permissions.** `permissionMode: "default"`, so Claude Code calls `canUseTool` before any edit or shell command, and the tool waits for your decision. Read-only adds `disallowedTools` for Edit, Write, Bash, web and Task. Protected and outside-workspace paths are denied.
- **Isolation.** `settingSources: []`: no user or project settings, hooks or permission rules are loaded or modified.
- **Status.** No API key is configured in this development environment, so the adapter is covered by **fixture contract tests**: the message stream, `canUseTool` blocking, follow-ups, auth refusal, and read-only denial. It wasn't run live. Treat it as experimental.

### Coding model ≠ reviewer model

The **coding model** (New Agent Task) and the **reviewer model** (Local AI Reviewer dropdown) are separate settings. Changing the reviewer model never touches a running coding session, and the reviewer stays read-only. For example: a local agent on `qwen3.8:27b`, reviewed with `gpt-oss:20b`.

---

## Reviewing work: files, commands, proposals and your own edits

### Explain this file

**Explain This File (Local AI)** is in the Explorer context menu, the editor title bar (book icon) and the editor context menu. It runs a structured explanation of the whole file, with these sections:
- **Purpose**
- **Execution flow**
- **Dependencies**: what the file imports, plus the project files that import it, found by a local text search whose results are sent as snippets only.
- **Modification impact**
- **Risks**

Long files are split into parts with expandable sections (see *Explain Code in Detail*). Explaining a function stays a secondary action. Use **Explain a function in this file…** in the panel, or **Explain Selection / Function in Detail…** in the editor menu. A function's explanation starts with its **role within the project** (callers, importers) and ends with its modification impact. Nothing runs until you click.

### Commands in Agent Activity

Each command row shows:
- a short **purpose**, e.g. *Run tests (pytest)*, *Install/change packages (npm)*, *Write app.py (cat)*, *Git commit*;
- the status, the recorded **duration** and the exit code;
- a **WRITES FILES (detected)** label when the command text shows that it creates, modifies or deletes files.

The label is a **heuristic**. A command *without* it may still change files, for example a script, build tool or program that writes internally. Details and approval prompts for unlabelled commands say so explicitly.

Purpose and write label come from the command text only (redirection, `tee`, `sed -i`, `rm/mv/cp`, installs, git, PowerShell writers, inline scripts). Status, duration and exit code come from the recorded tool result. No model is involved.

The row never contains the full command. Click it for:
- the **full original command**. It is collapsed when long or when it contains embedded code (here-documents, `python -c`, multi-line).
- the working directory, exit code and output.
- **Copy command** and **Copy output**, which copy the original recorded text.
- **Explain command**: an on-demand local-model explanation of purpose, reads, writes and risks. The command is never executed.

Approval prompts (sidebar and conversation) show the same summary and label, with the full command collapsed.

### Source changes go through patches, not shell commands

A shell command that writes a file cannot show a diff before it runs. Approving it is approving an unseen change. In a real Codex session (profile *Approve each command and each edit*, Windows), an approved `powershell.exe -Command '… $css = @'…'@; Add-Content -LiteralPath $stylePath …'` wrote `style.css` with no diff. This command was previously labelled *no file write detected*. Visual Agent now closes that path:

- **Every coding agent is told** to make source changes with its file-edit/patch tool (Codex: `developerInstructions` in profiles that can apply patches; Claude Code: appended to its default system prompt; local agent: its system prompt). Those changes keep the normal flow: diff → accept / reject / edit before applying / regenerate.
- **Explicit shell writes are blocked before execution**, without asking you: PowerShell `Add-Content`, `Set-Content`, `Out-File`, `Tee-Object`, `New-Item -Value`, `[IO.File]::Write*`; `>` / `>>` redirection; `tee`; `sed -i` / `perl -i`; `dd of=`; `git apply` / `patch`; and inline `python -c`, `node -e` or heredoc scripts that open or write files. Nested `powershell -Command`, `-EncodedCommand`, `bash -c` and `cmd /c` scripts are unquoted and checked as well. Here-document and here-string bodies are treated as data. Redirection to `/dev/null`, `$null` or `NUL` is allowed.
- **The agent is told why** through its normal decline channel (OpenCode reply message, Claude Code deny message, Codex `turn/steer` in the same turn): resubmit the change as an editable patch, and don't retry with another shell writer. The step is recorded as *Rejected*, command *NotRun*, with the detected writer and target.
- **Tests, builds and installs stay under command approval.** Their approval card says they may create or change files (build output, caches, snapshots, reports) and that no diff is available before they run.
- **Nothing is executed to find out what a command would write.** Detection reads the command text only. Diffs and conflict checks for patches are computed locally. No model is called; *Explain command* stays on demand.

This is a **heuristic** and does not catch every write. Not detected: writes a program or script does internally (`node scripts/generate.js`, `npm run build`), commands assembled at run time or obfuscated, PowerShell aliases such as `sc` / `ac`, and `cp` / `mv` / `rm` (these still get the **WRITES FILES** label and need approval).

### Review before writing

An edit the agent proposes is shown as a diff before anything is written; the local agent and Codex block the write until you decide. The approval card (conversation and sidebar) offers:

| Action | What happens |
|---|---|
| **Accept** | First checks that the file is exactly as it was when the diff was computed. If it changed on disk, has unsaved editor edits, was created or deleted, approval is **blocked**: nothing is written, the card shows the conflict, and *Regenerate with feedback* is offered. |
| **Reject** | Declines; an optional reason is recorded. |
| **Edit before applying** | Opens an editable copy of the proposed version beside the original snapshot. Nothing is written until **Apply my version**, which repeats the conflict check, writes your version, and declines the agent's own write with a message telling it you applied your version and that it must re-read the file. The write is recorded as your operation. Works for proposals that change several files (see below). |
| **Regenerate with feedback** | Declines with your feedback (the composer text, or a prompt). The local agent receives it and proposes again in the same turn. |

**Proposals that change several files** (for example one Codex patch) can be edited before applying as well:

- The conversation card lists **every file** of the proposal (new, changed, deleted; +/− lines; *edited by you* or *as proposed*). Click a file to open its editable copy beside the original snapshot. In Agent Activity, **Edit before applying** opens the same list as a quick pick. Notifications only describe the pending state; decisions stay in the panels.
- **Switching files keeps your edits.** Each file has its own copy in extension storage, never in the project. It is saved when you switch, so closing a tab does not lose it.
- **Reset** returns one file to the agent's proposal; the other files keep your edits.
- **Preview combined diff** shows everything that would be written, across all files, as one read-only diff, marking the files you edited. **Apply my version (N files)** shows this preview first and writes nothing; only applying again, with exactly the previewed content, writes. If you change anything after the preview, it is shown again.
- Before writing, **every file is checked** against the snapshot its diff was computed from (changed on disk, unsaved editor edits, created, deleted, or would undo your manual edits). One conflict blocks the whole proposal; nothing is written.
- Files are written as **one unit**. Each write is read back. If one fails, every file already written, including a partly written one, is restored to its previous content, and new files are removed. If a restore itself fails, the step names the file to check. A real filesystem has no transactions, so a crash in the middle of applying (VS Code or the machine) is not covered.
- **Proposed deletions can be excluded.** A file the agent wants to delete has **Keep file**: the deletion is left out, the file stays unchanged, and the rest of the proposal can still be applied. **Delete as proposed** (or **Reset**) re-includes it. Deleted files have no text to edit. If every file is excluded there is nothing to apply; reject the proposal instead.
- **Cancel editing** discards the copies; nothing is written and the proposal still awaits your decision. Copies are also discarded when the proposal is decided elsewhere or the task stops.
- The agent's own write is declined with a message listing each file, whether you edited it, and that it must re-read them. Your write is recorded as one operation with a diff per file.

The diffs, previews, file states and checks are computed locally; editing, switching, previewing and applying make no model requests.

**While a change is generated:** with OpenCode + Ollama, the edit's content arrives only when it is complete, together with the approval request. Until then the conversation shows **Generating a proposed change… review available when complete**, and the Agent Activity status says *Generating a proposed change; review when complete*. If a runtime streams the edit, the text is shown read-only as a live preview. Editing is enabled only once the proposal is complete.

**Before any write, your manual edits are protected too.** Accept (and Apply my version) is blocked when the proposal would remove lines you added, or bring back lines you deleted, since the agent's last applied version. This is the case of an agent writing a whole file from stale memory. Deleting a file with such edits is blocked as well. A shell command whose detected write target has your manual or unsaved edits is blocked the same way. This command check is heuristic, from the command text.

**What you applied with *Apply my version* stays protected in that conversation.** Your changes relative to the agent's proposal are remembered (in extension storage, across reloads). A later proposal that would remove them, or delete a file whose deletion you excluded, is blocked before it is written, just like a conflict. If you remove those lines yourself later, they are no longer protected. The check compares lines (whitespace-trimmed blocks), not meaning.

**Codex** cannot take a message in its approval reply. When you reject with a reason, regenerate with feedback, or apply your own version, the reason is sent to the same Codex turn right after the decline, with `turn/steer` and `expectedTurnId`. The timeline records whether it was delivered. If the turn had already ended, it is recorded as **not delivered**.

### Your own edits: Check my changes / Continue from my changes

After an agent edit is applied, Visual Agent stores the file's actual content as the agent's version. These baselines are kept in VS Code's workspace storage (never in the project) and **survive window reloads**. Your manual edits are the diff from that version to the file now.

- **Check my changes** sends those diffs in the same conversation and asks the agent to read the latest files and review your edits. It must not modify anything in that turn.
- **Continue from my changes** sends the diffs with rules, and the composer text becomes the next step. The rules: read the latest version of every file before changing it, keep your edits, continue, then validate the final version on disk and report the actual results.

After that turn, Visual Agent **checks the actual files itself**. For each of your hunks it verifies that the added lines are still present and deleted lines haven't come back. The result is recorded as a *Manual edits check* operation (✔ / ✖ per file) and shown in the conversation.

Unsaved edits must be saved first, because the agent reads from disk. Both actions are also commands (**Check My Changes**, **Continue from My Changes**).

## Codex mode (v0.2)

**Requirements:** a Codex native runtime and Codex login. Auto-discovery prefers the newest installed Codex VS Code extension's bundled runtime, then global npm and PATH installations. `visualAgent.codex.executablePath` overrides discovery. This avoids an older npm runtime hiding models already available in the Codex extension. Models and supported reasoning efforts still come from the selected runtime; **Light (low)** sends `low`, and does not change the selected model.

**Start:** click **▶ Codex task…** in Agent Activity (or run *Visual Agent: Start Codex Task…*). Enter your instructions and pick a safety profile.

### What you can and cannot control

Every operation in the timeline is labeled with how much control Visual Agent had:

| Label | Meaning |
|---|---|
| **OBSERVED** | Codex reported the operation **without asking**. Visual Agent could only record it. Its only constraint was Codex's sandbox. |
| **INTERCEPTED** | Codex **stopped and waited** for your decision, and enforced it before running anything. A rejected command never runs (it has no exit code). A rejected patch writes nothing. |
| **GATED** | Mock demo only. The Visual Agent controller itself held the simulated step. |

The details pane spells out the explanation for the selected operation.

### Safety profiles

All three profiles use Codex's **read-only sandbox** for commands Codex runs without asking. **A command you approve may run outside that sandbox and change files.** An earlier Codex build failed an approved `Set-Content` with *Access to the path … is denied*. On 2026-11-19, an approved `Add-Content` wrote `style.css` (Windows, `gpt-6.2-sol`). Commands that explicitly write files are therefore blocked before you are asked (see *Source changes go through patches*). Reviewable file changes are Codex patches, which you approve in **Approve each command and each edit**.

| Profile | Codex `approvalPolicy` | Commands | Patches (edits) |
|---|---|---|---|
| **Observe only** (default) | `on-request` | Run without asking, read-only (**observed**). Escalation requests are declined automatically. | Declined automatically |
| **Approve each command** | `untrusted` | Codex must ask first (**intercepted**). Explicit shell writes are blocked; an approved command may still change files indirectly (tests, builds, scripts). | Declined automatically |
| **Approve each command and each edit** | `untrusted` | As above | Codex must ask first. You see the full diff. **Approving applies that entire patch.** |

Additional safeguards:
- After `thread/start`, the adapter checks that Codex confirms `sandbox=readOnly` and the requested approval policy. If it doesn't, the task aborts before any turn starts.
- Approvals are always single-use (`accept`, `decline` or `cancel`). It never sends `acceptForSession`, policy amendments, or session-wide write grants (`grantRoot`).
- Patches are declined automatically if they touch a path outside the workspace or inside `.git`, or if Codex didn't report their content (so they can't be reviewed).
- Requests for additional sandbox permissions are always declined. Interactive questions and MCP elicitations are answered empty or declined.
- The edit profile is offered only for git repositories, and it warns about uncommitted changes, so every approved patch can be reviewed and reverted with git.

**Not per-function:** a decision covers the **whole patch**, which may span several functions or files. Function names shown for edits are *inferred* from the patch location, for navigation only.

### Controls in Codex mode

| Control | Effect |
|---|---|
| **Stop** | Sends `turn/interrupt` for the active turn, answers every pending approval with `cancel`, then closes the session's process. |
| **Pause** | **Not available.** Codex cannot be paused mid-turn. The button is disabled with an explanation; use Stop or Send instruction. |
| **✎ Send instruction** | Sends `turn/steer` with `expectedTurnId`, so the instruction is rejected if a different turn is active. It's recorded in the audit trail as an *Instruct* operation. Instructions **cannot** change the sandbox or approval policy, and pending approvals stay pending. |
| **Approve / Reject / Review diff** | As in the demo. The diff is reconstructed from Codex's unified-diff hunks against the current file. If a hunk doesn't apply, the raw patch is shown and nothing is guessed. |

### Isolation: what this does *not* do

- Each task starts its **own** `codex app-server` child process and an **ephemeral** thread, so it isn't saved to your Codex history.
- **It cannot see or intercept any other Codex session**, including the official Codex VS Code extension, the Codex CLI in a terminal, or Codex cloud tasks. Those run in separate processes that this extension doesn't connect to.
- The child process reuses your `~/.codex` login and config. Config isn't modified, but these command-line overrides apply to the child only: `--disable plugins remote_plugin apps hooks multi_agent computer_use browser_use image_generation` and `-c mcp_servers={}`. User hooks, MCP servers and sub-agents could otherwise act outside the observed item stream.
- The model comes from `visualAgent.codex.model`, or else from the server's `model/list` default. It doesn't use your config's `model`, which may not be available to your account.
- Codex is spawned **without a shell**: the native binary is located inside the npm package, because the `.cmd` shim would need `shell: true`.

### Codex settings

| Setting | Default | Meaning |
|---|---|---|
| `visualAgent.codex.defaultProfile` | `observe` | Profile preselected in the picker |
| `visualAgent.codex.model` | *(server default)* | Model id |
| `visualAgent.codex.executablePath` | *(auto)* | Native `codex`/`codex.exe` binary (not `.cmd`) |
| `visualAgent.codex.maxTurnMinutes` | `30` | Interrupt a turn that runs longer than this |

---

## Architecture

```
            ┌──────────────────────┐   nextOperation() / execute() / onDecision()
            │ AgentAdapter (iface) │◄──────────────────────────────┐
            │  └ MockAgentAdapter  │                               │
            └──────────────────────┘                               │
                                                        ┌──────────┴──────────┐
  UI gestures ──► HumanControlManager ── pause/resume/ ─►│   AgentController   │
  (webview,        │  (selection, Follow,  stop/approve/ │  (state machine)    │
   commands,       │   notifications)      reject        └──────────┬──────────┘
   notifications)  │                                                │ record / update
                   │                                     ┌──────────▼──────────┐
                   │ reads ◄──────────────────────────── │   EventRecorder     │── workspaceState
                   ▼                                     │ (audit trail, IDs,  │   (no source code)
   ActivityViewProvider · CommandTreeProvider            │  redaction)         │
   RecordDocumentProvider · CodeNavigator ·              └─────────────────────┘
   ChangeReviewManager (in-memory diffs)
```

Core modules (`types`, `adapters`, `controller`, `recorder`, path safety, symbol search, view model) don't import `vscode` and are unit-tested in plain Node. State management is fully separate from rendering: the webview receives a serializable view model and sends back intents.

### Modules

| File | Responsibility |
|---|---|
| [src/extension.ts](src/extension.ts) | Entry point. Wires the modules together and picks the adapter. |
| [src/types/events.ts](src/types/events.ts) | Typed event model: `AgentOperation`, `CommandExecution`, `TaskRecord`, `ChangeRecord`, `StatusTransition`… |
| [src/adapters/AgentAdapter.ts](src/adapters/AgentAdapter.ts) | **Adapter interface**: `beginTask`, `nextOperation` (propose, no side effects), `execute` (only after the controller allows it), `onDecision`, `endTask`. |
| [src/adapters/MockAgentAdapter.ts](src/adapters/MockAgentAdapter.ts), [demoScenario.ts](src/adapters/demoScenario.ts) | Scripted, side-effect-free mock agent and the demo scenario |
| [src/controller/AgentController.ts](src/controller/AgentController.ts) | Execution state machine: `start`, `pause`, `resume`, `stop`, `approve`, `reject`, plus an approval policy hook |
| [src/recorder/EventRecorder.ts](src/recorder/EventRecorder.ts) | Chronological history. Assigns IDs and sequence numbers, keeps an append-only status audit trail, persists, prunes, and marks interrupted work after a reload. |
| [src/recorder/redaction.ts](src/recorder/redaction.ts) | Secret redaction and output truncation, applied before anything is stored |
| [src/recorder/summary.ts](src/recorder/summary.ts) | Factual task summary built from the audit trail |
| [src/navigation/CodeNavigator.ts](src/navigation/CodeNavigator.ts) | Open, locate and highlight. Lookup order: document symbols → text search → line number → top of file. |
| [src/navigation/pathSafety.ts](src/navigation/pathSafety.ts) | Workspace containment checks: traversal, sibling prefixes, URLs, NUL bytes, Windows case |
| [src/navigation/symbolSearch.ts](src/navigation/symbolSearch.ts) | Language-server-free function range detection (Python and brace languages) and function replacement for diffs |
| [src/review/ChangeReviewManager.ts](src/review/ChangeReviewManager.ts) | Proposed changes as read-only virtual documents (`visual-agent-change:`) for the diff editor |
| [src/control/HumanControlManager.ts](src/control/HumanControlManager.ts) | All user gestures → controller calls. Follow behavior, context keys, status bar, approval prompts. |
| [src/ui/ActivityViewProvider.ts](src/ui/ActivityViewProvider.ts), [media/activity.js](media/activity.js) | Agent Activity webview. Strict CSP plus a nonce, DOM/`textContent` rendering only, validated messages. |
| [src/ui/viewModel.ts](src/ui/viewModel.ts) | Pure view model (which buttons are enabled, labels, selection) |
| [src/ui/CommandTreeProvider.ts](src/ui/CommandTreeProvider.ts) | *Agent Commands* tree view |
| [src/ui/RecordDocumentProvider.ts](src/ui/RecordDocumentProvider.ts) | Read-only command, operation and summary documents |
| [src/adapters/codex/CodexRpcClient.ts](src/adapters/codex/CodexRpcClient.ts) | JSON-RPC over JSONL stdio. Answers every server request (an error is still an answer), spawns without a shell, waits (bounded) for process exit. |
| [src/adapters/codex/CodexAppServerAdapter.ts](src/adapters/codex/CodexAppServerAdapter.ts) | Codex streaming adapter: handshake, boundary check, approvals, `turn/interrupt`, `turn/steer` |
| [src/adapters/codex/CodexItemMapper.ts](src/adapters/codex/CodexItemMapper.ts) | Pure mapping of Codex items to operations (Read/Test/Execute/Edit, paths, inferred function) |
| [src/adapters/codex/profiles.ts](src/adapters/codex/profiles.ts), [CodexSession.ts](src/adapters/codex/CodexSession.ts), [codexLocator.ts](src/adapters/codex/codexLocator.ts), [protocol.ts](src/adapters/codex/protocol.ts) | Safety profiles, isolation flags, native binary lookup, protocol subset (from `codex app-server generate-ts`) |
| [src/review/unifiedDiff.ts](src/review/unifiedDiff.ts) | Parses and applies Codex's hunks, for review rendering only |

### v0.3: provider-independent events

```
 Provider-specific                         Shared
 Codex notifications ─► CodexEventTranslator ─► NormalizedAgentEvent ─► NormalizedEventApplier ─► OperationSink (controller)
 Claude Code hooks   ─► (planned translator) ─┘
 Local agent tools   ─► (planned translator) ─┘
```

[src/adapters/normalizedEvents.ts](src/adapters/normalizedEvents.ts) defines `operation.announced`, `operation.running`, `operation.completed` and `log`, keyed by the provider's own operation id. [src/adapters/providers.ts](src/adapters/providers.ts) documents what each provider can and can't do. Claude Code and local-agent adapters are **planned, not implemented**: operation facts must come from the agent's tool layer, because model output alone isn't evidence.

| New module | Role |
|---|---|
| [src/analysis/changeAnalysis.ts](src/analysis/changeAnalysis.ts) | Changed ranges and affected functions from a real patch (pure) |
| [src/analysis/staticAnalysis.ts](src/analysis/staticAnalysis.ts) | Call sites, callees, `file:line` extraction from errors (pure, heuristic) |
| [src/reviewer/OllamaClient.ts](src/reviewer/OllamaClient.ts) | `/api/tags`, `/api/chat` streaming, cancellation, endpoint policy |
| [src/reviewer/ReviewService.ts](src/reviewer/ReviewService.ts) | Model selection, one request at a time, cache, coalesced streaming updates |
| [src/reviewer/prompts.ts](src/reviewer/prompts.ts) | Token-bounded, prioritized, redacted prompts |
| [src/reviewer/ReviewerController.ts](src/reviewer/ReviewerController.ts), [ReviewerViewProvider.ts](src/reviewer/ReviewerViewProvider.ts) | Targets, commands, result documents, panel |
| [src/export/reviewContext.ts](src/export/reviewContext.ts), [ExportController.ts](src/export/ExportController.ts) | Evidence-labeled Markdown, preview, copy/save |
| [src/adapters/codex/CodexEventTranslator.ts](src/adapters/codex/CodexEventTranslator.ts) | Codex → normalized events (moved out of the adapter) |

**Performance and resources.** Persistence is debounced (750 ms) instead of serializing the whole history on every event. Very long tasks compact the bulky fields of their oldest finished operations (above 5,000 per task). The timeline renders the latest 300 operations. Webview and reviewer updates are throttled. Reviewer requests are `fetch` streams, so they never block the extension host.

### v0.2 architecture change: pull and streaming adapters

```
 Mock (pull)    controller ──nextOperation()──► adapter    controller decides, then calls execute()
 Codex (push)   adapter ──announce/requestDecision──► OperationSink (implemented by the controller)
                Codex item/started ─► announce (Proposed, enforcement: none)
                requestApproval    ─► requestDecision (enforcement: agent-approval) ─► accept/decline/cancel
                outputDelta / item/completed ─► markRunning / complete
```

The controller still owns every decision, the pending-approval list (now several can be pending at once), Stop, and the audit trail. Streaming adapters never touch the recorder or UI directly. The adapter is chosen per task, so the mock demo and Codex coexist.

### Controller invariants

- Only one task runs at a time. Mock operations are handled one at a time; Codex may have several approvals pending.
- **Pause** stops new dispatch. It never interrupts the operation that's already running. An approval given while paused is recorded, and the operation runs after **Resume**.
- **Stop** cancels any pending decision (operation → `Cancelled`, change → `Cancelled`), aborts the running operation through an `AbortSignal`, prevents further dispatch, and ends the task as `Stopped`.
- **Approve/Reject** succeed only for the operation actually pending. Stale or duplicate decisions return `false`.
- Terminal statuses (`Completed`, `Failed`, `Rejected`, `Cancelled`) are final. The recorder enforces this.

### Safety properties (mock demo)

- The mock adapter has no filesystem or process access. Every command and result is flagged `simulated: true` and labeled **SIMULATED** in the sidebar, the command view, the documents and the notifications.
- Proposed edits exist only in memory. The diff's "original" side is a read-only snapshot.
- Persisted history (`workspaceState`) never contains source code. Change records keep metadata only, and all text fields pass through secret redaction and truncation.
- Navigation refuses paths outside the workspace (configurable) and handles missing files and functions with a fallback and a message.
- Webview: `default-src 'none'`, nonce-only scripts, no `innerHTML`, inbound messages shape-checked with an ID pattern and action allow-list.

---

## Tests and validation

```bash
npm test                  # 176 unit tests (Node test runner; no VS Code, Codex or Ollama needed)
npm run test:integration  # 32 end-to-end tests in a real Extension Development Host (uses a fake local Ollama / OpenCode)
npm run test:ollama:explain # REAL local model (opt-in): line-by-line (中文), structured, chunked file; checks line ranges
npm run test:acceptance   # REAL VS Code host + OpenCode + Ollama in a disposable project: explain file, conflict block, regenerate, edit-before-apply, continue from manual edits, command details/copy/explain, OpenCode server reuse / crash recovery / session continued / Restart / Stop
npm run test:opencode-server # REAL OpenCode server lifecycle, no inference: start + readiness + password, reuse, crash → automatic restart, extension-host crash, re-adoption, settings change, foreign PID never stopped, idle stop, restart limit
VAW_CODEX_SUITE=multi npm run test:codex # REAL Codex (uses quota) in a disposable git repo: one multi-file patch edited before applying (switch, reset, keep a deleted file, preview, conflict, rollback, cancel, apply); later proposals cannot overwrite it
node scripts/run-ui-check.js <dir>        # manual UI check: a visible window with a 5-file fixture proposal; drive it with the mouse (or scripts/lib/ui-driver.ps1), then create <dir>/done
node scripts/run-codex-decline-real.js   # REAL Codex (uses quota): a declined patch's reason reaches Codex and it re-proposes
npm run test:ollama       # REAL local models (opt-in; uses GPU/RAM): explain, review, cancel per model
npm run test:ollama:i18n  # REAL local model (opt-in): 中文 / English / bilingual answers, translation, cache, cancel
npm run test:local-agent  # REAL local coding agent (OpenCode + Ollama) in disposable repos: analysis, edit+approval, test, stop
node scripts/run-codex-model-select.js   # REAL Codex: one read-only turn with an explicit non-default model + effort
npm run test:codex        # 5 REAL Codex tests (read-only) in a disposable git repo; uses your Codex quota
VAW_CODEX_SUITE=edits npm run test:codex   # 2 REAL Codex write tests (approve/reject a patch)
VAW_CODEX_SUITE=session npm run test:codex # REAL Codex: three messages in one native thread, external edit re-read, resume after restart, isolated second conversation, and a comparison with the old new-thread-plus-replay path
```

**Codex tests always run in a disposable git repository** (a copy of `demo-workspace/` under the system temp folder, created by [scripts/lib/disposable-repo.js](scripts/lib/disposable-repo.js)). That repository is opened as the workspace of a separate Extension Development Host and deleted afterwards. The runner prints its final `git status` and diff.

Real Codex results (codex-cli 0.154.0, Windows 11):

| Test | Verified |
|---|---|
| observe | Real `Read validation.py` recorded as **OBSERVED**; Follow Agent opened it; repo clean |
| approve-commands: reject | `git log` **intercepted** and rejected; it never ran (no exit code); Codex acknowledged the rejection |
| approve-commands: approve | Approved `git log` ran; real output (`fixture`) recorded with exit 0 |
| Stop | `turn/interrupt` with an approval pending; task Stopped in about 0.1 s; pending op Cancelled |
| Send instruction | `turn/steer` mid-turn; Codex dropped its plan and answered `STEERED` |
| edits: reject | Patch intercepted and rejected; file byte-for-byte unchanged |
| edits: approve | Applied file **equals the reviewed proposal**; only `validation.py` modified |

Observed in both approve runs: Codex's final message said it inserted the line "as the first line", but its patch (and our reviewed diff) appended it at the end of the file. The agent's narration was wrong; the recorded diff was right.

Development probe: `node scripts/codex-probe.js` runs one turn in a disposable repo and records the raw protocol trace. It declines all edits; `--approve-commands` accepts commands. Approved commands may run outside the read-only sandbox, so use a disposable repository.

- **Codex unit tests** use an in-memory fake app-server ([src/test/support/fakeCodex.ts](src/test/support/fakeCodex.ts)) with item shapes copied from real traces. They cover: handshake and thread parameters, the boundary check, observed vs intercepted, accept/decline replies, read-only auto-decline of patches, outside-workspace and `.git` patch refusal, permission/question requests, Stop → `turn/interrupt` + `cancel`, steer with `expectedTurnId` and its failure modes, an app-server crash, and running mock tasks after Codex tasks.

- **Unit tests** ([src/test/](src/test/)) cover controller flows (approve, reject, pause/resume, approval while paused, stop while awaiting approval, stop while paused, stop mid-operation, strict policy, single active task), the recorder (sequencing, immutability, terminal states, redaction, truncation, persistence and reload, no source code persisted, pruning), path safety, function detection against the real fixtures, function replacement (LF and CRLF), and the view model.
- **Integration tests** ([src/test/integration/index.ts](src/test/integration/index.ts)) run the full demo inside VS Code. They check that Follow opens files, the diff appears, the controller blocks until approval, and no file is modified or dirtied. They also cover clicking an operation (cursor on `def load_data`), Follow-off leaving the editor untouched, pause/resume/stop on the live queue, rendering of the sidebar and record documents, and missing, outside-workspace and missing-function navigation.
- `test:integration` downloads an isolated VS Code build into `.vscode-test/` (set `VSCODE_EXECUTABLE` to use an installed one). It uses throwaway profile directories.

**Real local models** (`npm run test:ollama`, Ollama 0.40.16, this machine, two runs; times include model loading on first use):

| Model | Explain function | Review change | Cancel mid-stream |
|---|---|---|---|
| `qwen3:8b` | done; 7.5 s (35 s cold) | done; 5–7 s; cites `path:line` | stopped ≤ 1 ms after cancel |
| `gpt-oss:20b` | done; 13–14 s | done; 5–15 s; cites `path:line` | stopped ≤ 3 ms after cancel |
| `qwen3.8:27b` | done; 25–38 s | done; 52–56 s; cites `path:line` | stopped ≤ 2 ms after cancel |

Found by the real run: with only the function as context, gpt-oss reported `REQUIRED_FIELDS` as "never defined" (it is a module-level constant). Module-level definitions the function references are now included, and the claim no longer appears. In the same review, the model then made another false claim: a `KeyError` for a missing field, which the loop actually reports as `ValidationError`. Model output stays labeled unverified.

**Real Codex** (re-run after the v0.3 refactor): **7/7 passed** (`VAW_CODEX_SUITE=all`). Codex's real patch landed at module level, so no function name was attached.

v0.3 test coverage:
- **Unit:**
  - change analysis for Python and TypeScript, including the no-invented-names rule;
  - the Ollama client and reviewer against a fake HTTP server: discovery, preference, offline, model removed, streaming, cancellation (the server sees the connection closed), caching, and disabled meaning zero requests;
  - prompts: line numbers, redaction, priority truncation;
  - static analysis and error locations;
  - export fidelity;
  - **observation makes no LLM requests:** the only messages to Codex are the handshake plus the user's single `turn/start`, and the reviewer is never called;
  - **measured overhead.**
- **Integration (VS Code host):**
  - explain function and review change with a fake local Ollama (files untouched, result beside the code);
  - cancellation;
  - the export matches source on disk;
  - changed-line and affected-function navigation;
  - Ollama offline (the demo still works);
  - reviewer disabled (zero requests).

Measured (unit test `observerOverhead`, this machine): **6,000 Codex notifications (2,000 commands) processed in about 194–202 ms ≈ 32–34 µs per event**, with **1** persistence write (debounced). The heap grew by about 22 MB for 2,002 operations, each holding about 200 bytes of output.

**v0.4 real results (this machine; disposable git repos):**

| Check | Result |
|---|---|
| Local agent, `qwen3:8b`: read-only analysis, then a follow-up in the same session | ✔ read `math.js`, answered (13.2 s); follow-up answered (2.3 s); workspace unchanged |
| Local agent, `qwen3:8b`: proposed edit | ✔ `Edit math.js › divide() (+3 −0)` **blocked for approval, file byte-for-byte unchanged until approved**; diff shown first |
| Local agent, `qwen3:8b`: approved `node test.js` | ✔ ran; recorded exit code 0 = independent re-run; output "all tests passed"; only `math.js` changed; `.env` untouched |
| Local agent, `qwen3:8b`: Stop mid-turn | ✔ session aborted in 44 ms; nothing left running |
| Local agent, `gpt-oss:20b` / `qwen3.8:27b`: read-only analysis + follow-up | ✔ 22.8 s + 1.8 s / 92.5 s + 7.8 s; workspaces unchanged |
| Codex: explicit `gpt-5.6-sol` (not the default) + effort `low` | ✔ sent in `thread/start`/`turn/start`, confirmed by Codex, shown in the timeline |
| Claude Code | v0.4 had fixture-only validation. v0.5 additionally passes a real Pro-subscription read-only task and same-session follow-up. |

An earlier exploratory trace with `qwen3:8b` (approving everything automatically) produced an edit with literal `\n` sequences that broke `math.js`. The recorded diff and the failing `node test.js` output (SyntaxError) made this visible, which is the reason to review a local model's diff before approving it.

### Manual smoke test (≈3 minutes)

1. Press **F5**, open the *Visual Agent* sidebar, and make sure *Live Follow* is checked.
2. Click **▶ Start demo**. `importer.py` opens with `load_data()` highlighted, then `validation.py` with `validate_samples()`.
3. Click **⏸ Pause** during steps 1–4. The timeline stops growing. Click **⏵ Resume** and it continues.
4. At step 5, a diff opens beside the code and the *Approval needed* banner appears. Check that `validation.py` in the Explorer is unchanged.
5. Click **✓ Approve**. Step 6 shows `python -m pytest …` with **SIMULATED**, exit 0, and *5 passed*. Open it in *Agent Commands*.
6. Run the demo again and **✕ Reject** (enter a reason). Step 6 now shows exit 1, *3 failed*. The reason appears in the audit trail and the summary.
7. Run it again and click **⏹ Stop** while approval is pending. The edit becomes *Cancelled*, no test step runs, and the task is *Stopped*.
8. Uncheck *Live Follow* and start again. The editor doesn't change, but the timeline still updates. Click any past operation to navigate manually.
10. **Local AI (needs Ollama):** open *Local AI Reviewer*. The model list appears. Put the cursor in `validate_samples` and click **Explain function**; the result streams beside the code. Click **■ Cancel** during a run. Select the demo's Edit operation and click **Review change (local AI)**.
11. **Export:** select the Edit operation, click **Export…**, then **Entire task**. Check the preview, then click **Copy to Clipboard**.
9. Run `git status`, or check timestamps, to confirm no file in `demo-workspace/` changed.

---

## Roadmap

Done in v0.2: Codex App Server adapter, with real approvals, interrupt, steering, and observe/intercept labeling.
Done in v0.3: function-level change tracking, the Local AI Reviewer (Ollama), review-context export, and normalized provider events.
Done in v0.4: New Agent Task (provider, model, effort, workspace, profile); explicit Codex model selection; local coding agent through OpenCode + Ollama; experimental Claude Code adapter (Agent SDK); multi-turn sessions.
Done in v0.5: clickable file references in conversations; Explain Code in Detail (selection / function-class / file, structured or line by line, chunked, stale-aware).

1. ~~Multi-turn Codex sessions~~ (done: one native thread per conversation, resumed after restart).
2. **Claude Code write validation.** Subscription read-only and follow-up are validated; run the edit/command approval flows live before promoting the integration from experimental.
3. **Hunk-level review.** Partial approval needs an execution path that applies only the accepted hunks. Codex's approval is all-or-nothing per patch, so this would mean declining the patch and applying hunks ourselves.
4. **Policies.** Path globs (never `.env`), command allow/deny lists, and auto-approve for read-only commands under `untrusted`.
5. **Cline adapter.** Same streaming interface.
6. **Export.** Audit trail as JSONL.

## Known limitations

- **Command summaries, the WRITES FILES label and the shell-write block** are static heuristics from the command text. A script that writes files internally (`python build.py`), a command built at run time, or a PowerShell alias (`sc`, `ac`) is not caught, and `cp` / `mv` / `rm` are labelled but not blocked. False positives are possible too: `npm test > out.txt` or `git diff > x.patch` is blocked, and the agent is told to run it without the redirection. There is no setting to turn the block off. Use **Explain command** for a closer look.
- **Approved Codex commands** may run outside Codex's read-only sandbox (observed 2026-11-19). The block covers explicit writes only; tests, builds and other programs you approve can still change files without a prior diff.
- **Review before writing:** conflict checks compare against the snapshot read when the proposal arrived; changes made in the instant between that read and the agent's own read are not detectable. Multi-file *Apply my version* restores already-written files if a write fails, but a crash of VS Code or the machine in the middle of applying is not covered (no filesystem transactions). Deleted files can be kept or deleted, not edited. When Codex receives the decline, a later Codex proposal in the same turn may still be computed from its own stale view; it is blocked if it would undo what you applied, but you have to reject it.
- **Manual changes:** baselines exist only for files an agent edited (or you applied) in a recorded conversation, and are dropped when history is cleared. Protection of what you applied with *Apply my version* is per conversation: a new conversation in the same project does not know about it. The manual-edit protection is line-based (trimmed): it cannot tell whether a moved or reformatted edit is semantically the same, and it cannot protect edits from commands whose write targets are not visible in the command text.
- **OpenCode server:** one managed server per VS Code window. Two windows each run their own. The server you start in a terminal is never used. Re-adoption after an extension restart only applies where a server outlives its host (on Windows it is ended with the crashed host, so a new one is started). A server that hangs without exiting is stopped only if this window started it in this session; a hung re-adopted server is left running and reported. The extension does not bundle OpenCode in a packaged VSIX (it is a dev dependency): install `opencode-ai` or set `visualAgent.local.opencodePath`. A turn running when the server dies fails; it is not resumed automatically, but sending again continues the same session.
- **Live preview** depends on the runtime streaming tool arguments; OpenCode + Ollama did not in real runs, so only the "generating" state is shown.
- **Codex in read-only sandboxes** may decline to propose a patch at all ("the workspace is read-only") unless told that patches are reviewed. Observed with `gpt-6.2-sol`. Profiles that can apply patches now say so in `developerInstructions`; this has fixture coverage, not a real Codex run.
- **Demo fixture:** `demo-workspace/` is also the first folder of the F5 development workspace. Real agent sessions run there can modify it, which breaks fixture-based tests. Use a separate project for real agent sessions.
- **References:** relative paths with spaces are recognised in Markdown links and code spans, not in plain prose (where they can't be told apart from a sentence); absolute paths with spaces in prose are recognised when the file name itself has no space. Python traceback lines (`File "x.py", line 12`) and references inside fenced code blocks are not linked. References are linked in the Conversations panel and explanation panel, not in the Agent Activity sidebar.
- **Explain Code in Detail:** output is model-generated and unverified; [Fact]/[Inference]/[Issue] labels are the model's own. Small models may produce malformed headings (cleaned where possible), overlapping ranges, or skip lines (reported as *Not covered*). Chunking is syntax-aware for Python and TS/JS; other languages are split by lines with blank-line boundaries. Explanations are kept for the current window session only (export to keep them).
- **Local agent memory:** OpenCode talks to Ollama's OpenAI-compatible endpoint, which can't set `num_ctx`. `visualAgent.local.contextLimit` bounds what OpenCode *sends*, but Ollama still allocates its own default context. Observed: `qwen3:8b` at 40,960 tokens and 11.2 GB, `qwen3.8:27b` at 262,144 tokens and **32.5 GB**. To reduce this, set `OLLAMA_CONTEXT_LENGTH` for your Ollama server yourself; Visual Agent doesn't change Ollama's configuration.
- **Local agent quality** depends on the model. Small models can produce broken edits or leak reasoning text. Review diffs before approving.
- **Claude Code:** experimental integration. Subscription read-only and follow-up are live-tested; edit/command permission flows have fixture coverage. Native session resume has fixture coverage only (not run against real Claude Code).
- **Native sessions:** continuity depends on the agent's own history storage (`~/.codex`, `~/.claude/projects`, OpenCode's database). If that history is cleared, the next message starts a new session with the labeled reconstructed summary. Change notes cover files the agent read or edited through tool events, plus existing project files named in its commands (`cat x`, `Get-Content x`, `grep … x`). A file reached only indirectly (a glob, a path built at run time, a script that opens it) is not tracked. A command that may write only refreshes files already tracked. Token counts are the agent's own reports; providers that report none show none.
- **Multi-root:** a task runs in the folder chosen in New Agent Task, and navigation follows that folder.
- **Reviewer:** model output is unverified. Impact analysis without a language server is a text heuristic (same-named functions and dynamic calls aren't distinguished). Change content for review and export lives in memory for the current session only. Function parsing covers Python and TS/JS; other languages fall back to file and line.
- **Reviewer:** "beside the code" means a read-only Markdown document in the side editor group. There are no inline annotations.
- **Codex:** no pause; Codex sessions started elsewhere (VS Code extension, CLI, cloud) are invisible to this extension; under `observe`, reads are observed, not prevented; Windows sandbox behavior depends on your Codex Windows sandbox setup (`[windows] sandbox` in `~/.codex/config.toml`).
- **Codex output:** `aggregatedOutput` mixes stdout and stderr, and it's labeled as such.
- **Codex workspace:** New Agent Task uses its selected project folder; legacy demo/entry points can use the first workspace folder.

## Known limitations (v0.1 mock)

- One agent and one task at a time. Multi-root workspaces use the first folder.
- Proposed-change content lives in memory only, so diffs for past sessions aren't available after a reload. Their metadata and decisions still are.
- Function lookup uses the language server when one is installed. Otherwise a text heuristic covers Python and C-like languages.
- The simulated pytest output was derived by reading the fixture code. It wasn't produced by running pytest, because Python wasn't available in the development environment.
