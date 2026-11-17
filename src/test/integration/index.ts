/**
 * End-to-end tests that run inside a real VS Code Extension Development Host
 * against demo-workspace/. Launched by scripts/run-integration.js.
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { VisualAgentApi } from '../../extension';
import { FakeOllama } from '../support/fakeOllama';
import { FakeOpenCode } from '../support/fakeOpenCode';
import { OpenCodeAdapter } from '../../agents/opencode/OpenCodeAdapter';
import { execFileSync } from 'node:child_process';

type Case = [string, (api: VisualAgentApi) => Promise<void>];

async function waitUntil<T>(probe: () => T | undefined | false, what: string, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) {
      return v;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function root(): string {
  return vscode.workspace.workspaceFolders![0].uri.fsPath;
}

function snapshotFixtures(): Map<string, string> {
  const files = ['importer.py', 'validation.py', 'tests/test_validation.py'];
  return new Map(files.map((f) => [f, fs.readFileSync(path.join(root(), f), 'utf8')]));
}

function activeFile(): string | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  return doc && doc.uri.scheme === 'file' ? path.relative(root(), doc.uri.fsPath).replace(/\\/g, '/') : undefined;
}

function diffTabOpen(): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'visual-agent-change'),
  );
}

const cases: Case[] = [
  [
    'commands are registered',
    async () => {
      const all = await vscode.commands.getCommands(true);
      for (const c of ['startDemo', 'pause', 'resume', 'stop', 'approve', 'reject', 'review', 'revealOperation', 'showSummary']) {
        assert.ok(all.includes(`visualAgent.${c}`), `missing visualAgent.${c}`);
      }
    },
  ],
  [
    'demo: follow navigates, diff shown, approval required, no files modified',
    async ({ controller, recorder }) => {
      const before = snapshotFixtures();
      await vscode.commands.executeCommand('visualAgent.followOn');
      await vscode.commands.executeCommand('visualAgent.startDemo');
      const taskId = controller.getSnapshot().taskId!;

      // Follow Agent opened importer.py while the agent analysed load_data().
      await waitUntil(() => recorder.getOperations(taskId).some((o) => o.functionName === 'load_data' && o.status === 'Completed'), 'load_data analysed');
      const pendingId = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'approval request');
      const pending = recorder.getOperation(pendingId)!;
      assert.equal(pending.operationType, 'Edit');
      assert.equal(pending.status, 'Proposed');

      // The diff of the proposed change was opened, and the controller is blocked.
      await waitUntil(() => diffTabOpen(), 'proposed-change diff tab');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(controller.getSnapshot().awaitingApprovalFor, pendingId, 'still waiting for a decision');
      assert.ok(!recorder.getOperations(taskId).some((o) => o.operationType === 'Test'), 'test step not dispatched before approval');

      // Diff content: proposed side contains the new validation, original is unchanged on disk.
      const diffTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTextDiff)!;
      const input = diffTab.input as vscode.TabInputTextDiff;
      const proposed = (await vscode.workspace.openTextDocument(input.modified)).getText();
      const original = (await vscode.workspace.openTextDocument(input.original)).getText();
      assert.match(proposed, /concentration must be >= 0/);
      assert.match(proposed, /def summarize\(samples\):/);
      assert.equal(original, before.get('validation.py'));

      await vscode.commands.executeCommand('visualAgent.approve');
      await controller.whenIdle();

      const ops = recorder.getOperations(taskId);
      assert.deepEqual(ops.map((o) => o.status), ['Completed', 'Completed', 'Completed', 'Completed', 'Completed', 'Completed', 'Completed']);
      const testOp = ops.find((o) => o.operationType === 'Test')!;
      assert.equal(testOp.command?.simulated, true);
      assert.equal(testOp.command?.exitCode, 0);
      assert.equal(recorder.getTask(taskId)!.status, 'Completed');

      // Safety: no workspace file changed and no editor is dirty.
      assert.deepEqual(snapshotFixtures(), before);
      assert.ok(!vscode.workspace.textDocuments.some((d) => d.isDirty), 'no dirty documents');
    },
  ],
  [
    'clicking an operation opens the file and highlights the function',
    async ({ recorder }) => {
      const op = recorder.getOperations().find((o) => o.functionName === 'load_data')!;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('visualAgent.revealOperation', op.operationId);
      await waitUntil(() => activeFile() === 'importer.py', 'importer.py active');
      const editor = vscode.window.activeTextEditor!;
      assert.equal(editor.selection.active.line, 8, 'cursor at def load_data (line 9)');
      assert.ok(editor.visibleRanges.some((r) => r.contains(new vscode.Position(8, 0))));

      const vs = recorder.getOperations().find((o) => o.functionName === 'validate_samples' && o.operationType === 'Analyze')!;
      await vscode.commands.executeCommand('visualAgent.revealOperation', vs.operationId);
      await waitUntil(() => activeFile() === 'validation.py', 'validation.py active');
      assert.equal(vscode.window.activeTextEditor!.selection.active.line, 9);
    },
  ],
  [
    'follow disabled: new events do not change the editor',
    async ({ controller, recorder }) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('visualAgent.followOff');
      await vscode.commands.executeCommand('visualAgent.startDemo');
      const taskId = controller.getSnapshot().taskId!;
      await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'approval request');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(vscode.window.visibleTextEditors.length, 0, 'no editors opened');
      assert.ok(!diffTabOpen(), 'no diff opened automatically');
      await vscode.commands.executeCommand('visualAgent.stop');
      await controller.whenIdle();
      assert.equal(recorder.getTask(taskId)!.status, 'Stopped');
      assert.equal(recorder.getOperation(recorder.getOperations(taskId)[4].operationId)!.status, 'Cancelled');
      await vscode.commands.executeCommand('visualAgent.followOn');
    },
  ],
  [
    'pause holds the queue, resume continues, stop cancels the rest',
    async ({ controller, recorder }) => {
      await vscode.workspace.getConfiguration('visualAgent').update('stepDelayMs', 150, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('visualAgent.startDemo');
      const taskId = controller.getSnapshot().taskId!;
      await vscode.commands.executeCommand('visualAgent.pause');
      await new Promise((r) => setTimeout(r, 1500));
      const n = recorder.getOperations(taskId).length;
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(recorder.getOperations(taskId).length, n, 'no new operations while paused');
      assert.ok(n <= 1);
      await vscode.commands.executeCommand('visualAgent.resume');
      await waitUntil(() => recorder.getOperations(taskId).length > n + 1, 'progress after resume');
      await vscode.commands.executeCommand('visualAgent.stop');
      await controller.whenIdle();
      const ops = recorder.getOperations(taskId);
      assert.equal(recorder.getTask(taskId)!.status, 'Stopped');
      assert.ok(!ops.some((o) => o.operationType === 'Test'), 'remaining operations never ran');
      assert.equal(ops.at(-1)!.operationType, 'Summary');
      await vscode.workspace.getConfiguration('visualAgent').update('stepDelayMs', 0, vscode.ConfigurationTarget.Global);
    },
  ],
  [
    'sidebar view resolves; summary and command output documents render',
    async ({ recorder }) => {
      await vscode.commands.executeCommand('workbench.view.extension.visualAgent');
      await vscode.commands.executeCommand('visualAgent.activity.focus');
      const testOp = recorder.getOperations().find((o) => o.operationType === 'Test' && o.command?.exitCode === 0)!;
      await vscode.commands.executeCommand('visualAgent.showCommandOutput', testOp.operationId);
      await waitUntil(() => vscode.window.activeTextEditor?.document.uri.scheme === 'visual-agent-record', 'command doc');
      const cmdText = vscode.window.activeTextEditor!.document.getText();
      assert.match(cmdText, /SIMULATED COMMAND/);
      assert.match(cmdText, /python -m pytest tests\/test_validation\.py -v/);
      assert.match(cmdText, /Exit code:\s+0/);

      await vscode.commands.executeCommand('visualAgent.review', testOp.operationId);
      await waitUntil(() => /Audit trail/.test(vscode.window.activeTextEditor?.document.getText() ?? ''), 'operation details doc');

      const task = recorder.getTask(testOp.taskId)!;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // showSummary uses the selected task; select it via the reveal path first.
      await vscode.commands.executeCommand('visualAgent.revealOperation', testOp.operationId);
      await vscode.commands.executeCommand('visualAgent.showSummary');
      await waitUntil(() => /Task summary/.test(vscode.window.activeTextEditor?.document.getText() ?? ''), 'summary doc');
      const summary = vscode.window.activeTextEditor!.document.getText();
      assert.equal(summary, task.summary);
      assert.match(summary, /validate_samples\(\)`: \*\*Approved\*\*/);
    },
  ],
  [
    'missing file and outside-workspace paths fail gracefully',
    async ({ recorder }) => {
      // Inject synthetic history entries and navigate to them.
      const t = recorder.startTask({ description: 'nav edge cases', source: 'mock', adapterName: 'test', simulated: true });
      const missing = recorder.recordOperation(t.taskId, { source: 'mock', simulated: true, requiresApproval: false, operationType: 'Read', description: 'x', filePath: 'nope.py' });
      const outside = recorder.recordOperation(t.taskId, { source: 'mock', simulated: true, requiresApproval: false, operationType: 'Read', description: 'y', filePath: '../package.json' });
      const noFn = recorder.recordOperation(t.taskId, { source: 'mock', simulated: true, requiresApproval: false, operationType: 'Read', description: 'z', filePath: 'importer.py', functionName: 'not_a_function', lineNumber: 3 });
      recorder.finishTask(t.taskId, 'Completed');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('visualAgent.revealOperation', missing.operationId);
      await vscode.commands.executeCommand('visualAgent.revealOperation', outside.operationId);
      assert.equal(vscode.window.visibleTextEditors.length, 0, 'nothing opened for missing/outside paths');
      await vscode.commands.executeCommand('visualAgent.revealOperation', noFn.operationId);
      await waitUntil(() => activeFile() === 'importer.py', 'fallback open');
      assert.equal(vscode.window.activeTextEditor!.selection.active.line, 2, 'line-number fallback');
    },
  ],
];


