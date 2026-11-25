/**
 * REAL Codex end-to-end tests. Runs inside an Extension Development Host whose
 * workspace is a DISPOSABLE git repository created by
 * scripts/run-codex-integration.js. Uses the developer's Codex login/quota.
 *
 * VAW_CODEX_SUITE = "readonly" (default) | "edits" | "multi" | "session" | "all"
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VisualAgentApi } from '../../extension';
import type { AgentOperation } from '../../types/events';

type Case = [string, 'readonly' | 'edits' | 'multi' | 'session', (api: VisualAgentApi) => Promise<void>];
const TURN_TIMEOUT = 240_000;

function root(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}
function gitStatus(): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root(), encoding: 'utf8' }).trim();
}
async function waitUntil<T>(probe: () => T | undefined | false, what: string, timeoutMs = TURN_TIMEOUT): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) {
      return v;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
function describeOps(ops: AgentOperation[]): string {
  return ops
    .map((o) => `  #${o.sequenceNumber} [${o.status}] ${o.operationType} ${o.enforcement} ${o.description}${o.filePath ? ` (${o.filePath})` : ''}`)
    .join('\n');
}
async function finish(api: VisualAgentApi, taskId: string): Promise<AgentOperation[]> {
  // Codex sessions are multi-turn: the turn ends with "waiting for input"; then the session is ended.
  await waitUntil(() => !api.controller.isActive || api.controller.getSnapshot().awaitingInput, 'turn end');
  if (api.controller.isActive) await api.controller.endSession();
  await api.controller.whenIdle();
  const ops = api.recorder.getOperations(taskId);
  console.log(`    task ${api.recorder.getTask(taskId)!.status}\n${describeOps(ops)}`);
  return ops;
}

const cases: Case[] = [
  [
    'observe: real event stream, observed-only operations, follow navigation, workspace untouched',
    'readonly',
    async (api) => {
      await vscode.commands.executeCommand('visualAgent.followOn');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const taskId = api.startCodex(
        'Read the file validation.py (for example with Get-Content) and answer in one sentence: which fields does validate_samples() check? Do not modify any files.',
        'observe',
      );
      const ops = await finish(api, taskId);
      assert.equal(api.recorder.getTask(taskId)!.status, 'Completed');
      assert.equal(api.recorder.getTask(taskId)!.simulated, false);
      assert.match(ops[0].description, /Codex session started: .*read-only sandbox, approval "on-request"/);
      const commands = ops.filter((o) => o.command);
      assert.ok(commands.length >= 1, 'Codex ran at least one command');
      for (const c of commands) {
        assert.equal(c.enforcement, 'none', 'observe profile: everything is observed-only');
        assert.equal(c.command!.simulated, false);
      }
      assert.ok(ops.some((o) => o.operationType === 'Analyze' && /^Codex: /.test(o.description)), 'final answer recorded');
      const readOp = ops.find((o) => o.operationType === 'Read' && o.filePath === 'validation.py');
      if (readOp) {
        // Follow Agent reused the v0.1 navigator for a real Codex read.
        await waitUntil(() => vscode.window.visibleTextEditors.some((e) => e.document.uri.fsPath.toLowerCase().endsWith('validation.py')), 'follow opened validation.py', 10_000);
      } else {
        console.log('    (Codex did not report a parsed read of validation.py; navigation check skipped)');
      }
      assert.equal(gitStatus(), '', 'workspace unchanged');
    },
  ],
  [
    'approve-commands: real interception; a rejected command is never run',
    'readonly',
    async (api) => {
      const taskId = api.startCodex(
        'Run the shell command `git log --oneline -1` and report its output. If it is rejected, say so and stop. Do not modify files.',
        'approve-commands',
      );
      const pendingId = await waitUntil(() => api.controller.getSnapshot().pendingApprovals[0], 'first approval request');
      const pending = api.recorder.getOperation(pendingId)!;
      console.log(`    intercepted: ${pending.description} | ${pending.command?.command}`);
      assert.equal(pending.enforcement, 'agent-approval');
      assert.equal(pending.status, 'Proposed');
      assert.ok(api.controller.reject(pendingId, 'integration test rejects'));
      // Reject anything else Codex tries, so nothing runs in this test.
      const sweeper = setInterval(() => {
        for (const id of api.controller.getSnapshot().pendingApprovals) {
          api.controller.reject(id, 'integration test rejects');
        }
      }, 100);
      try {
        const ops = await finish(api, taskId);
        const rejected = ops.find((o) => o.operationId === pendingId)!;
        assert.equal(rejected.status, 'Rejected');
        assert.equal(rejected.command?.status, 'NotRun');
        assert.equal(rejected.command?.exitCode, undefined, 'no exit code: it never ran');
        assert.ok(ops.filter((o) => o.command).every((o) => o.status === 'Rejected'), 'no command ran');
      } finally {
        clearInterval(sweeper);
      }
      assert.equal(gitStatus(), '');
    },
  ],
  [
    'approve-commands: an approved command runs and its real output is recorded',
    'readonly',
    async (api) => {
      const taskId = api.startCodex('Run exactly `git log --oneline -1` once and report the commit message. Do not run anything else.', 'approve-commands');
      const approved = new Set<string>();
      const sweeper = setInterval(() => {
        for (const id of api.controller.getSnapshot().pendingApprovals) {
          const op = api.recorder.getOperation(id);
          if (op && /git/.test(op.command?.command ?? '') && approved.size === 0) {
            approved.add(id);
            api.controller.approve(id);
          } else {
            api.controller.reject(id, 'only the requested git command is allowed');
          }
        }
      }, 100);
      try {
        const ops = await finish(api, taskId);
        const ran = ops.find((o) => approved.has(o.operationId));
        assert.ok(ran, 'a git command was approved');
        assert.equal(ran!.enforcement, 'agent-approval');
        assert.equal(ran!.status, 'Completed');
        assert.equal(ran!.command?.exitCode, 0);
        assert.match(ran!.command?.stdout ?? '', /fixture/, 'real output from the disposable repo');
        assert.ok(ran!.history.some((h) => h.actor === 'user' && /Approved/.test(h.note ?? '')));
      } finally {
        clearInterval(sweeper);
      }
      assert.equal(gitStatus(), '');
    },
  ],
  [
    'Stop interrupts the real Codex turn while an approval is pending',
    'readonly',
    async (api) => {
      const taskId = api.startCodex('List all files with a shell command, then read each Python file one by one with separate commands, then summarize.', 'approve-commands');
      const pendingId = await waitUntil(() => api.controller.getSnapshot().pendingApprovals[0], 'approval request');
      const t0 = Date.now();
      assert.ok(api.controller.stop());
      const ops = await finish(api, taskId);
      console.log(`    stopped in ${Date.now() - t0} ms`);
      assert.equal(api.recorder.getTask(taskId)!.status, 'Stopped');
      assert.equal(api.recorder.getOperation(pendingId)!.status, 'Cancelled');
      assert.ok(ops.every((o) => o.status !== 'Running' && o.status !== 'Proposed'));
      assert.ok(Date.now() - t0 < 30_000, 'stop is prompt');
      assert.equal(gitStatus(), '');
    },
  ],
  [
    'Send instruction (turn/steer) changes the running task',
    'readonly',
    async (api) => {
      const taskId = api.startCodex(
        'Use the shell to read importer.py, then validation.py, then tests/test_validation.py, one command each, then write a detailed review of all three.',
        'approve-commands',
      );
      const firstId = await waitUntil(() => api.controller.getSnapshot().pendingApprovals[0], 'first approval');
      const instruct = await api.controller.steer('Change of plan: do not run any more commands. Reply with exactly the word STEERED and finish.');
      assert.equal(instruct.status, 'Completed');
      assert.equal(instruct.operationType, 'Instruct');
      api.controller.reject(firstId, 'plan changed by instruction');
      const sweeper = setInterval(() => {
        for (const id of api.controller.getSnapshot().pendingApprovals) {
          api.controller.reject(id, 'plan changed by instruction');
        }
      }, 100);
      try {
        const ops = await finish(api, taskId);
        const answer = ops.filter((o) => /^Codex: /.test(o.description)).at(-1);
        console.log(`    final answer: ${answer?.resultSummary?.slice(0, 120)}`);
        assert.match(answer?.resultSummary ?? '', /STEERED/, 'Codex followed the instruction');
      } finally {
        clearInterval(sweeper);
      }
      assert.equal(gitStatus(), '');
    },
  ],

  // ---------------------------------------------------- Step 3: writes
  [
    'approve-edits: a rejected patch leaves the file unchanged',
    'edits',
    async (api) => {
      const before = fs.readFileSync(path.join(root(), 'validation.py'), 'utf8');
      const taskId = api.startCodex(
        "Using your apply_patch file-editing tool (not a shell command), insert the line '# reviewed by visual agent' as the first line of validation.py. If the patch is rejected, do not retry; just say it was rejected.",
        'approve-edits',
      );
      const sweeper = setInterval(() => {
        for (const id of api.controller.getSnapshot().pendingApprovals) {
          api.controller.reject(id, 'test: reject every change');
        }
      }, 100);
      try {
        const ops = await finish(api, taskId);
        const edit = ops.find((o) => o.operationType === 'Edit');
        assert.ok(edit, 'Codex proposed a patch');
        assert.equal(edit!.enforcement, 'agent-approval');
        assert.equal(edit!.status, 'Rejected');
        assert.equal(api.recorder.getChange(edit!.associatedChangeId!)!.decision, 'Rejected');
      } finally {
        clearInterval(sweeper);
      }
      assert.equal(fs.readFileSync(path.join(root(), 'validation.py'), 'utf8'), before);
      assert.equal(gitStatus(), '');
    },
  ],
  [
    'approve-edits: the reviewed patch is exactly what gets applied',
    'edits',
    async (api) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      const taskId = api.startCodex(
        "Using your apply_patch file-editing tool (not a shell command), insert the line '# reviewed by visual agent' as the first line of validation.py. Make no other change and run no commands.",
        'approve-edits',
      );
      const pendingId = await waitUntil(() => {
        const id = api.controller.getSnapshot().pendingApprovals[0];
        return id && api.recorder.getOperation(id)?.operationType === 'Edit' ? id : undefined;
      }, 'patch approval');
      const edit = api.recorder.getOperation(pendingId)!;
      assert.equal(edit.filePath, 'validation.py');
      // The diff shown for review (virtual document) must be what Codex will apply.
      const diffTab = await waitUntil(
        () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'visual-agent-change'),
        'review diff opened by Follow Agent',
        15_000,
      );
      const proposed = (await vscode.workspace.openTextDocument((diffTab.input as vscode.TabInputTextDiff).modified)).getText();
      assert.equal(gitStatus(), '', 'nothing written before approval');
      assert.ok(api.controller.approve(pendingId));
      const sweeper = setInterval(() => {
        for (const id of api.controller.getSnapshot().pendingApprovals) {
          api.controller.reject(id, 'test: only the first patch is approved');
        }
      }, 100);
      try {
        const ops = await finish(api, taskId);
        assert.equal(ops.find((o) => o.operationId === pendingId)!.status, 'Completed');
      } finally {
        clearInterval(sweeper);
      }
      const after = fs.readFileSync(path.join(root(), 'validation.py'), 'utf8');
      // System property under test: what was reviewed is exactly what was applied.
      // (Where the model chose to put the line is model behaviour, not ours; in
      // practice Codex has appended it at the end while claiming "first line".)
      assert.match(after, /^# reviewed by visual agent$/m);
      assert.equal(after.replace(/\r\n/g, '\n'), proposed.replace(/\r\n/g, '\n'), 'applied file == reviewed proposal');
      if (after.split(/\r?\n/)[0] !== '# reviewed by visual agent') {
        console.log('    NOTE: Codex placed the line elsewhere than instructed; the reviewed diff showed the true location.');
      }
      assert.equal(gitStatus(), 'M validation.py', 'only the approved file changed');
    },
  ],
  // ---------------------------------------------------- multi-file edit before applying (real Codex patch)
  [
    'multi-file: edit a real Codex patch before applying (switch, keep edits, reset, exclude deletion, preview, conflict, rollback, cancel, apply); later proposals cannot overwrite the applied version',
    'multi',
    async (api) => {
      const { controller, recorder, controls } = api;
      const file = (rel: string) => path.join(root(), rel);
      const read = (rel: string) => (fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), 'utf8') : undefined);
      // A committed file the patch will delete.
      fs.writeFileSync(file('legacy_notes.txt'), 'Old notes that the agent will propose to delete.\n');
      execFileSync('git', ['add', 'legacy_notes.txt'], { cwd: root() });
      execFileSync('git', ['commit', '-q', '-m', 'add legacy notes'], { cwd: root() });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root(), encoding: 'utf8' }).trim();
      const original = { validation: read('validation.py')!, importer: read('importer.py')!, legacy: read('legacy_notes.txt')! };
      const timings: Record<string, number> = {};
      const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const t = Date.now();
        const r = await fn();
        timings[name] = Date.now() - t;
        return r;
      };
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // Started like the New Agent Task panel does, so the conversation can be continued (protection is per conversation).
      const models = await api.launcher.models('codex', root());
      const model = models.find((m) => m.isDefault && m.compatible) ?? models.find((m) => m.compatible)!;
      console.log(`    Codex model: ${model.id}`);
      const taskId = (await api.launcher.start({
        provider: 'codex',
        model: model.id,
        effort: model.efforts?.includes('low') ? 'low' : model.defaultEffort,
        profile: 'approve-edits',
        workspaceRoot: root(),
        instructions:
          'Make ALL of the following changes together in ONE single apply_patch call (one patch touching four files; not a shell command, no separate patches): ' +
          "(1) add the line '# multi-file edit test' as the first line of validation.py; (2) add the line '# multi-file edit test' as the first line of importer.py; " +
          "(3) create a new file NOTES.md containing exactly the line '# Notes'; (4) delete the file legacy_notes.txt. Do not run any commands. " +
          'If the patch is declined, do not retry it; wait for further instructions.',
      }))!;
      assert.ok(taskId, 'Codex conversation started');
      await vscode.commands.executeCommand('visualAgent.openConversations', taskId);
      // Wait for a multi-file patch. If Codex splits the work, ask once more for a single patch.
      let p1: string | undefined;
      for (let attempt = 0; attempt < 3 && !p1; attempt++) {
        const id = await waitUntil(() => controller.getSnapshot().pendingApprovals.find((x) => recorder.getOperation(x)?.operationType === 'Edit' || recorder.getOperation(x)?.command), 'patch approval');
        const op = recorder.getOperation(id)!;
        const n = op.associatedChangeIds?.length ?? (op.associatedChangeId ? 1 : 0);
        console.log(`    proposal: ${op.description} (${n} file(s))`);
        if (op.operationType === 'Edit' && n >= 2) p1 = id;
        else controller.reject(id, 'Please put ALL four changes into ONE single apply_patch call (one patch with all four files).');
      }
      assert.ok(p1, 'Codex proposed one patch touching several files');
      const files = () => controls.proposals.editState(p1!)!.files;
      const ids = recorder.getOperation(p1)!.associatedChangeIds!;
      console.log(`    files: ${ids.map((id) => `${api.recorder.getChange(id)?.filePath}`).join(', ')}`);
      assert.equal(gitStatus(), '', 'nothing written before any decision');

      // Cancel first: nothing written, still pending.
      await ConversationPanelReceive({ type: 'action', action: 'editProposal', operationId: p1 });
      await waitUntil(() => controls.proposals.isEditing(p1!), 'editing', 15_000);
      await screenshot('01-file-list');
      await ConversationPanelReceive({ type: 'action', action: 'cancelEdit', operationId: p1 });
      assert.equal(controls.proposals.isEditing(p1), false);
      assert.ok(controller.getSnapshot().pendingApprovals.includes(p1), 'cancel keeps the proposal pending');
      assert.equal(gitStatus(), '', 'cancel wrote nothing');

      // Edit again.
      await timed('open editing (first file)', () => ConversationPanelReceive({ type: 'action', action: 'editProposal', operationId: p1 }));
      await waitUntil(() => controls.proposals.isEditing(p1!), 'editing again', 15_000);
      const idx = (rel: string) => files().findIndex((f) => f.rel === rel);
      const iv = idx('validation.py'), ii = idx('importer.py'), inotes = idx('NOTES.md'), ilegacy = idx('legacy_notes.txt');
      console.log(`    file list: ${files().map((f) => `${f.rel} [${f.kind}${f.editable ? '' : ', not editable'}] +${f.added} −${f.removed}`).join('; ')}`);
      assert.ok(iv >= 0 && ii >= 0, 'both Python files are in the patch');
      const copy = (rel: string) => waitUntil(() => vscode.workspace.textDocuments.find((d) => d.uri.fsPath.includes(path.join('proposals', p1!)) && d.uri.fsPath.endsWith(rel)), `${rel} copy`, 15_000);
      const setDoc = async (doc: vscode.TextDocument, text: string) => {
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
        await vscode.workspace.applyEdit(we);
      };
      const USER_LINE = '# edited by the user: keep this line';
      await timed('switch to validation.py', () => ConversationPanelReceive({ type: 'editFile', operationId: p1, index: iv }));
      const vDoc = await copy('validation.py');
      const vMine = vDoc.getText().replace(/\n?$/, `\n${USER_LINE}\n`);
      await setDoc(vDoc, vMine);
      await timed('switch to importer.py', () => ConversationPanelReceive({ type: 'editFile', operationId: p1, index: ii }));
      await waitUntil(() => files()[ii].active, 'switched', 10_000);
      assert.equal(files()[iv].edited, true, 'validation.py edits kept after switching');
      const iDoc = await copy('importer.py');
      await setDoc(iDoc, iDoc.getText() + '# temporary edit\n');
      await waitUntil(() => files()[ii].edited, 'importer edited', 10_000);
      await screenshot('02-editing-importer');
      await timed('reset importer.py', () => ConversationPanelReceive({ type: 'resetEditFile', operationId: p1, index: ii }));
      assert.equal(files()[ii].edited, false, 'reset importer.py to the proposal');
      assert.equal(files()[iv].edited, true, 'validation.py still edited');
      await timed('switch back to validation.py', () => ConversationPanelReceive({ type: 'editFile', operationId: p1, index: iv }));
      assert.equal(eol(vDoc.getText()), eol(vMine), 'validation.py edit preserved across switches');
      if (inotes >= 0) {
        await ConversationPanelReceive({ type: 'editFile', operationId: p1, index: inotes });
        const nDoc = await copy('NOTES.md');
        await setDoc(nDoc, '# Notes\n\nWritten by the user.\n');
      }
      if (ilegacy >= 0) {
        await ConversationPanelReceive({ type: 'excludeDeletion', operationId: p1, index: ilegacy, excluded: true });
        assert.equal(files()[ilegacy].excluded, true);
      } else console.log('    NOTE: Codex did not include the deletion; the exclusion check is skipped');
      // Combined preview (first apply).
      await timed('apply #1 → combined preview', () => ConversationPanelReceive({ type: 'action', action: 'applyEdited', operationId: p1 }));
      const preview = await waitUntil(() => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'visual-agent-edit-preview' && d.uri.path.includes(p1!)), 'combined preview', 10_000);
      assert.match(preview.getText(), new RegExp(USER_LINE));
      if (ilegacy >= 0) assert.match(preview.getText(), /legacy_notes\.txt\n\(deletion excluded by you/);
      await screenshot('03-combined-preview');
      assert.equal(gitStatus(), '', 'preview wrote nothing');
      // Conflict: importer.py changed on disk.
      fs.writeFileSync(file('importer.py'), original.importer + '# changed outside\n');
      await assert.rejects(controls.proposals.applyEditedVersion(p1), /Not applied: importer\.py changed on disk[\s\S]*Nothing was written/);
      fs.writeFileSync(file('importer.py'), original.importer);
      assert.equal(read('validation.py'), original.validation, 'conflict: nothing written');
      // Rollback: the second write fails.
      const realStore = controls.proposals.fileStore;
      let writes = 0;
      controls.proposals.fileStore = { ...realStore, write: async (abs, text) => { if (++writes === 2) throw new Error('injected write failure'); await realStore.write(abs, text); } };
      await assert.rejects(controls.proposals.applyEditedVersion(p1), /injected write failure[\s\S]*restored/);
      controls.proposals.fileStore = realStore;
      assert.equal(gitStatus(), '', 'rollback: working tree exactly as before');
      // Apply (explicit, previewed content).
      const ok = await timed('apply #2 (write)', () => controls.proposals.applyEditedVersion(p1!));
      assert.equal(ok, true);
      assert.ok(read('validation.py')!.includes(USER_LINE), 'user version of validation.py on disk');
      assert.ok(read('importer.py')!.includes('# multi-file edit test') && !read('importer.py')!.includes('# temporary edit'), 'importer.py: the proposed version (the temporary edit was reset)');
      if (inotes >= 0) assert.equal(read('NOTES.md'), '# Notes\n\nWritten by the user.\n');
      if (ilegacy >= 0) assert.equal(read('legacy_notes.txt'), original.legacy, 'excluded deletion: file kept');
      console.log(`    git status after apply:\n${gitStatus().replace(/^/gm, '      ')}`);
      await screenshot('04-applied');

      // The agent must not overwrite the applied version. In a follow-up turn of the SAME conversation,
      // ask Codex explicitly to remove the user's line and delete the kept file.
      await waitUntil(() => !controller.getSnapshot().pendingApprovals.includes(p1!), 'agent write declined', 10_000);
      for (let i = 0; i < 20 && controller.isActive && !controller.getSnapshot().awaitingInput; i++) {
        const id = controller.getSnapshot().pendingApprovals[0];
        if (id) controller.reject(id, 'Wait for further instructions.');
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (controller.isActive) {
        if (controller.getSnapshot().awaitingInput) await controller.endSession();
        else controller.stop();
        await controller.whenIdle();
      }
      console.log(`    first turn:\n${describeOps(recorder.getOperations(taskId))}`);
      assert.equal(
        await api.launcher.send(taskId, `Using your apply_patch tool, remove the line '${USER_LINE}' from validation.py and delete the file legacy_notes.txt, in one patch. Do not run commands.`),
        true,
        'follow-up sent in the same conversation',
      );
      const blocked: string[] = [];
      const deadline = Date.now() + 180_000;
      while (controller.isActive && !controller.getSnapshot().awaitingInput && Date.now() < deadline) {
        const id = controller.getSnapshot().pendingApprovals[0];
        if (!id) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        const op = recorder.getOperation(id)!;
        const c = await controls.proposals.check(id);
        console.log(`    later proposal: ${op.description} → ${c.ok ? 'no conflict' : controls.proposals.describe(c)}`);
        if (!c.ok) {
          blocked.push(controls.proposals.describe(c));
          // Approving is refused before anything is written.
          await controls.runAction('approve', id);
          await controls.runAction('approve', id);
          assert.ok(controller.getSnapshot().pendingApprovals.includes(id), 'approval refused');
        }
        controller.reject(id, 'Keep the user version. Stop now.');
      }
      if (controller.isActive) {
        controller.stop();
        await controller.whenIdle();
      }
      console.log(`    follow-up turn:\n${describeOps(recorder.getOperations(taskId).slice(-8))}`);
      console.log(`    blocked later proposals: ${blocked.length ? blocked.join(' | ') : '(Codex proposed none)'}`);
      if (process.env.VAW_REQUIRE_BLOCK === '1') assert.ok(blocked.length, 'Codex proposed an overwrite and it was blocked');
      assert.ok(read('validation.py')!.includes(USER_LINE), 'the user line survived');
      if (ilegacy >= 0) assert.equal(read('legacy_notes.txt'), original.legacy, 'the kept file survived');
      console.log(`    timings (ms): ${Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
      for (const [k, v] of Object.entries(timings)) assert.ok(v < 3000, `${k} responded in ${v} ms`);
      // Leave the repository clean for the next case.
      execFileSync('git', ['reset', '-q', '--hard', head], { cwd: root() });
      execFileSync('git', ['clean', '-qfd'], { cwd: root() });
      execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: root() });
    },
  ],

  // ---------------------------------------------------- native session continuity (real Codex)
  [
    'session: inspect → modify → explain in ONE native thread; external edit is re-read; restart resumes the thread; a second conversation is isolated; compared with the old new-thread-plus-replay path',
    'session',
    async (api) => {
      const { controller, recorder, launcher, sessions } = api;
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root(), encoding: 'utf8' }).trim();
      const models = await launcher.models('codex', root());
      const model = models.find((m) => m.isDefault && m.compatible) ?? models.find((m) => m.compatible)!;
      const sel = { provider: 'codex' as const, model: model.id, effort: model.efforts?.includes('low') ? 'low' : model.defaultEffort, profile: 'approve-edits', workspaceRoot: root() };
      console.log(`    Codex model: ${model.id} (effort ${sel.effort})`);
      // Approvals: read-only commands and the requested patch to validation.py; everything else declined.
      const { describeCommand } = await import('../../analysis/commandInfo');
      const decided = new Set<string>();
      const sweeper = setInterval(() => {
        for (const id of controller.getSnapshot().pendingApprovals) {
          if (decided.has(id)) continue;
          decided.add(id);
          const op = recorder.getOperation(id)!;
          if (op.command && !describeCommand(op.command.command).writes) controller.approve(id);
          else if (op.operationType === 'Edit' && op.filePath === 'validation.py') controller.approve(id);
          else controller.reject(id, 'Not needed for this test.');
        }
      }, 150);
      const turnDone = async (what: string) => {
        await new Promise((r) => setTimeout(r, 300));
        await waitUntil(() => controller.getSnapshot().awaitingInput || !controller.isActive, what);
      };
      const answer = (taskId: string) => recorder.getTask(taskId)?.messages?.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
      const opsSince = (taskId: string, seq: number) => recorder.getOperations(taskId).filter((o) => o.sequenceNumber > seq);
      const lastSeq = (taskId: string) => recorder.getOperations(taskId).at(-1)?.sequenceNumber ?? 0;
      const prompts = {
        inspect: 'Read validation.py with ONE read-only shell command and tell me in two sentences what validate_samples() checks. Do not modify anything.',
        modify: "Using your apply_patch tool (not a shell command), add the comment line '# checked by visual agent' directly above the def validate_samples line in validation.py. Change nothing else and run no commands.",
        explain: 'In one sentence: why did you put the comment exactly there? Do not run any commands.',
      };
      try {
        // ---- Native: three messages in one conversation.
        const a = (await launcher.start({ ...sel, instructions: prompts.inspect }))!;
        await turnDone('turn 1');
        const thread = recorder.getTask(a)!.session!.id;
        console.log(`    thread ${thread}; turn 1: ${answer(a).slice(0, 120)}`);
        assert.equal(await launcher.send(a, prompts.modify), true);
        await turnDone('turn 2');
        assert.ok(fs.readFileSync(path.join(root(), 'validation.py'), 'utf8').includes('# checked by visual agent'), 'patch applied after approval');
        const seq3 = lastSeq(a);
        assert.equal(await launcher.send(a, prompts.explain), true);
        await turnDone('turn 3');
        console.log(`    turn 3: ${answer(a).slice(0, 160)}`);
        const native = sessions.metrics(a);
        console.log(`    native metrics: ${sessions.describe(a)}`);
        assert.equal(recorder.getTask(a)!.session!.id, thread, 'same native thread for all three turns');
        assert.deepEqual([native.threadsStarted, native.threadsResumed, native.nativeTurns], [1, 0, 2]);
        assert.ok(!opsSince(a, seq3).some((o) => /Codex session started|thread resumed/.test(o.description)), 'no new session for the follow-up');
        const turn3Reads = opsSince(a, seq3).filter((o) => o.operationType === 'Read');
        console.log(`    turn 3 tool steps: ${opsSince(a, seq3).filter((o) => o.command || o.operationType === 'Read').map((o) => o.description).join(' | ') || '(none)'}`);

        // ---- Test C: the user edits validation.py; the next message names it and the agent reads the new version.
        fs.appendFileSync(path.join(root(), 'validation.py'), '# user note: zero concentration is allowed\n');
        const seq4 = lastSeq(a);
        assert.equal(await launcher.send(a, 'What does the very last line of validation.py say now? Quote it.'), true);
        await turnDone('turn 4');
        const instruct4 = recorder.getOperations(a).filter((o) => o.operationType === 'Instruct').at(-1)!;
        assert.match(instruct4.rationale ?? '', /Context update from the editor: .*validation\.py \(modified\)/s, 'the change note was sent');
        console.log(`    turn 4 (after external edit): ${answer(a).slice(0, 160)} | reads: ${opsSince(a, seq4).filter((o) => o.operationType === 'Read').map((o) => o.filePath).join(', ')}`);
        assert.match(answer(a), /zero concentration is allowed/, 'the agent used the current version');

        // ---- Test D: the session ends (as on reload / restart); the next message resumes the SAME thread.
        await controller.endSession();
        await controller.whenIdle();
        assert.equal(await launcher.send(a, 'Without running commands: which function did we add a comment to earlier in this conversation? One word.'), true);
        await turnDone('turn after restart');
        assert.equal(recorder.getTask(a)!.session!.id, thread, 'resumed the same thread');
        assert.equal(recorder.getTask(a)!.session!.continuity, 'resumed');
        console.log(`    after restart (resumed ${thread}): ${answer(a).slice(0, 120)}`);
        assert.match(answer(a), /validate_samples/, 'native context survived the restart');
        await controller.endSession();
        await controller.whenIdle();

        // ---- Test E: a second conversation in the same workspace has its own thread.
        const b = (await launcher.start({ ...sel, instructions: 'Without running any command: do you know of any change we made in this repository? Answer yes or no.' }))!;
        await turnDone('conversation B');
        assert.notEqual(recorder.getTask(b)!.session!.id, thread, 'isolated thread');
        console.log(`    conversation B thread ${recorder.getTask(b)!.session!.id}: ${answer(b).slice(0, 80)}`);
        await controller.endSession();
        await controller.whenIdle();

        // ---- Before: the old path (a new thread per message + the saved-conversation replay) for the same three messages.
        execFileSync('git', ['checkout', '-q', '--', 'validation.py'], { cwd: root() });
        decided.clear();
        const { continuationContext } = await import('../../recorder/conversation');
        const old = (await launcher.start({ ...sel, instructions: prompts.inspect }))!;
        await turnDone('old turn 1');
        for (const msg of [prompts.modify, prompts.explain]) {
          await controller.endSession();
          await controller.whenIdle();
          const task = recorder.getTask(old)!;
          // Exactly what the extension did before this change.
          controller.start(continuationContext(task, recorder.getOperations(old)) + msg, launcher.createAdapter({ ...sel, instructions: msg }, model), root(), { taskId: old, userMessage: msg });
          await turnDone('old follow-up');
        }
        const before = sessions.metrics(old);
        console.log(`    old-path metrics: ${sessions.describe(old)}`);
        const nat = sessions.metrics(a);
        console.log('    COMPARISON (3-message workflow) native vs old:');
        console.log(`      threads started ${native.threadsStarted} vs ${before.threadsStarted}`);
        console.log(`      reads (repeated) ${native.reads} (${native.repeatedReads}) vs ${before.reads} (${before.repeatedReads})`);
        console.log(`      exploration ${native.explorations} vs ${before.explorations}`);
        console.log(`      input tokens ${native.inputTokens} (cached ${native.cachedInputTokens}) vs ${before.inputTokens} (cached ${before.cachedInputTokens}); output ${native.outputTokens} vs ${before.outputTokens}`);
        console.log(`      [native totals incl. turns 4-5: ${nat.inputTokens} in]`);
        void turn3Reads;
        assert.equal(before.threadsStarted, 3, 'the old path started a thread per message');
      } finally {
        clearInterval(sweeper);
        if (controller.isActive) {
          if (controller.getSnapshot().awaitingInput) await controller.endSession();
          else controller.stop();
          await controller.whenIdle();
        }
        execFileSync('git', ['reset', '-q', '--hard', head], { cwd: root() });
        execFileSync('git', ['clean', '-qfd'], { cwd: root() });
      }
    },
  ],
];

const eol = (s: string) => s.replace(/\r\n/g, '\n');

async function ConversationPanelReceive(m: unknown): Promise<void> {
  const { ConversationPanel } = await import('../../ui/ConversationPanel');
  await ConversationPanel.receive(m);
}

/** Capture the Extension Development Host window (PrintWindow) when VAW_SCREENSHOT_DIR is set. */
async function screenshot(name: string): Promise<void> {
  const dir = process.env.VAW_SCREENSHOT_DIR;
  if (!dir || process.platform !== 'win32') return;
  // Bring the conversation panel (approval card + file list) to the front beside the editors.
  await vscode.commands.executeCommand('visualAgent.openConversations');
  await new Promise((r) => setTimeout(r, 1200)); // let the webview render
  const out = path.join(dir, `${name}.png`);
  const title = path.basename(root());
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
public struct R { public int L, T, Ri, B; } }
"@
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | Select-Object -First 1
if (-not $p) { exit 2 }
$r = New-Object W+R; [W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$b = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($b); $dc = $g.GetHdc(); [W]::PrintWindow($p.MainWindowHandle, $dc, 2) | Out-Null; $g.ReleaseHdc($dc)
$b.Save('${out.replace(/'/g, "''")}'); "$($r.Ri - $r.L)x$($r.B - $r.T)"`;
  try {
    const size = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20_000 }).trim();
    console.log(`    screenshot ${out} (${size})`);
  } catch (err) {
    console.log(`    screenshot ${name} failed: ${(err as Error).message.split('\n')[0]}`);
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'visual-agent-workspace');
  assert.ok(ext, 'extension found');
  const api = (await ext.activate()) as VisualAgentApi;
  const suite = process.env.VAW_CODEX_SUITE ?? 'readonly';
  console.log(`  workspace (disposable repo): ${root()}`);
  assert.equal(gitStatus(), '', 'disposable repo starts clean');

  let failed = 0;
  let ran = 0;
  for (const [name, group, fn] of cases) {
    if (suite !== 'all' && suite !== group) {
      continue;
    }
    ran++;
    const t = Date.now();
    try {
      await fn(api);
      console.log(`  ✔ ${name} (${Math.round((Date.now() - t) / 1000)}s)`);
    } catch (err) {
      failed++;
      console.error(`  ✖ ${name}\n    ${err instanceof Error ? err.stack : String(err)}`);
      if (api.controller.isActive) {
        api.controller.stop();
        await api.controller.whenIdle();
      }
      if (group === 'readonly' && gitStatus() !== '') {
        console.error('    !! workspace was modified during a read-only test');
      }
    }
  }
  console.log(`\n${ran - failed}/${ran} real Codex tests passed (suite: ${suite})`);
  if (failed) {
    throw new Error(`${failed} real Codex test(s) failed`);
  }
}