// ------------------------------------------------------- v0.3 additions

async function setReviewer(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration('visualAgent.reviewer').update(key, value, vscode.ConfigurationTarget.Global);
}

async function cursorIn(file: string, line0: number): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(path.join(root(), file));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(line0, 4, line0, 4);
  return editor;
}

let fakeOllama: FakeOllama | undefined;

const v03Cases: Case[] = [
  [
    'reviewer: explain function with a local model (fake Ollama); read-only; shown beside the code',
    async ({ reviewer, reviewerController }) => {
      fakeOllama = new FakeOllama();
      await setReviewer('endpoint', await fakeOllama.start());
      await setReviewer('enabled', true);
      await reviewer.refreshModels();
      assert.equal(reviewer.getState().connection, 'connected');
      assert.equal(reviewer.getState().selectedModel, 'qwen3:8b');
      const before = snapshotFixtures();
      const editor = await cursorIn('validation.py', 12);
      const result = await reviewerController.explainFunction();
      assert.equal(result?.status, 'done');
      assert.equal(result?.text, 'The function validates samples.');
      const sent = fakeOllama.chatRequests.at(-1).messages[1].content as string;
      assert.match(sent, /10 \| def validate_samples\(samples\):/);
      assert.doesNotMatch(sent, /def summarize/, 'minimal context: only the selected function (+ imports)');
      await waitUntil(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === 'visual-agent-review')), 'result document beside the code');
      assert.equal(editor.document.isDirty, false);
      assert.deepEqual(snapshotFixtures(), before, 'reviewer never modifies files');
    },
  ],
  [
    'reviewer: review the recorded change of the demo Edit operation',
    async ({ recorder, reviewerController }) => {
      const edit = recorder.getOperations().filter((o) => o.operationType === 'Edit' && o.associatedChangeId).at(-1)!;
      const r = await reviewerController.reviewChange(edit.operationId);
      assert.equal(r?.status, 'done');
      const sent = fakeOllama!.chatRequests.at(-1).messages[1].content as string;
      assert.match(sent, /```diff/);
      assert.match(sent, /concentration must be >= 0/, 'modified code included');
      assert.match(sent, /Original code/);
      assert.match(sent, /operation #5/);
    },
  ],
  [
    'reviewer: cancel an active request',
    async ({ reviewer }) => {
      fakeOllama!.tokens = Array.from({ length: 300 }, (_, i) => `tok${i} `);
      fakeOllama!.chunkDelayMs = 20;
      await cursorIn('importer.py', 11);
      const pending = vscode.commands.executeCommand('visualAgent.reviewer.explainFunction') as Thenable<unknown>;
      await waitUntil(() => reviewer.getState().busy && !!reviewer.getState().current?.text, 'streaming started', 10_000);
      await vscode.commands.executeCommand('visualAgent.reviewer.cancel');
      await pending;
      assert.equal(reviewer.getState().current?.status, 'cancelled');
      assert.equal(reviewer.getState().busy, false);
      fakeOllama!.tokens = ['ok'];
      fakeOllama!.chunkDelayMs = 0;
    },
  ],
  [
    'export: function at cursor contains the exact source and recorded change evidence',
    async ({ exporter }) => {
      await cursorIn('validation.py', 12);
      const md = await exporter.build('function', {});
      const src = fs.readFileSync(path.join(root(), 'validation.py'), 'utf8').split(/\r?\n/).slice(9, 17).join('\n');
      assert.ok(md.includes(src), 'exported code equals the file on disk');
      assert.match(md, /## Code changes/);
      assert.match(md, /\[verified: file snapshot taken when the change was proposed\]/);
      assert.match(md, /tests\/test_validation\.py:\d+/, 'related call sites (inferred)');
      assert.doesNotMatch(md, /The function validates samples/, 'no model output in exports');
    },
  ],
  [
    'changed-line navigation and affected-function navigation for an applied patch',
    async ({ recorder, controls }) => {
      const t = recorder.startTask({ description: 'nav', source: 'codex', adapterName: 'Codex (test)', simulated: false });
      const op = recorder.recordOperation(t.taskId, {
        source: 'codex',
        simulated: false,
        requiresApproval: true,
        enforcement: 'agent-approval',
        operationType: 'Edit',
        description: 'Edit validation.py › summarize()',
        filePath: 'validation.py',
        lineNumber: 22,
        changedRanges: [{ filePath: 'validation.py', side: 'new', startLine: 22, endLine: 23 }],
        affectedFunctions: [{ filePath: 'validation.py', name: 'summarize', kind: 'function', startLine: 20, endLine: 26, side: 'new', source: 'parser' }],
      });
      recorder.updateOperation(op.operationId, { status: 'Running' });
      recorder.updateOperation(op.operationId, { status: 'Completed' });
      recorder.finishTask(t.taskId, 'Completed');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.commands.executeCommand('visualAgent.revealOperation', op.operationId);
      await waitUntil(() => activeFile() === 'validation.py', 'file opened');
      assert.equal(vscode.window.activeTextEditor!.selection.active.line, 21, 'cursor on the first changed line');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await controls.gotoAffectedFunction(op.operationId, 0);
      await waitUntil(() => activeFile() === 'validation.py', 'function opened');
      assert.equal(vscode.window.activeTextEditor!.selection.active.line, 19, 'cursor on def summarize');
    },
  ],
  [
    'Ollama offline: reviewer shows unavailable; tracking and the demo keep working',
    async ({ reviewer, controller, recorder }) => {
      await fakeOllama!.stop();
      await reviewer.refreshModels();
      assert.equal(reviewer.getState().connection, 'unavailable');
      assert.match(reviewer.getState().error!, /Cannot reach Ollama/);
      await vscode.commands.executeCommand('visualAgent.startDemo');
      const taskId = controller.getSnapshot().taskId!;
      const id = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'approval');
      controller.approve(id);
      await controller.whenIdle();
      assert.equal(recorder.getTask(taskId)!.status, 'Completed');
    },
  ],
  [
    'reviewer disabled: commands make no requests',
    async ({ reviewer }) => {
      await setReviewer('enabled', false);
      const probe = new FakeOllama();
      await setReviewer('endpoint', await probe.start());
      await cursorIn('validation.py', 12);
      await vscode.commands.executeCommand('visualAgent.reviewer.explainFunction');
      await reviewer.refreshModels();
      assert.equal(reviewer.getState().connection, 'disabled');
      assert.deepEqual(probe.requests, []);
      await probe.stop();
      await setReviewer('enabled', true);
    },
  ],
];


// ------------------------------------------------- language support (中文 / English)

const i18nCases: Case[] = [
  [
    'language: defaults to 中文, switches UI strings, persists as a user setting',
    async ({ controls }) => {
      const cfg = () => vscode.workspace.getConfiguration('visualAgent');
      assert.equal(cfg().inspect('language')?.defaultValue, 'zh-CN');
      assert.equal(controls.language(), 'zh-CN');
      assert.equal(controls.getViewModel().strings['a.timeline'], '时间线');
      await controls.setLanguage('en');
      assert.equal(cfg().inspect('language')?.globalValue, 'en', 'stored in user settings (survives restarts)');
      assert.equal(controls.getViewModel().strings['a.timeline'], 'Timeline');
      assert.equal(controls.getViewModel().header.statusLabel, 'Completed');
      await controls.setLanguage('bilingual');
      assert.equal(controls.getViewModel().strings['a.timeline'], '时间线 / Timeline');
      await controls.setLanguage('zh-CN');
      assert.equal(controls.getViewModel().header.statusLabel, '已完成');
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes('visualAgent.selectLanguage') && cmds.includes('visualAgent.reviewer.translateResult'));
      // Re-render both panels in Chinese without errors.
      await vscode.commands.executeCommand('visualAgent.activity.focus');
      await vscode.commands.executeCommand('visualAgent.reviewer.focus');
    },
  ],
  [
    'reviewer: Chinese explanation requested directly in Chinese; English after switching',
    async ({ reviewer, reviewerController, controls }) => {
      fakeOllama = new FakeOllama();
      await setReviewer('endpoint', await fakeOllama.start());
      await reviewer.refreshModels();
      reviewer.clearCache(); // the earlier v0.3 explain test already ran in 中文 (the default)
      await cursorIn('validation.py', 12);
      fakeOllama.tokens = ['`validate_samples` 检查每个样本的 `sample_id`。'];
      const zh = await reviewerController.explainFunction();
      assert.equal(zh?.language, 'zh-CN');
      assert.match(fakeOllama.chatRequests.at(-1).messages[0].content, /directly in Simplified Chinese \(简体中文\)/);
      await controls.setLanguage('en');
      fakeOllama.tokens = ['`validate_samples` checks each sample for `sample_id`.'];
      const en = await reviewerController.explainFunction();
      assert.equal(en?.language, 'en');
      assert.equal(en?.cached, false, 'different language → new review');
      assert.match(fakeOllama.chatRequests.at(-1).messages[0].content, /Write the answer in English/);
    },
  ],
  [
    'reviewer: translate an English result to Chinese, then switch versions without requests',
    async ({ reviewer }) => {
      const r = reviewer.getState().current!;
      assert.equal(r.language, 'en');
      fakeOllama!.tokens = ['`validate_samples` 检查每个样本是否有 `sample_id`。'];
      await vscode.commands.executeCommand('visualAgent.reviewer.translateResult', r.id, 'zh-CN');
      const after = reviewer.getState().history.find((h) => h.id === r.id)!;
      assert.equal(after.translations['zh-CN']?.status, 'done');
      assert.equal(after.translations['zh-CN']?.codeSpansPreserved, true);
      assert.equal(after.text, '`validate_samples` checks each sample for `sample_id`.', 'original preserved');
      const n = fakeOllama!.chatRequests.length;
      assert.ok(reviewer.showVersion(r.id, 'original'));
      assert.ok(reviewer.showVersion(r.id, 'zh-CN'));
      assert.ok(reviewer.showVersion(r.id, 'bilingual'));
      await vscode.commands.executeCommand('visualAgent.reviewer.translateResult', r.id, 'zh-CN');
      assert.equal(fakeOllama!.chatRequests.length, n, 'cached versions: no new model requests');
      // Export/copy rendering shows the translation and keeps the original.
      await vscode.commands.executeCommand('visualAgent.reviewer.openResult', r.id);
      reviewer.showVersion(r.id, 'zh-CN');
      await waitUntil(() => /Original \(English\)/.test(vscode.window.activeTextEditor?.document.getText() ?? ''), 'translated result document', 10_000);
      await fakeOllama!.stop();
      const controls = (await vscode.extensions.all.find((e) => e.packageJSON?.name === 'visual-agent-workspace')!.activate()).controls;
      await controls.setLanguage('zh-CN');
    },
  ],
];


// ------------------------------------------------- v0.4: unified agent selection

const v04Cases: Case[] = [
  [
    'selected project opens as a real Explorer root without replacing the original folder or starting inference',
    async ({ launcher, controller, recorder, controls }) => {
      const initial = vscode.workspace.workspaceFolders![0].uri.fsPath;
      const project = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-explorer-project-'));
      const file = path.join(project, 'visible.js');
      fs.writeFileSync(file, 'module.exports = 42;\n');
      const beforeOperations = recorder.getOperations().length;
      assert.equal(await launcher.showProject(project), true);
      await waitUntil(() => vscode.workspace.workspaceFolders?.some((f) => path.relative(f.uri.fsPath, project) === ''), 'selected folder in VS Code Explorer roots');
      assert.equal(vscode.workspace.workspaceFolders![0].uri.fsPath, initial, 'original root is preserved so the development host does not restart');
      const count = vscode.workspace.workspaceFolders!.length;
      await launcher.showProject(project);
      assert.equal(vscode.workspace.workspaceFolders!.length, count, 'showing a project twice never duplicates its root');
      assert.equal(path.relative(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))!.uri.fsPath, project), '');
      const task = recorder.startTask({ description: 'Explorer project history', source: 'local', adapterName: 'Local agent', simulated: false, workspaceRoot: project });
      recorder.finishTask(task.taskId, 'Completed');
      controls.selectTask(task.taskId);
      await vscode.commands.executeCommand('visualAgent.openConversations', task.taskId);
      assert.equal(recorder.getOperations().length, beforeOperations);
      assert.equal(controller.isActive, false);
      await assert.rejects(launcher.showProject(path.join(project, 'missing')), /not found|ENOENT|Unable to resolve/i);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'conversation workspace: explain, approved edit and real test, follow-up, close and native resume',
    async ({ launcher, recorder, controller, controls }) => {
      const project = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-conversation-ui-'));
      const math = 'function divide(a, b) { return a / b; }\nmodule.exports = { divide };\n';
      const changed = 'function divide(a, b) { if (b === 0) throw new Error("division by zero"); return a / b; }\nmodule.exports = { divide };\n';
      fs.writeFileSync(path.join(project, 'math.js'), math);
      fs.writeFileSync(path.join(project, 'test.js'), 'const assert = require("node:assert/strict"); const {divide} = require("./math"); assert.throws(() => divide(1,0), /division by zero/); console.log("passed");');
      const fake = new FakeOpenCode(); fake.directory = project;
      fake.turns = [
        async (s) => { s.assistant(); s.text('explain', 'divide returns a / b.'); s.idle(); },
        async (s) => {
          s.assistant('edit-message');
          s.tool('edit', 'edit', 'running', { filePath: path.join(project, 'math.js'), oldString: math, newString: changed });
          assert.equal(await s.permission('edit-perm', 'edit', 'edit', { filepath: path.join(project, 'math.js') }), 'once');
          fs.writeFileSync(path.join(project, 'math.js'), changed);
          s.tool('edit', 'edit', 'completed', { filePath: path.join(project, 'math.js'), oldString: math, newString: changed });
          s.tool('test', 'bash', 'running', { command: 'node test.js' });
          assert.equal(await s.permission('test-perm', 'bash', 'test', { command: 'node test.js' }), 'once');
          const output = execFileSync(process.execPath, ['test.js'], { cwd: project, encoding: 'utf8', windowsHide: true });
          s.tool('test', 'bash', 'completed', { command: 'node test.js' }, { output, metadata: { exit: 0 } });
          s.text('done-edit', 'Guard added and tests passed.', 'edit-message'); s.idle();
        },
        async (s) => { s.assistant('follow-up'); s.text('answer-followup', 'The guard rejects a zero divisor.', 'follow-up'); s.idle(); },
      ];
      const originalModels = launcher.models;
      const originalCreate = launcher.createAdapter;
      const restored = new FakeOpenCode(); restored.directory = project;
      restored.turns = [async (s) => { s.assistant(); s.text('restored-answer', 'We added a zero-divisor guard.'); s.idle(); }];
      launcher.models = async () => [{ id: 'qwen3:8b', label: 'qwen3:8b', compatible: true }];
      launcher.createAdapter = (selection, _model, resumeSessionId) => new OpenCodeAdapter({ resumeSessionId, connector: async () => resumeSessionId ? restored : fake, launch: { executable: 'fixture', homeDir: project, ollamaBaseUrl: 'http://127.0.0.1:1', model: selection.model, contextLimit: 8192, outputLimit: 2048, profile: 'approved-write' } });
      try {
        const id = (await launcher.start({ provider: 'local', model: 'qwen3:8b', profile: 'approved-write', workspaceRoot: project, instructions: 'Explain divide' }))!;
        controls.selectTask(id);
        await vscode.commands.executeCommand('visualAgent.openConversations', id);
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'first conversation turn');
        assert.equal(controls.getViewModel().header.statusKind, 'idle');
        assert.ok(vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && /conversations/i.test(t.input.viewType))));
        assert.equal(recorder.getTask(id)!.turns![0].status, 'Completed');
        await launcher.send(id, 'Add a zero-divisor guard and run tests.');
        const edit = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'edit approval');
        assert.equal(fs.readFileSync(path.join(project, 'math.js'), 'utf8'), math);
        assert.ok(recorder.getOperation(edit)!.associatedChangeId);
        controller.approve(edit);
        const command = await waitUntil(() => { const pending = controller.getSnapshot().awaitingApprovalFor; return pending && pending !== edit ? pending : undefined; }, 'test approval');
        controller.approve(command);
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'edit/test turn complete');
        assert.match(recorder.getTask(id)!.turns![1].report!, /exit 0/);
        assert.match(execFileSync(process.execPath, ['test.js'], { cwd: project, encoding: 'utf8', windowsHide: true }), /passed/);
        const document = await vscode.workspace.openTextDocument(path.join(project, 'math.js'));
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand('visualAgent.explainInConversation', id);
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'same-model function explanation');
        assert.equal(fake.requests.filter((r) => r.route.endsWith('/prompt_async')).length, 3);
        await controller.endSession(); await controller.whenIdle();
        const count = recorder.getTasks().length;
        await launcher.send(id, 'What did we change?');
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'native session restored');
        assert.equal(recorder.getTasks().length, count);
        assert.equal(recorder.getTask(id)!.turns!.length, 4);
        assert.ok(restored.requests.some((r) => r.method === 'GET' && r.route === `/session/${fake.sessionId}`));
        assert.equal(restored.requests.filter((r) => r.method === 'POST' && r.route === '/session').length, 0);
        const second = new FakeOpenCode(); second.directory = project; second.sessionId = 'ses_second';
        second.turns = [async (s) => { s.assistant(); s.text('second-answer', 'This is the second conversation.'); s.idle(); }];
        const restoredAgain = new FakeOpenCode(); restoredAgain.directory = project;
        restoredAgain.turns = [async (s) => { s.assistant(); s.text('again-answer', 'Back in the first conversation.'); s.idle(); }];
        launcher.createAdapter = (selection, _model, resumeSessionId) => new OpenCodeAdapter({ resumeSessionId, connector: async () => resumeSessionId ? restoredAgain : second, launch: { executable: 'fixture', homeDir: project, ollamaBaseUrl: 'http://127.0.0.1:1', model: selection.model, contextLimit: 8192, outputLimit: 2048, profile: 'approved-write' } });
        const secondId = (await launcher.start({ provider: 'local', model: 'qwen3:8b', profile: 'approved-write', workspaceRoot: project, instructions: 'Second conversation' }))!;
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'second conversation idle');
        assert.equal(recorder.getTask(id)!.status, 'Completed', 'new conversation closes the previous idle runtime');
        await launcher.send(id, 'Return to the first conversation');
        await waitUntil(() => controller.getSnapshot().taskId === id && controller.getSnapshot().awaitingInput, 'switch back to first session');
        assert.equal(recorder.getTask(secondId)!.status, 'Completed');
        assert.equal(recorder.getTask(id)!.turns!.length, 5);
        await controller.endSession(); await controller.whenIdle();
      } finally {
        if (controller.isActive) { controller.stop(); await controller.whenIdle(); }
        launcher.models = originalModels; launcher.createAdapter = originalCreate;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (!process.env.VAW_TEST_TEMP_DIR) fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  ],
  [
    'project navigation: identical relative filenames open in each recorded task root',
    async ({ recorder, controls }) => {
      const temporary = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-project-navigation-'));
      try {
        const entries = ['A', 'B'].map((name) => {
          const project = path.join(temporary, name);
          fs.mkdirSync(project);
          fs.writeFileSync(path.join(project, 'same.js'), `// project ${name}\n`);
          const task = recorder.startTask({ description: name, source: 'local', adapterName: 'Local agent', simulated: false, workspaceRoot: project });
          const op = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, operationType: 'Read', description: 'Read same.js', filePath: 'same.js', requiresApproval: false });
          recorder.finishTask(task.taskId, 'Completed');
          return { project, op };
        });
        for (const { project, op } of [entries[1], entries[0], entries[1]]) {
          controls.selectOperation(op.operationId, { reveal: true });
          await waitUntil(() => {
            const file = vscode.window.activeTextEditor?.document.uri.fsPath;
            return !!file && path.relative(project, file) === 'same.js';
          }, `navigation to ${project}`);
          assert.equal(controls.getViewModel().header.workspaceRoot, project);
        }
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (!process.env.VAW_TEST_TEMP_DIR) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  ],
  [
    'conversation: saved messages render separately and history can seed a new task without inference',
    async ({ recorder, controls, controller }) => {
      assert.equal(controller.isActive, false);
      const task = recorder.startTask({ description: 'Explain divide', source: 'local', adapterName: 'Local agent', simulated: false });
      recorder.recordMessage(task.taskId, 'user', 'Explain divide');
      recorder.recordMessage(task.taskId, 'assistant', 'It divides two numbers.');
      recorder.setLaunch(task.taskId, { provider: 'local', model: 'qwen3:8b', profile: 'read-only', workspaceRoot: root() });
      recorder.finishTask(task.taskId, 'Completed');
      controls.selectTask(task.taskId);
      assert.equal(controls.getViewModel().conversation.length, 2);
      await vscode.commands.executeCommand('visualAgent.showConversation');
      await waitUntil(() => /It divides two numbers/.test(vscode.window.activeTextEditor?.document.getText() ?? ''), 'saved conversation document');
      await vscode.commands.executeCommand('visualAgent.continueHistory', task.taskId);
      await waitUntil(() => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && /newTask/i.test(t.input.viewType))), 'continuation task panel');
      assert.equal(controller.isActive, false, 'opening history never starts inference');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'New Agent Task: panel opens; providers report real availability; Codex entry routes to it',
    async ({ launcher }) => {
      await vscode.commands.executeCommand('visualAgent.newAgentTask');
      await waitUntil(
        () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && /newTask/i.test((t.input as vscode.TabInputWebview).viewType))),
        'New Agent Task panel',
        10_000,
      );
      const providers = await launcher.providers();
      assert.deepEqual(providers.map((p) => p.id), ['codex', 'claude-code', 'local']);
      const claude = providers.find((p) => p.id === 'claude-code')!;
      assert.equal(claude.experimental, true);
      if (claude.available) assert.match(claude.auth!, /subscription|API billing|Bedrock|Vertex|Foundry/);
      else assert.ok(claude.reason, 'missing auth has a clear sign-in reason');
      for (const p of providers) {
        assert.ok(p.available || p.reason, `${p.id}: unavailable providers must say why`);
        assert.ok(p.profiles.length >= 2);
        assert.ok(p.profiles.some((x) => !x.writes), `${p.id}: has a read-only profile`);
      }
      await vscode.commands.executeCommand('visualAgent.startCodex'); // now opens the same panel
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes('visualAgent.endSession'));
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    },
  ],
  [
    'launcher refuses unknown or incompatible models instead of substituting',
    async ({ launcher }) => {
      const providers = await launcher.providers();
      const local = providers.find((p) => p.id === 'local')!;
      if (!local.available) {
        console.log(`    (local provider unavailable here: ${local.reason}; skipped)`);
        return;
      }
      await assert.rejects(
        launcher.start({ provider: 'local', model: 'definitely-not-installed:1b', profile: 'read-only', workspaceRoot: root(), instructions: 'x' }),
        /not reported by the provider; it will not be substituted/,
      );
      const models = await launcher.models('local', root());
      const bad = models.find((m) => !m.compatible);
      if (bad) {
        await assert.rejects(launcher.start({ provider: 'local', model: bad.id, profile: 'read-only', workspaceRoot: root(), instructions: 'x' }), /cannot run the coding agent/);
      }
    },
  ],
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'visual-agent-workspace');
  assert.ok(ext, 'extension found');
  const api = (await ext.activate()) as VisualAgentApi;
  await vscode.workspace.getConfiguration('visualAgent').update('stepDelayMs', 0, vscode.ConfigurationTarget.Global);

  let failed = 0;
  for (const [name, fn] of [...cases, ...v03Cases, ...i18nCases, ...v04Cases]) {
    try {
      await fn(api);
      console.log(`  ✔ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✖ ${name}\n    ${err instanceof Error ? err.stack : String(err)}`);
      if (api.controller.isActive) {
        api.controller.stop();
        await api.controller.whenIdle();
      }
    }
  }
  const total = cases.length + v03Cases.length + i18nCases.length + v04Cases.length;
  console.log(`\n${total - failed}/${total} integration tests passed`);
  if (failed) {
    throw new Error(`${failed} integration test(s) failed`);
  }
}
