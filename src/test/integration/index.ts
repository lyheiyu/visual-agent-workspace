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
import { ConversationPanel } from '../../ui/ConversationPanel';
import { ExplainPanel } from '../../reviewer/ExplainPanel';
import { ManualChanges } from '../../review/ManualChanges';
import { isInside } from '../../navigation/pathSafety';
import { MultiFileAgent } from '../support/multiFileAgent';
import { commandItem, FakeCodexServer } from '../support/fakeCodex';
import { CodexAppServerAdapter } from '../../adapters/codex/CodexAppServerAdapter';
import { CodexRpcClient } from '../../adapters/codex/CodexRpcClient';
import { getProfile } from '../../adapters/codex/profiles';

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
      assert.equal(input.modified.query, 'proposal');
      const historyUri = input.modified.with({ query: '' });
      await vscode.commands.executeCommand('vscode.diff', input.original, historyUri, 'Historical comparison', { preview: false });

      await vscode.commands.executeCommand('visualAgent.approve');
      await controller.whenIdle();
      const diffIsOpen = (uri: vscode.Uri) => vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === uri.toString()));
      await waitUntil(() => !diffIsOpen(input.modified), 'resolved proposal diff closed');
      assert.ok(diffIsOpen(historyUri), 'historical comparison stays open');
      assert.equal((await vscode.workspace.openTextDocument(historyUri)).getText(), proposed);
      const historyTab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) =>
        tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === historyUri.toString());
      if (historyTab) await vscode.window.tabGroups.close(historyTab, true);

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
      const pendingId = controller.getSnapshot().awaitingApprovalFor!;
      await vscode.commands.executeCommand('visualAgent.approve');
      assert.ok(diffTabOpen(), 'approval first opens the diff even with follow disabled');
      assert.equal(controller.getSnapshot().awaitingApprovalFor, pendingId, 'opening the diff does not approve or write');
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
      const fake = fakeOllama!;
      const previous = fake.respond;
      fake.respond = (request) => {
        const sent = request.messages[1].content as string;
        const line = /^\s*(\d+) \| .*concentration must be >= 0/m.exec(sent)?.[1];
        const finding = { file: 1, side: 'after', line: Number(line), quote: 'concentration must be >= 0', status: 'change', message: 'Validates the concentration.' };
        return [JSON.stringify([finding, finding, { ...finding, side: 'before', message: 'Reversed evidence.' }])];
      };
      try {
        const r = await reviewerController.reviewChange(edit.operationId);
        assert.equal(r?.status, 'done');
        assert.equal(r?.text.match(/Validates the concentration/g)?.length, 1);
        assert.doesNotMatch(r!.text, /Reversed evidence/);
        const sent = fake.chatRequests.at(-1).messages[1].content as string;
        assert.match(sent, /after function[\s\S]*concentration must be >= 0[\s\S]*before function/);
        assert.match(sent, /operation #5/);
      } finally {
        fake.respond = previous;
      }
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
    async ({ launcher, recorder, controller, controls, reviewer }) => {
      const project = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-conversation-ui-'));
      const ollama = new FakeOllama();
      const previousEndpoint = vscode.workspace.getConfiguration('visualAgent.reviewer').get<string>('endpoint');
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
      ];
      const originalModels = launcher.models;
      const originalCreate = launcher.createAdapter;
      const restored = new FakeOpenCode(); restored.directory = project;
      restored.turns = [async (s) => { s.assistant(); s.text('restored-answer', 'We added a zero-divisor guard.'); s.idle(); }];
      launcher.models = async () => [{ id: 'qwen3:8b', label: 'qwen3:8b', compatible: true }];
      launcher.createAdapter = (selection, _model, resumeSessionId) => new OpenCodeAdapter({ resumeSessionId, connector: async () => resumeSessionId ? restored : fake, launch: { executable: 'fixture', homeDir: project, ollamaBaseUrl: 'http://127.0.0.1:1', model: selection.model, contextLimit: 8192, outputLimit: 2048, profile: 'approved-write' } });
      try {
        await setReviewer('endpoint', await ollama.start());
        await reviewer.refreshModels();
        const id = (await launcher.start({ provider: 'local', model: 'qwen3:8b', profile: 'approved-write', workspaceRoot: project, instructions: 'Explain divide' }))!;
        controls.selectTask(id);
        await vscode.commands.executeCommand('visualAgent.openConversations', id);
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'first conversation turn');
        assert.equal(controls.getViewModel().header.statusKind, 'idle');
        assert.ok(vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && /conversations/i.test(t.input.viewType))));
        assert.equal(recorder.getTask(id)!.turns![0].status, 'Completed');
        await ConversationPanel.receive({ type: 'send', taskId: id, text: 'Add a zero-divisor guard and run tests.', attachments: [{ name: 'requirements.md', data: Buffer.from('Reject zero divisors; preserve exports.').toString('base64') }] });
        assert.match(fake.requests.filter((r) => r.route.endsWith('/prompt_async'))[1].body.parts[0].text, /Reject zero divisors; preserve exports/);
        const edit = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'edit approval');
        assert.equal(fs.readFileSync(path.join(project, 'math.js'), 'utf8'), math);
        const changeId = recorder.getOperation(edit)!.associatedChangeId;
        assert.ok(changeId);
        const proposedUri = vscode.Uri.from({ scheme: 'visual-agent-change', path: `/${changeId}/proposed/math.js` });
        const proposed = await vscode.workspace.openTextDocument(proposedUri);
        assert.equal(proposed.getText(), changed, 'the recorded proposal retains the complete modified snapshot');
        controller.approve(edit);
        const command = await waitUntil(() => { const pending = controller.getSnapshot().awaitingApprovalFor; return pending && pending !== edit ? pending : undefined; }, 'test approval');
        controller.approve(command);
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'edit/test turn complete');
        assert.match(recorder.getTask(id)!.turns![1].report!, /exit 0/);
        assert.match(execFileSync(process.execPath, ['test.js'], { cwd: project, encoding: 'utf8', windowsHide: true }), /passed/);
        const document = await vscode.workspace.openTextDocument(path.join(project, 'math.js'));
        await vscode.window.showTextDocument(document);
        assert.equal(ollama.chatRequests.length, 0, 'no automatic local model requests');
        await ConversationPanel.receive({ type: 'explain' });
        assert.equal(reviewer.getState().current?.kind, 'explain');
        assert.equal(ollama.chatRequests.length, 1);
        assert.match(ollama.chatRequests[0].messages[1].content, /divide/);
        await ConversationPanel.receive({ type: 'explain' });
        assert.equal(ollama.chatRequests.length, 1, 'repeat explanation uses the cache');
        ollama.respond = (request) => {
          const line = /^\+\s+(\d+) \| .*throw new Error/m.exec(request.messages[1].content)?.[1];
          return [JSON.stringify([{ file: 1, status: 'change', side: 'after', line: Number(line), quote: 'throw new Error', message: 'Rejects zero divisors.' }])];
        };
        const explainDiff = { type: 'localOperation', action: 'explainDiff', operationId: edit };
        await ConversationPanel.receive(explainDiff);
        assert.equal(ollama.chatRequests.length, 2);
        assert.match(ollama.chatRequests[1].messages[1].content, /Recorded intent: Add a zero-divisor guard/);
        // Explain Diff sends the diff hunk (removed and added line with their numbers), not both file versions.
        assert.match(ollama.chatRequests[1].messages[1].content, /^\+ +1 \| function divide\(a, b\) \{ if \(b === 0\) throw new Error/m);
        assert.match(ollama.chatRequests[1].messages[1].content, /^- 1 +\| function divide\(a, b\) \{ return a \/ b; \}$/m);
        assert.equal(ollama.chatRequests[1].options.num_predict > 0, true, 'the answer length is capped');
        assert.match(reviewer.getState().current!.text, /Rejects zero divisors/);
        await ConversationPanel.receive(explainDiff);
        assert.equal(ollama.chatRequests.length, 2, 'repeat diff explanation uses the cache');
        assert.equal(fake.requests.filter((r) => r.route.endsWith('/prompt_async')).length, 2, 'no extra agent turn');
        await controller.endSession(); await controller.whenIdle();
        const count = recorder.getTasks().length;
        await launcher.send(id, 'What did we change?');
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'native session restored');
        assert.equal(recorder.getTasks().length, count);
        assert.equal(recorder.getTask(id)!.turns!.length, 3);
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
        assert.equal(recorder.getTask(id)!.turns!.length, 4);
        await controller.endSession(); await controller.whenIdle();
      } finally {
        if (controller.isActive) { controller.stop(); await controller.whenIdle(); }
        launcher.models = originalModels; launcher.createAdapter = originalCreate;
        await setReviewer('endpoint', previousEndpoint);
        await ollama.stop();
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
          try {
            await waitUntil(() => {
              const file = vscode.window.activeTextEditor?.document.uri.fsPath;
              return !!file && path.relative(project, file) === 'same.js';
            }, `navigation to ${project}`);
          } catch (error) {
            console.error('Navigation diagnostics:', JSON.stringify({ project, active: vscode.window.activeTextEditor?.document.uri.toString(), visible: vscode.window.visibleTextEditors.map((e) => e.document.uri.toString()), selected: controls.getViewModel().selected?.id }));
            throw error;
          }
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

// ------------------------------------- v0.5: clickable references + deep explanation

/** "Orca robot hand/orca sim/orca_sim" project with spaces in the path, added as a workspace root. */
async function orcaProject(launcher: VisualAgentApi['launcher']): Promise<{ root: string; optimizer: string; experiment: string; cleanup: () => void }> {
  const base = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-refs-'));
  const root = path.join(base, 'Orca robot hand', 'orca sim', 'orca_sim');
  const optimizer = path.join(root, 'src', 'orca_sim', 'mujoco_optimizer.py');
  const experiment = path.join(root, 'scripts', 'run_palm_aligned_experiment.py');
  fs.mkdirSync(path.dirname(optimizer), { recursive: true });
  fs.mkdirSync(path.dirname(experiment), { recursive: true });
  fs.writeFileSync(optimizer, Array.from({ length: 220 }, (_, i) => `x_${i + 1} = ${i + 1}  # line ${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(experiment, Array.from({ length: 200 }, (_, i) => `# experiment line ${i + 1}`).join('\n') + '\n');
  assert.equal(await launcher.showProject(root), true);
  await waitUntil(() => vscode.workspace.workspaceFolders?.some((f) => path.relative(f.uri.fsPath, root) === ''), 'orca project root');
  return {
    root,
    optimizer,
    experiment,
    cleanup: () => {
      if (!process.env.VAW_TEST_TEMP_DIR) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const samePath = (a?: string, b?: string) => !!a && !!b && path.relative(a, b) === '';

const v05Cases: Case[] = [
  [
    'references: clicking the acceptance link (absolute Windows path with spaces) opens line 167 beside the conversation',
    async ({ launcher, recorder, controls }) => {
      const orca = await orcaProject(launcher);
      try {
        const abs = orca.optimizer.replace(/\\/g, '/');
        const link = `[mujoco_optimizer.py:167](${abs}:167)`;
        const task = recorder.startTask({ description: 'Explain optimizer', source: 'local', adapterName: 'Local agent', simulated: false, workspaceRoot: orca.root });
        recorder.recordMessage(task.taskId, 'user', 'Where is the optimizer?');
        recorder.recordMessage(
          task.taskId,
          'assistant',
          `The setup is in ${link}.\n\n| File | Line |\n|---|---|\n| \`run_palm_aligned_experiment.py:177\` | 177 |\n\nSee also src/orca_sim/mujoco_optimizer.py:12:4 and missing_file.py:3.`,
        );
        recorder.finishTask(task.taskId, 'Completed');
        controls.selectTask(task.taskId);
        await vscode.commands.executeCommand('visualAgent.openConversations', task.taskId);
        const panelColumn = await waitUntil(() => ConversationPanel.viewColumn, 'conversation panel');
        const before = recorder.getOperations().length;

        // Click the Markdown link (the same message the webview posts on click).
        await ConversationPanel.receive({ type: 'openReference', ref: { path: abs, line: 167 }, side: false });
        let editor = await waitUntil(() => samePath(vscode.window.activeTextEditor?.document.uri.fsPath, orca.optimizer) && vscode.window.activeTextEditor, 'optimizer opened');
        assert.equal(editor.selection.active.line, 166, 'cursor on line 167');
        assert.ok(editor.visibleRanges.some((r) => r.contains(new vscode.Position(166, 0))), 'line 167 revealed');
        assert.notEqual(editor.viewColumn, panelColumn, 'opened in another editor group');
        assert.ok(
          vscode.window.tabGroups.all.some((g) => g.activeTab?.input instanceof vscode.TabInputWebview && /conversations/.test((g.activeTab.input as vscode.TabInputWebview).viewType)),
          `the conversation stays visible: ${JSON.stringify(vscode.window.tabGroups.all.map((g) => ({ col: g.viewColumn, active: g.activeTab?.label, tabs: g.tabs.map((t) => t.label) })))}`,
        );

        // Relative path resolved against the conversation's project, with line AND column.
        await ConversationPanel.receive({ type: 'openReference', ref: { path: 'src/orca_sim/mujoco_optimizer.py', line: 12, column: 4 } });
        editor = await waitUntil(() => vscode.window.activeTextEditor?.selection.active.line === 11 && vscode.window.activeTextEditor, 'line 12');
        assert.equal(editor.selection.active.character, 3, 'column 4');

        // Bare filename (from a table cell) found by path-suffix search inside the project.
        await ConversationPanel.receive({ type: 'openReference', ref: { path: 'run_palm_aligned_experiment.py', line: 177 } });
        await waitUntil(
          () => samePath(vscode.window.activeTextEditor?.document.uri.fsPath, orca.experiment) && vscode.window.activeTextEditor!.selection.active.line === 176,
          'experiment line 177',
        );

        // Missing file: nothing opens, nothing is created.
        const active = vscode.window.activeTextEditor?.document.uri.fsPath;
        const result: any = await vscode.commands.executeCommand('visualAgent.openReference', { refPath: 'missing_file.py', refLine: 3, taskId: task.taskId }, { quiet: true });
        assert.equal(result.ok, false);
        assert.match(result.reason, /not found/i);
        assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, active);
        assert.equal(fs.existsSync(path.join(orca.root, 'missing_file.py')), false);

        // Invalid / unsafe input from a webview is refused without side effects.
        for (const bad of [{ path: 'command:workbench.action.terminal.new' }, { path: 'https://example.com/a.py' }, { path: 42 }, null]) {
          const r: any = await vscode.commands.executeCommand('visualAgent.openReference', bad, { quiet: true });
          assert.equal(r.ok, false);
        }

        // Context-menu "Open to the Side" (the command receives the merged data-vscode-context).
        await vscode.commands.executeCommand('visualAgent.openReferenceToSide', { webviewSection: 'codeRef', refPath: 'src/orca_sim/mujoco_optimizer.py', refLine: 200, taskId: task.taskId });
        await waitUntil(() => vscode.window.activeTextEditor?.selection.active.line === 199 && vscode.window.activeTextEditor, 'opened to the side');
        assert.equal(recorder.getOperations().length, before, 'navigation never records agent operations or runs anything');
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        orca.cleanup();
      }
    },
  ],
];


/** Fake model reply built from the REAL numbered lines in the prompt (so ranges can be validated). */
function explainReply(request: any): string[] {
  const user: string = request.messages.at(-1).content;
  const code = user.slice(user.lastIndexOf('Code ('));
  const nums = [...code.matchAll(/^\s*(\d+) \| /gm)].map((m) => Number(m[1]));
  const a = nums[0] ?? 1;
  const b = nums.at(-1) ?? a;
  const mid = Math.min(b, a + 2);
  if (/level-3 heading/.test(user)) {
    return [
      `### Lines ${a}–${mid}: Setup\n`,
      `[Fact] Lines ${a}–${mid} define the start. See Lines ${a}–${a + 1}.\n\n`,
      `### Lines ${Math.min(b, mid + 1)}–${b}: Rest\n`,
      `[Inference] the rest computes values.\n\n`,
      `### Lines 9000–9010: Invented\n[Issue] not real.\n`,
    ];
  }
  return [`## 1. Overall purpose\n[Fact] Lines ${a}–${b} compute values.\n\n## 6. Potential errors, edge cases and assumptions\n[Issue] none visible.\n`];
}

/** A Python file with a class of methods and module-level code (in the orca project). */
function writeLongPython(file: string, methods: number, body: number): string {
  const lines = ['import numpy as np', '', 'GAIN = 0.5', '', 'class MujocoOptimizer:'];
  for (let m = 0; m < methods; m++) {
    lines.push(`    def step_${m}(self, q, target):`);
    for (let k = 0; k < body; k++) lines.push(`        err_${k} = np.linalg.norm(q - target) * GAIN + ${k}`);
    lines.push(`        return err_${body - 1}`, '');
  }
  lines.push('def main():', '    return MujocoOptimizer().step_0(np.zeros(3), np.ones(3))', '');
  const text = lines.join('\n');
  fs.writeFileSync(file, text);
  return text;
}

const v05ExplainCases: Case[] = [
  [
    'explain in detail: line-by-line for the function at the cursor; clickable ranges; side by side; read-only; mode switch needs a click',
    async ({ launcher, explainer, reviewer }) => {
      const orca = await orcaProject(launcher);
      const fake = new FakeOllama();
      fake.respond = explainReply;
      try {
        await setReviewer('endpoint', await fake.start());
        await setReviewer('enabled', true);
        await reviewer.refreshModels();
        const file = path.join(orca.root, 'src', 'orca_sim', 'palm_aligned_optimizer.py');
        const text = writeLongPython(file, 4, 12);
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
        const fnLine = text.split('\n').findIndex((l) => l.includes('def step_1')) + 1; // 1-based
        editor.selection = new vscode.Selection(fnLine + 2, 8, fnLine + 2, 8);
        const before = fake.chatRequests.length;

        const record: any = await vscode.commands.executeCommand('visualAgent.explainCodeInDetail', { uri: doc.uri.toString(), line: fnLine + 3, scope: 'symbol', mode: 'lineByLine' });
        assert.equal(record?.status, 'done', record?.error);
        assert.equal(record.target.symbolName, 'step_1');
        assert.equal(record.target.startLine, fnLine);
        assert.equal(fake.chatRequests.length - before, 1, 'exactly one local request');
        const sent: string = fake.chatRequests.at(-1).messages.at(-1).content;
        assert.match(sent, new RegExp(`${fnLine} \\|     def step_1\\(self, q, target\\):`));
        assert.doesNotMatch(sent, /def step_2/, 'unrelated code is not sent');
        assert.match(sent, /class MujocoOptimizer:/, 'enclosing class signature as context');
        const sections = record.parts[0].sections;
        assert.equal(sections[0].startLine, fnLine);
        assert.equal(sections.at(-1).rangeValid, false, 'invented range is flagged, not linked');
        assert.equal(fs.readFileSync(file, 'utf8'), text, 'source unchanged');
        assert.equal(doc.isDirty, false);

        // Panel beside the source; both visible.
        const panel = await waitUntil(() => ExplainPanel.current, 'explanation panel');
        await waitUntil(() => panel.lastState?.record?.status === 'done', 'panel state');
        assert.notEqual(panel.column, editor.viewColumn);
        assert.ok(vscode.window.visibleTextEditors.some((e) => e.document === doc), 'source stays visible');
        assert.equal(panel.lastState.record.parts[0].sections[1].startLine, sections[1].startLine);

        // Clicking a section range navigates and highlights the real lines.
        await ExplainPanel.receive({ type: 'gotoRange', id: record.id, startLine: sections[1].startLine, endLine: sections[1].endLine });
        await waitUntil(() => vscode.window.activeTextEditor?.document === doc && vscode.window.activeTextEditor.selection.active.line === sections[1].startLine - 1, 'navigated to section range');
        // "Lines X–Y" inside the text is a self reference.
        await ExplainPanel.receive({ type: 'openReference', id: record.id, ref: { path: record.file.relPath, line: fnLine + 1, endLine: fnLine + 2, self: true } });
        await waitUntil(() => vscode.window.activeTextEditor?.selection.active.line === fnLine, 'self reference');

        // Switching mode shows no result and makes no request until the user clicks Explain.
        const n = fake.chatRequests.length;
        await ExplainPanel.receive({ type: 'setMode', mode: 'structured' });
        await waitUntil(() => panel.lastState?.needsRun === true, 'needs run');
        assert.equal(fake.chatRequests.length, n);
        await ExplainPanel.receive({ type: 'run', mode: 'structured' });
        await waitUntil(() => explainer.current()?.mode === 'structured' && explainer.current()?.status === 'done', 'structured explanation');
        assert.equal(fake.chatRequests.length, n + 1);
        assert.match(fake.chatRequests.at(-1).messages.at(-1).content, /Role within the project/, 'function scope: its role within the project');
        // Back to line-by-line: the earlier result is shown without any request.
        await ExplainPanel.receive({ type: 'setMode', mode: 'lineByLine' });
        await waitUntil(() => explainer.current()?.id === record.id, 'previous record');
        assert.equal(fake.chatRequests.length, n + 1);

        // Stale detection on an unsaved edit; discarding the edit clears it.
        const we = new vscode.WorkspaceEdit();
        we.insert(doc.uri, new vscode.Position(0, 0), '# edited\n');
        await vscode.workspace.applyEdit(we);
        await waitUntil(() => explainer.find(record.id)?.stale === true, 'stale after edit');
        await waitUntil(() => panel.lastState?.record?.stale === true || explainer.current()?.id !== record.id, 'panel stale');
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await waitUntil(() => explainer.find(record.id)?.stale === false, 'not stale after revert');
        assert.equal(fs.readFileSync(file, 'utf8'), text, 'never saved');

        // Export / copy.
        const out = vscode.Uri.file(path.join(orca.root, 'explanation.md'));
        await explainer.export(record.id, out);
        const md = fs.readFileSync(out.fsPath, 'utf8');
        assert.match(md, /Line-by-line explanation/);
        assert.match(md, new RegExp(`### Lines ${fnLine}–`));
        assert.match(md, /qwen3:8b/);
        // Copy writes exactly this Markdown (the headless test host has no readable clipboard).
        assert.equal(explainer.markdown(record.id), md);
        await explainer.copy(record.id);
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        ExplainPanel.current?.dispose();
        await fake.stop();
        orca.cleanup();
      }
    },
  ],
  [
    'explain in detail: an entire long file is chunked by functions; part limit reported as partial; cancel stops the rest',
    async ({ launcher, explainer, reviewer }) => {
      const orca = await orcaProject(launcher);
      const fake = new FakeOllama();
      fake.respond = explainReply;
      try {
        await setReviewer('endpoint', await fake.start());
        await setReviewer('contextWindow', 2048);
        await setReviewer('maxContextChars', 2000);
        await setReviewer('explainMaxParts', 3);
        await reviewer.refreshModels();
        const file = path.join(orca.root, 'long_module.py');
        writeLongPython(file, 10, 25);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        const before = fake.chatRequests.length;
        const record: any = await vscode.commands.executeCommand('visualAgent.explainCodeInDetail', { uri: doc.uri.toString(), scope: 'file', mode: 'structured' });
        assert.equal(record.status, 'done', record.error);
        assert.equal(record.parts.length, 3);
        assert.equal(record.plan.partial, true);
        assert.ok(record.plan.omitted.at(-1).endLine >= doc.lineCount - 3, 'the rest of the file is reported as not analyzed');
        assert.equal(fake.chatRequests.length - before, 4, '3 parts + 1 overall summary');
        const prompts = fake.chatRequests.slice(before, before + 3).map((r: any) => r.messages.at(-1).content as string);
        assert.ok(prompts.every((p) => p.length < 6000), 'each part fits the configured context');
        assert.ok(prompts.every((p) => /were NOT provided/.test(p)), 'the model is told the analysis is partial');
        assert.match(fake.chatRequests.at(-1).messages.at(-1).content, /Combine the part explanations/);
        assert.ok(record.synthesis && record.synthesis.status === 'done');
        assert.match(explainer.markdown(record.id)!, /partial: .*not analyzed/);

        // Cancellation: the active request is aborted and remaining parts never run.
        fake.respond = undefined;
        fake.tokens = Array.from({ length: 400 }, (_, i) => `t${i} `);
        fake.chunkDelayMs = 15;
        const startCount = fake.chatRequests.length;
        const pending = vscode.commands.executeCommand('visualAgent.explainCodeInDetail', { uri: doc.uri.toString(), scope: 'file', mode: 'lineByLine' }) as Thenable<any>;
        await waitUntil(() => explainer.isRunning() && reviewer.getState().busy && !!reviewer.getState().current?.text, 'first part streaming', 10_000);
        await ExplainPanel.receive({ type: 'cancel' });
        const cancelled = await pending;
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(fake.chatRequests.length - startCount, 1, 'no further parts after cancel');
        assert.ok(cancelled.parts.slice(1).every((p: any) => p.status === 'cancelled'));
        assert.equal(reviewer.getState().busy, false);
        await waitUntil(() => fake.aborted > 0, 'HTTP request aborted');
      } finally {
        fake.tokens = ['ok'];
        fake.chunkDelayMs = 0;
        await setReviewer('contextWindow', undefined);
        await setReviewer('maxContextChars', undefined);
        await setReviewer('explainMaxParts', undefined);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        ExplainPanel.current?.dispose();
        await fake.stop();
        orca.cleanup();
      }
    },
  ],
  [
    'explain in detail: from a conversation reference (context menu → scope picker) and the activity/reviewer entry points; disabled reviewer makes no requests',
    async ({ launcher, explainer, reviewer, recorder }) => {
      const orca = await orcaProject(launcher);
      const fake = new FakeOllama();
      fake.respond = explainReply;
      try {
        await setReviewer('endpoint', await fake.start());
        await reviewer.refreshModels();
        const task = recorder.startTask({ description: 'refs', source: 'local', adapterName: 'Local agent', simulated: false, workspaceRoot: orca.root });
        recorder.finishTask(task.taskId, 'Completed');
        const file = path.join(orca.root, 'src', 'orca_sim', 'gesture_retargeting.py');
        fs.writeFileSync(file, ['import numpy as np', '', 'def retarget(hand, scale):', '    q = np.asarray(hand) * scale', '    return q', ''].join('\n'));
        // Context menu on "gesture_retargeting.py:4" in a conversation: resolves, opens, asks for the scope.
        const pending = vscode.commands.executeCommand('visualAgent.explainReference', { webviewSection: 'codeRef', refPath: 'gesture_retargeting.py', refLine: 4, taskId: task.taskId }) as Thenable<any>;
        await new Promise((r) => setTimeout(r, 800));
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem'); // first item: Function / class
        const record = await pending;
        assert.equal(record?.status, 'done');
        assert.equal(record.scope, 'symbol');
        assert.equal(record.target.symbolName, 'retarget');
        assert.ok(samePath(record.file.fsPath, file));

        const all = await vscode.commands.getCommands(true);
        for (const c of ['visualAgent.explainCodeInDetail', 'visualAgent.explainReference', 'visualAgent.explain.cancel', 'visualAgent.openReference', 'visualAgent.openReferenceToSide']) assert.ok(all.includes(c), c);
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.menus['editor/context'].some((m: any) => m.command === 'visualAgent.explainCodeInDetail'));
        assert.ok(pkg.contributes.menus['webview/context'].some((m: any) => m.command === 'visualAgent.explainReference'));

        // Disabled reviewer: no request at all.
        await setReviewer('enabled', false);
        const n = fake.chatRequests.length;
        const r = await vscode.commands.executeCommand('visualAgent.explainCodeInDetail', { uri: vscode.Uri.file(file).toString(), scope: 'file', mode: 'structured' });
        assert.equal(r, undefined);
        assert.equal(fake.chatRequests.length, n);
        assert.equal(explainer.isRunning(), false);
      } finally {
        await setReviewer('enabled', true);
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        ExplainPanel.current?.dispose();
        await fake.stop();
        orca.cleanup();
      }
    },
  ],
];


// ------------------------------------------- review before writing / manual changes / command display

const ORIG = 'function divide(a, b) {\n  return a / b;\n}\nmodule.exports = { divide };\n';
const GUARDED = 'function divide(a, b) {\n  if (b === 0) throw new Error("zero");\n  return a / b;\n}\nmodule.exports = { divide };\n';

/** Start a fake local-agent conversation in a temp project; returns helpers. */
async function fakeLocalConversation(api: VisualAgentApi, turns: Array<(s: FakeOpenCode) => Promise<void>>) {
  const { launcher, controller } = api;
  const project = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-review-'));
  fs.writeFileSync(path.join(project, 'math.js'), ORIG);
  const fake = new FakeOpenCode();
  fake.directory = project;
  fake.turns = [async (s) => { s.assistant(); s.text('hello', 'Ready.'); s.idle(); }, ...turns];
  const originalModels = launcher.models;
  const originalCreate = launcher.createAdapter;
  launcher.models = async () => [{ id: 'qwen3:8b', label: 'qwen3:8b', compatible: true }];
  launcher.createAdapter = (selection) => new OpenCodeAdapter({ connector: async () => fake, launch: { executable: 'fixture', homeDir: project, ollamaBaseUrl: 'http://127.0.0.1:1', model: selection.model, contextLimit: 8192, outputLimit: 2048, profile: 'approved-write' } });
  const id = (await launcher.start({ provider: 'local', model: 'qwen3:8b', profile: 'approved-write', workspaceRoot: project, instructions: 'Start' }))!;
  await waitUntil(() => controller.getSnapshot().awaitingInput, 'first turn');
  return {
    id,
    project,
    fake,
    file: path.join(project, 'math.js'),
    prompts: () => fake.requests.filter((r) => r.route.endsWith('/prompt_async')).map((r) => r.body.parts[0].text as string),
    cleanup: async () => {
      if (controller.isActive) {
        await controller.endSession().catch(() => undefined);
        if (controller.isActive) controller.stop();
        await controller.whenIdle();
      }
      launcher.models = originalModels;
      launcher.createAdapter = originalCreate;
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      if (!process.env.VAW_TEST_TEMP_DIR) fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

const editTool = (s: FakeOpenCode, call: string, file: string, from: string, to: string) =>
  s.tool(call, 'edit', 'running', { filePath: file, oldString: from, newString: to });

const v06Cases: Case[] = [
  [
    'review before writing: conflict blocks approval; edit before applying writes the user version and declines the agent; regenerate sends feedback',
    async (api) => {
      const { controller, recorder, controls } = api;
      const replies: string[] = [];
      let conv: Awaited<ReturnType<typeof fakeLocalConversation>> | undefined;
      conv = await fakeLocalConversation(api, [
        async (s) => {
          // Proposal 1: blocked by a conflict, then approved after the file is restored.
          s.assistant('m1');
          editTool(s, 'e1', conv!.file, 'return a / b;', 'if (b === 0) throw new Error("zero");\n  return a / b;');
          replies.push(await s.permission('p1', 'edit', 'e1', { filepath: conv!.file }));
          fs.writeFileSync(conv!.file, GUARDED); // OpenCode applies the approved edit
          s.tool('e1', 'edit', 'completed', { filePath: conv!.file, oldString: 'x', newString: 'y' });
          // Proposal 2: the user edits it before applying.
          editTool(s, 'e2', conv!.file, 'module.exports = { divide };', 'module.exports = { divide, version: 1 };');
          replies.push(await s.permission('p2', 'edit', 'e2', { filepath: conv!.file }));
          s.tool('e2', 'edit', 'error', { filePath: conv!.file }, { error: 'rejected' });
          // Proposal 3: regenerate with feedback.
          editTool(s, 'e3', conv!.file, 'return a / b;', 'return Math.round(a / b);');
          replies.push(await s.permission('p3', 'edit', 'e3', { filepath: conv!.file }));
          s.tool('e3', 'edit', 'error', { filePath: conv!.file }, { error: 'rejected' });
          s.idle();
        },
      ]);
      try {
        await api.launcher.send(conv.id, 'Guard divide');
        const p1 = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'proposal 1');
        assert.equal((await controls.proposals.check(p1)).ok, true, 'snapshot taken, nothing changed yet');
        // The user changes the file after the diff was computed → approval is refused, nothing is written.
        fs.writeFileSync(conv.file, ORIG + '// user note\n');
        await vscode.commands.executeCommand('visualAgent.approve');
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(replies, [], 'OpenCode is still waiting: the agent did not get approval');
        assert.equal(recorder.getOperation(p1)!.status, 'Proposed');
        assert.match(recorder.getOperation(p1)!.history.map((h) => h.note).join(' '), /Approval blocked: math\.js changed on disk/);
        assert.match(controls.proposals.describe(controls.proposals.conflictFor(p1)!), /changed on disk/);
        assert.equal(fs.readFileSync(conv.file, 'utf8'), ORIG + '// user note\n');
        // Unsaved editor edits are a conflict too.
        fs.writeFileSync(conv.file, ORIG);
        const doc = await vscode.workspace.openTextDocument(conv.file);
        await vscode.window.showTextDocument(doc);
        // Follow may already have the file open: let VS Code reload it from disk first, or the reload replaces the edit.
        await waitUntil(() => doc.getText() === ORIG, 'open document reloaded from disk');
        const we = new vscode.WorkspaceEdit();
        we.insert(doc.uri, new vscode.Position(0, 0), '// unsaved\n');
        assert.ok(await vscode.workspace.applyEdit(we), 'edit applied');
        await waitUntil(() => doc.isDirty, 'document has unsaved edits');
        const unsavedCheck = await controls.proposals.check(p1);
        assert.equal(unsavedCheck.files[0].reason, 'unsaved', `diagnostics: ${JSON.stringify({ files: unsavedCheck.files, docDirty: doc.isDirty, docUri: doc.uri.toString(), open: vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file' && /math.js$/.test(d.uri.fsPath)).map((d) => [d.uri.toString(), d.isDirty]) })}`);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        assert.equal((await controls.proposals.check(p1)).ok, true);
        await vscode.commands.executeCommand('visualAgent.approve');
        await waitUntil(() => replies.length === 1, 'approved');
        assert.equal(replies[0], 'once');

        // Proposal 2: edit before applying.
        const p2 = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p1 ? id : undefined; }, 'proposal 2');
        await controls.runAction('editProposal', p2);
        const temp = await waitUntil(() => vscode.workspace.textDocuments.find((d) => d.uri.fsPath.includes(path.join('proposals', p2))), 'editable copy');
        assert.match(temp.getText(), /version: 1/, 'the editable copy starts as the proposed version');
        assert.equal(fs.readFileSync(conv.file, 'utf8'), GUARDED, 'nothing written yet');
        const mine = temp.getText().replace('version: 1', 'version: 2, author: "me"');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(temp.uri, new vscode.Range(0, 0, temp.lineCount, 0), mine);
        await vscode.workspace.applyEdit(edit);
        await controls.runAction('applyEdited', p2);
        await waitUntil(() => replies.length === 2, 'agent write declined');
        assert.equal(fs.readFileSync(conv.file, 'utf8'), mine, 'the user version is on disk');
        assert.equal(replies[1], 'reject');
        assert.match(conv.fake.replies.find((r) => r.id === 'p2')!.message!, /applied their own edited version[\s\S]*Read the latest math\.js/);
        const userOp = recorder.getOperations(conv.id).find((o) => o.source === 'user' && o.operationType === 'Edit')!;
        assert.equal(userOp.status, 'Completed');
        assert.match(userOp.description, /You applied your edited version of math\.js/);

        // Proposal 3: regenerate with feedback.
        const p3 = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p2 && id !== p1 ? id : undefined; }, 'proposal 3');
        assert.equal(await controls.proposals.regenerate(p3, 'keep exact division, no rounding'), true);
        await waitUntil(() => replies.length === 3, 'regenerate');
        assert.match(conv.fake.replies.find((r) => r.id === 'p3')!.message!, /Feedback: keep exact division, no rounding[\s\S]*Re-read the latest math\.js/);
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'turn done');
        assert.equal(fs.readFileSync(conv.file, 'utf8'), mine, 'rejected proposal never written');
      } finally {
        await conv.cleanup();
      }
    },
  ],
  [
    'manual adjustments: check my changes and continue from my changes send real diffs; preservation of user edits is verified on the final files',
    async (api) => {
      const { controller, recorder, manual } = api;
      let conv: Awaited<ReturnType<typeof fakeLocalConversation>> | undefined;
      const USER = GUARDED.replace('  return a / b;', '  // user: keep integer semantics explicit\n  return a / b;');
      conv = await fakeLocalConversation(api, [
        async (s) => {
          s.assistant('m1');
          editTool(s, 'e1', conv!.file, 'return a / b;', 'if (b === 0) throw new Error("zero");\n  return a / b;');
          await s.permission('p1', 'edit', 'e1', { filepath: conv!.file });
          fs.writeFileSync(conv!.file, GUARDED);
          s.tool('e1', 'edit', 'completed', { filePath: conv!.file, oldString: 'x', newString: 'y' });
          s.idle();
        },
        async (s) => { s.assistant('m2'); s.text('rev', 'Your comment is fine.', 'm2'); s.idle(); }, // check my changes
        async (s) => {
          // continue: the agent keeps the user's line and adds an export.
          s.assistant('m3');
          const final = USER.replace('module.exports = { divide };', 'module.exports = { divide, safeDivide: divide };');
          editTool(s, 'e3', conv!.file, 'module.exports = { divide };', 'module.exports = { divide, safeDivide: divide };');
          await s.permission('p3', 'edit', 'e3', { filepath: conv!.file });
          fs.writeFileSync(conv!.file, final);
          s.tool('e3', 'edit', 'completed', { filePath: conv!.file, oldString: 'x', newString: 'y' });
          s.idle();
        },
        async (s) => {
          // continue again: this time the agent overwrites the user's line.
          s.assistant('m4');
          editTool(s, 'e4', conv!.file, '  // user: second note\n', '');
          await s.permission('p4', 'edit', 'e4', { filepath: conv!.file });
          fs.writeFileSync(conv!.file, GUARDED);
          s.tool('e4', 'edit', 'completed', { filePath: conv!.file, oldString: 'x', newString: 'y' });
          s.idle();
        },
      ]);
      try {
        assert.equal(manual.tracked(conv.id), 0);
        assert.match((await manual.check(conv.id)).reason!, /no baseline/i);
        await api.launcher.send(conv.id, 'Guard divide');
        controller.approve(await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'edit'));
        await waitUntil(() => controller.getSnapshot().awaitingInput && manual.tracked(conv!.id) === 1, 'baseline recorded after the applied edit');
        assert.match((await manual.check(conv.id)).reason!, /No manual changes/);

        // The user edits the file by hand.
        fs.writeFileSync(conv.file, USER);
        const checked: any = await vscode.commands.executeCommand('visualAgent.checkMyChanges', conv.id);
        assert.equal(checked.sent, true);
        await waitUntil(() => controller.getSnapshot().awaitingInput && conv!.prompts().length === 3, 'check turn');
        const checkMsg = conv.prompts()[2];
        assert.match(checkMsg, /Check my changes/);
        assert.match(checkMsg, /\+  \/\/ user: keep integer semantics explicit/, 'the real diff is sent');
        assert.match(checkMsg, /Read the LATEST version[\s\S]*Do not modify files or run commands/);

        const cont: any = await vscode.commands.executeCommand('visualAgent.continueFromMyChanges', conv.id);
        assert.equal(cont.sent, true);
        controller.approve(await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'continue edit'));
        await waitUntil(() => manual.lastResult(conv!.id)?.files.length === 1 && !manual.isValidating(conv!.id), 'validation after continue');
        const contMsg = conv.prompts()[3];
        assert.match(contMsg, /read its latest version from disk[\s\S]*Keep my edits[\s\S]*validate the final version/);
        assert.equal(manual.lastResult(conv.id)!.ok, true, manual.lastResult(conv.id)!.text);
        const okOp = recorder.getOperations(conv.id).filter((o) => /Manual edits check/.test(o.description)).at(-1)!;
        assert.equal(okOp.status, 'Completed');
        assert.match(okOp.resultSummary!, /✔ math\.js: all 1 of your edits kept/);

        // Second round: the agent removes the user's new line → reported, from the actual file.
        fs.writeFileSync(conv.file, fs.readFileSync(conv.file, 'utf8').replace('  return a / b;', '  // user: second note\n  return a / b;'));
        await manual.continueFrom(conv.id, 'tidy up');
        assert.match(conv.prompts()[4], /Then continue with: tidy up/);
        controller.approve(await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'overwrite edit'));
        await waitUntil(() => !manual.isValidating(conv!.id) && manual.lastResult(conv!.id)?.ok === false, 'lost edit detected');
        const bad = recorder.getOperations(conv.id).filter((o) => /Manual edits check/.test(o.description)).at(-1)!;
        assert.equal(bad.status, 'Failed');
        assert.match(bad.resultSummary!, /✖ math\.js: 0\/1 of your edits kept[\s\S]*user: second note/);
      } finally {
        await conv.cleanup();
      }
    },
  ],
  [
    'explain this file (Explorer / editor title) and explain command: on demand, read-only, never executed',
    async ({ explainer, reviewer, recorder, controls, reviewerController }) => {
      const fake = new FakeOllama();
      fake.tokens = ['## Purpose of this file\n[Fact] ok\n'];
      try {
        await setReviewer('endpoint', await fake.start());
        await setReviewer('enabled', true);
        await reviewer.refreshModels();
        const file = vscode.Uri.file(path.join(root(), 'validation.py'));
        const before = fs.readFileSync(file.fsPath, 'utf8');
        const n = fake.chatRequests.length;
        const record: any = await vscode.commands.executeCommand('visualAgent.explainFile', file);
        assert.equal(record?.scope, 'file');
        assert.equal(record.mode, 'structured');
        const prompt: string = fake.chatRequests.at(-1).messages.at(-1).content;
        assert.match(prompt, /Purpose of this file[\s\S]*Execution flow[\s\S]*Dependencies[\s\S]*Modification impact/);
        assert.match(prompt, /Project files that import this file[\s\S]*importer\.py/, 'dependents found by local search');
        assert.equal(fs.readFileSync(file.fsPath, 'utf8'), before);
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
        assert.ok(pkg.contributes.menus['explorer/context'].some((m: any) => m.command === 'visualAgent.explainFile'));
        assert.ok(pkg.contributes.menus['editor/title'].some((m: any) => m.command === 'visualAgent.explainFile'));

        // Explain command: a recorded command, explained without being executed.
        const marker = path.join(root(), 'SHOULD_NOT_EXIST.txt');
        const task = recorder.startTask({ description: 'cmd', source: 'local', adapterName: 'Local', simulated: false, workspaceRoot: root() });
        const op = recorder.recordOperation(task.taskId, { source: 'local', simulated: false, operationType: 'Execute', description: `Run: echo hi > "${marker}"`, requiresApproval: false, command: { command: `echo hi > "${marker}"`, workingDirectory: root(), simulated: false, status: 'Pending' } });
        recorder.finishTask(task.taskId, 'Completed');
        controls.selectOperation(op.operationId, { reveal: false });
        const vmRow = controls.getViewModel().operations.find((o) => o.id === op.operationId)!;
        assert.equal(vmRow.cmd!.writes, true, 'labelled as writing files');
        fake.tokens = ['## Purpose\nwrites a file\n## Reads\nnone\n## Writes\nSHOULD_NOT_EXIST.txt\n## Risks\nlow'];
        const r = await reviewerController.explainCommand(op.operationId);
        assert.equal(r?.status, 'done');
        assert.match(fake.chatRequests.at(-1).messages.at(-1).content, /Do not run it[\s\S]*May write files \(heuristic\): yes/);
        assert.equal(fs.existsSync(marker), false, 'the command was not executed');
        assert.equal(fake.chatRequests.length - n, 2, 'exactly the two explicit requests');
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        ExplainPanel.current?.dispose();
        await fake.stop();
      }
    },
  ],
];


const v07Cases: Case[] = [
  [
    'reliability: review baselines survive a reload; agent writes and commands that would undo manual edits are blocked BEFORE they run',
    async (api) => {
      const { controller, recorder, manual, controls } = api;
      const replies: Record<string, string> = {};
      let conv: Awaited<ReturnType<typeof fakeLocalConversation>> | undefined;
      const USER = GUARDED.replace('  return a / b;', '  // user: keep this comment\n  return a / b;');
      conv = await fakeLocalConversation(api, [
        async (s) => {
          s.assistant('m1');
          editTool(s, 'e1', conv!.file, 'return a / b;', 'if (b === 0) throw new Error("zero");\n  return a / b;');
          replies.e1 = await s.permission('p1', 'edit', 'e1', { filepath: conv!.file });
          fs.writeFileSync(conv!.file, GUARDED);
          s.tool('e1', 'edit', 'completed', { filePath: conv!.file, oldString: 'x', newString: 'y' });
          s.idle();
        },
        async (s) => {
          // Stale full-file write that would drop the user's comment.
          s.assistant('m2');
          s.tool('w2', 'write', 'running', { filePath: conv!.file, content: GUARDED.replace('module.exports = { divide };', 'module.exports = { divide, v: 2 };') });
          replies.w2 = await s.permission('p2', 'edit', 'w2', { filepath: conv!.file });
          s.tool('w2', 'write', 'error', { filePath: conv!.file }, { error: 'rejected' });
          // A shell command that would overwrite the edited file.
          s.tool('b3', 'bash', 'running', { command: 'echo "x" > math.js', workdir: conv!.project });
          replies.b3 = await s.permission('p3', 'bash', 'b3', { command: 'echo "x" > math.js' });
          s.tool('b3', 'bash', 'error', { command: 'echo "x" > math.js' }, { error: 'rejected' });
          s.idle();
        },
      ]);
      try {
        await api.launcher.send(conv.id, 'Guard divide');
        controller.approve(await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'edit 1'));
        await waitUntil(() => controller.getSnapshot().awaitingInput && manual.tracked(conv!.id) === 1, 'baseline');
        // Persisted to workspace storage (not the project).
        const store = manual.storeLocation!;
        await waitUntil(() => { try { return fs.readFileSync(store.fsPath, 'utf8').includes(conv!.id); } catch { return false; } }, 'baseline persisted', 5000);
        assert.ok(!isInside(conv.project, store.fsPath), 'baselines are not stored in the project');
        // A "reloaded window": a fresh instance restores the baseline from disk.
        const reloaded = new ManualChanges(recorder, controller, async () => false, { appendLine: () => {} } as any, undefined, store);
        await reloaded.loaded;
        assert.equal(reloaded.tracked(conv.id), 1, 'baseline restored after reload');
        fs.writeFileSync(conv.file, USER);
        const detected = await reloaded.detect(conv.id);
        assert.equal(detected.length, 1);
        assert.match(detected[0].diff, /\+  \/\/ user: keep this comment/);
        reloaded.dispose();

        // The agent proposes a stale whole-file write: blocked before it runs.
        await api.launcher.send(conv.id, 'Export a version field');
        const w2 = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'stale write');
        const c2 = await controls.proposals.check(w2);
        assert.equal(c2.ok, false);
        assert.equal(c2.files[0].reason, 'undoes-manual');
        assert.match(c2.files[0].detail!, /user: keep this comment/);
        await vscode.commands.executeCommand('visualAgent.approve');
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(replies.w2, undefined, 'the agent was NOT given approval');
        assert.equal(fs.readFileSync(conv.file, 'utf8'), USER, 'manual edit intact');
        assert.equal(await controls.proposals.regenerate(w2, 'keep my comment'), true);
        // A shell command that writes the manually edited file: an explicit shell write,
        // so it is blocked before the user is even asked, and the agent is told to use a patch.
        await waitUntil(() => replies.b3, 'command blocked');
        assert.equal(replies.b3, 'reject', 'command never approved');
        const b3 = recorder.getOperations(conv.id).find((o) => o.externalId === 'b3')!;
        assert.equal(b3.status, 'Rejected');
        assert.equal(b3.command?.status, 'NotRun');
        assert.match(b3.history.at(-1)!.note!, /Blocked before execution[\s\S]*redirection > → math\.js/);
        assert.ok(!b3.history.some((h) => h.actor === 'user'), 'no approval prompt for a shell write');
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'turn done');
        assert.equal(fs.readFileSync(conv.file, 'utf8'), USER);
      } finally {
        await conv.cleanup();
      }
    },
  ],
];

// ------------------------------------------- multi-file edit before applying


const sessionCases: Case[] = [
  [
    'native continuity: follow-ups are turns of one Codex thread; change notes for edited files; two conversations stay isolated; switching back resumes the own thread; another provider\'s session is never reused',
    async (api) => {
      const { controller, recorder, launcher, sessions } = api;
      const project = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-cont-'));
      fs.writeFileSync(path.join(project, 'math.js'), ORIG);
      // Every adapter gets its own fake app-server with its own thread id; creation arguments are recorded.
      const created: Array<{ resume?: string; reason?: string; server: FakeCodexServer }> = [];
      let threads = 0;
      const originalModels = launcher.models;
      const originalCreate = launcher.createAdapter;
      launcher.models = async () => [{ id: 'fake-model', label: 'fake-model', compatible: true }];
      launcher.createAdapter = (_sel, _m, resumeSessionId, _claude, continuation) => {
        const server = new FakeCodexServer();
        server.threadId = `thr-${++threads}`;
        server.handlers['thread/resume'] = (p) => ({ thread: { id: p.threadId }, model: 'fake-model', cwd: project, approvalPolicy: p.approvalPolicy, sandbox: { type: 'readOnly' } });
        let turn = 0;
        server.handlers['turn/start'] = () => {
          server.turnId = `t${++turn}`;
          setTimeout(() => {
            if (turn === 1 && !resumeSessionId) {
              const read = [{ type: 'read', command: 'Get-Content math.js', name: 'math.js', path: 'math.js' }];
              server.itemStarted(commandItem(project, { id: `r${threads}`, commandActions: read }));
              server.itemCompleted(commandItem(project, { id: `r${threads}`, status: 'completed', exitCode: 0, aggregatedOutput: ORIG, commandActions: read }));
            }
            server.itemCompleted({ type: 'agentMessage', id: `m${turn}`, text: `ok ${turn}` });
            server.completeTurn('completed');
          }, 0);
          return { turn: { id: server.turnId, status: 'inProgress', items: [], error: null } };
        };
        created.push({ resume: resumeSessionId, reason: continuation?.reason, server });
        return new CodexAppServerAdapter({ connector: () => new CodexRpcClient(server), profile: getProfile('approve-edits'), model: 'fake-model', resumeThreadId: resumeSessionId, reconstructedContext: continuation?.reconstructedContext, reconstructedReason: resumeSessionId ? undefined : continuation?.reason });
      };
      const turnTexts = (s: FakeCodexServer) => s.received.filter((m) => m.method === 'turn/start').map((m) => String(m.params.input[0].text));
      try {
        // Conversation A: three messages, one native thread.
        const a = (await launcher.start({ provider: 'codex', model: 'fake-model', profile: 'approve-edits', workspaceRoot: project, instructions: 'Inspect divide in math.js' }))!;
        await waitUntil(() => controller.getSnapshot().awaitingInput, 'A turn 1');
        assert.equal(await launcher.send(a, 'Make divide throw on zero'), true);
        await waitUntil(() => controller.getSnapshot().awaitingInput && turnTexts(created[0].server).length === 2, 'A turn 2');
        // The user edits math.js between turns → the next message tells the agent to re-read exactly that file.
        fs.writeFileSync(path.join(project, 'math.js'), ORIG + '// edited by the user\n');
        assert.equal(await launcher.send(a, 'Why did you change it that way?'), true);
        await waitUntil(() => controller.getSnapshot().awaitingInput && turnTexts(created[0].server).length === 3, 'A turn 3');
        const textsA = turnTexts(created[0].server);
        assert.equal(created.length, 1, 'no new adapter/process for follow-ups');
        assert.equal(created[0].server.sentMethods().filter((m) => m === 'thread/start').length, 1, 'one thread for three messages');
        assert.equal(textsA[1], 'Make divide throw on zero', 'Test B: nothing changed → the follow-up is sent as typed (no replay, no re-read request)');
        assert.match(textsA[2], /^\[Context update from the editor: .*math\.js \(modified\).*\]\n\nWhy did you change it that way\?$/s, 'Test C: the changed file is named');
        assert.ok(!recorder.getTask(a)!.messages!.some((m) => m.text.includes('Context update')), 'the note is not shown as the user\'s message');
        const threadA = recorder.getTask(a)!.session!.id;
        assert.equal(threadA, 'thr-1');
        assert.deepEqual(sessions.metrics(a).nativeTurns, 2);

        // Conversation B in the same workspace: its own thread; A's session is ended (not merged).
        const b = (await launcher.start({ provider: 'codex', model: 'fake-model', profile: 'approve-edits', workspaceRoot: project, instructions: 'Explain validation' }))!;
        await waitUntil(() => controller.getSnapshot().awaitingInput && controller.getSnapshot().taskId === b, 'B turn 1');
        assert.equal(created.length, 2);
        assert.equal(created[1].resume, undefined, 'a new conversation never resumes another conversation\'s thread');
        assert.equal(recorder.getTask(b)!.session!.id, 'thr-2');
        assert.notEqual(recorder.getTask(b)!.session!.id, threadA);
        assert.ok(!turnTexts(created[1].server)[0].includes('Inspect divide'), 'no history of A in B');

        // Back to A (as after a reload: a new process): resumes A's own thread natively.
        assert.equal(await launcher.send(a, 'Summarise the change in one line'), true);
        await waitUntil(() => controller.getSnapshot().awaitingInput && controller.getSnapshot().taskId === a, 'A resumed');
        assert.equal(created[2].resume, threadA);
        assert.deepEqual(created[2].server.sentMethods().filter((m) => m.startsWith('thread/')), ['thread/resume']);
        assert.deepEqual(turnTexts(created[2].server), ['Summarise the change in one line'], 'native resume: no saved-conversation replay');
        assert.equal(recorder.getTask(a)!.session!.continuity, 'resumed');
        assert.equal(recorder.getTask(b)!.session!.id, 'thr-2', 'B untouched');

        // Persisted with the history (survives a window reload).
        const saved = recorder.exportHistory().tasks.find((t) => t.taskId === a)!;
        assert.equal(saved.session?.id, threadA);

        // A session recorded by another provider is never reused for Codex.
        await controller.endSession();
        await controller.whenIdle();
        recorder.setSession(a, { provider: 'local', id: 'ses_from_opencode' });
        assert.equal(await launcher.send(a, 'Continue'), true);
        await waitUntil(() => controller.getSnapshot().awaitingInput && created.length === 4, 'A with a foreign session');
        assert.equal(created[3].resume, undefined);
        assert.match(created[3].reason!, /belongs to local/);
        assert.match(turnTexts(created[3].server)[0], /^\[Reconstructed context: the previous native session could not be continued \(the recorded session belongs to local\)/);
        assert.equal(recorder.getTask(a)!.session!.continuity, 'reconstructed');
        await controller.endSession();
        await controller.whenIdle();
      } finally {
        launcher.models = originalModels;
        launcher.createAdapter = originalCreate;
        if (controller.isActive) {
          controller.stop();
          await controller.whenIdle();
        }
        if (!process.env.VAW_TEST_TEMP_DIR) fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  ],
];

const approvalSyncCases: Case[] = [
  [
    'approval sync: the notification closes when the proposal is decided in any panel; repeated decisions reach the agent once; stop closes it too',
    async (api) => {
      const { controller, recorder, controls } = api;
      const replies: string[] = [];
      let conv: Awaited<ReturnType<typeof fakeLocalConversation>> | undefined;
      conv = await fakeLocalConversation(api, [
        async (s) => {
          s.assistant('m1');
          editTool(s, 'e1', conv!.file, 'return a / b;', 'if (b === 0) throw new Error("zero");\n  return a / b;');
          replies.push(await s.permission('p1', 'edit', 'e1', { filepath: conv!.file }));
          fs.writeFileSync(conv!.file, GUARDED);
          s.tool('e1', 'edit', 'completed', { filePath: conv!.file, oldString: 'x', newString: 'y' });
          s.tool('b2', 'bash', 'running', { command: 'node --version', workdir: conv!.project });
          replies.push(await s.permission('p2', 'bash', 'b2', { command: 'node --version' }));
          s.tool('b2', 'bash', 'error', { command: 'node --version' }, { error: 'rejected' });
          editTool(s, 'e3', conv!.file, 'module.exports = { divide };', 'module.exports = { divide, v: 1 };');
          replies.push(await s.permission('p3', 'edit', 'e3', { filepath: conv!.file }));
          s.idle();
        },
      ]);
      try {
        await api.launcher.send(conv.id, 'Guard divide');
        await vscode.commands.executeCommand('visualAgent.openConversations', conv.id);
        // 1. Approved in the Conversation panel → the notification closes; Activity shows it decided.
        const p1 = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'proposal 1');
        await waitUntil(() => controls.openApprovalNotices().includes(p1), 'approval notification shown');
        await controls.runAction('review', p1); // the diff must have been seen before approving
        await ConversationPanel.receive({ type: 'action', action: 'approve', operationId: p1 });
        await waitUntil(() => replies.length === 1, 'agent got the approval');
        assert.equal(replies[0], 'once');
        await waitUntil(() => !controls.openApprovalNotices().includes(p1), 'notification closed after approval in the Conversation panel');
        assert.ok(!controls.getViewModel().operations.find((o) => o.id === p1)?.awaitingApproval, 'Agent Activity: no longer awaiting');
        // Repeated approvals (double click, the other panel, the command) are ignored without warnings and never reach the agent twice.
        await ConversationPanel.receive({ type: 'action', action: 'approve', operationId: p1 });
        await controls.runAction('approve', p1);
        await vscode.commands.executeCommand('visualAgent.approve', p1);
        // 2. A command decided from the Agent Activity path (controller) → its notification closes too.
        const p2 = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p1 ? id : undefined; }, 'proposal 2');
        await waitUntil(() => controls.openApprovalNotices().includes(p2), 'second notification');
        assert.ok(controller.reject(p2, 'not now'));
        await waitUntil(() => replies.length === 2, 'agent got the rejection');
        assert.deepEqual(replies, ['once', 'reject'], 'each decision reached the agent exactly once');
        await waitUntil(() => !controls.openApprovalNotices().includes(p2), 'notification closed after rejection');
        // 3. Stopping the task closes the notification of a pending proposal.
        const p3 = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p2 && id !== p1 ? id : undefined; }, 'proposal 3');
        await waitUntil(() => controls.openApprovalNotices().includes(p3), 'third notification');
        controller.stop();
        await controller.whenIdle();
        await waitUntil(() => controls.openApprovalNotices().length === 0, 'notification closed on stop');
        assert.equal(recorder.getOperation(p3)!.status, 'Cancelled');
      } finally {
        await conv.cleanup();
      }
    },
  ],
];

const multiFileCases: Case[] = [
  [
    'multi-file edit before applying: file list, switching keeps edits, reset, combined diff, conflict blocks, failed write rolls back, cancel, then normal approval',
    async (api) => {
      const { controller, recorder, controls, launcher } = api;
      const project = fs.mkdtempSync(path.join(process.env.VAW_TEST_TEMP_DIR || os.tmpdir(), 'vaw-multi-'));
      const file = (rel: string) => path.join(project, rel);
      const read = (rel: string) => (fs.existsSync(file(rel)) ? fs.readFileSync(file(rel), 'utf8') : undefined);
      const A = 'export const a = 1;\n', B = 'export const b = 1;\n', OLD = 'legacy();\n', KEEP = 'keep();\n';
      fs.writeFileSync(file('keep.js'), KEEP);
      fs.writeFileSync(file('a.js'), A);
      fs.writeFileSync(file('b.js'), B);
      fs.writeFileSync(file('old.js'), OLD);
      const agent = new MultiFileAgent(project, [
        [
          { rel: 'a.js', kind: 'update', after: (s) => s.replace('= 1', '= 2') },
          { rel: 'b.js', kind: 'update', after: (s) => s.replace('= 1', '= 2') },
          { rel: 'c.js', kind: 'add', after: () => 'export const c = 3;\n' },
          { rel: 'old.js', kind: 'delete' },
          { rel: 'keep.js', kind: 'delete' },
        ],
        [
          // A stale proposal: reverts the user's applied a.js and deletes the file the user kept.
          { rel: 'a.js', kind: 'update', after: () => 'export const a = 2;\n' },
          { rel: 'keep.js', kind: 'delete' },
        ],
        [
          { rel: 'a.js', kind: 'update', after: (s) => s + '// p2\n' },
          { rel: 'b.js', kind: 'update', after: (s) => s + '// p2\n' },
        ],
        [
          { rel: 'a.js', kind: 'update', after: (s) => s + '// p3\n' },
          { rel: 'b.js', kind: 'update', after: (s) => s + '// p3\n' },
        ],
      ]);
      const originalModels = launcher.models;
      const originalCreate = launcher.createAdapter;
      const originalStore = controls.proposals.fileStore;
      launcher.models = async () => [{ id: 'qwen3:8b', label: 'qwen3:8b', compatible: true }];
      launcher.createAdapter = () => agent;
      const copies = (op: string) => vscode.workspace.textDocuments.filter((d) => d.uri.fsPath.includes(path.join('proposals', op)));
      const setDoc = async (doc: vscode.TextDocument, text: string) => {
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
        await vscode.workspace.applyEdit(we);
      };
      try {
        const taskId = (await launcher.start({ provider: 'local', model: 'qwen3:8b', profile: 'approved-write', workspaceRoot: project, instructions: 'Rename constants' }))!;
        const p1 = await waitUntil(() => controller.getSnapshot().awaitingApprovalFor, 'multi-file proposal');
        assert.equal(recorder.getOperation(p1)!.associatedChangeIds?.length, 5);

        // 1. All files in a selectable list; nothing written.
        await controls.runAction('editProposal', p1);
        const state = () => controls.proposals.editState(p1)!;
        await waitUntil(() => controls.proposals.isEditing(p1), 'editing');
        assert.equal(state().multi, true);
        assert.deepEqual(state().files.map((f) => [f.rel, f.kind, f.editable]), [['a.js', 'update', true], ['b.js', 'update', true], ['c.js', 'add', true], ['old.js', 'delete', false], ['keep.js', 'delete', false]]);
        assert.deepEqual([read('a.js'), read('b.js'), read('c.js'), read('old.js')], [A, B, undefined, OLD], 'nothing written yet');

        // 2./3. Edit a.js, switch to b.js and edit it: a.js keeps the user's text.
        const aDoc = await waitUntil(() => copies(p1).find((d) => d.uri.fsPath.endsWith('a.js')), 'a.js copy');
        assert.equal(aDoc.getText(), 'export const a = 2;\n', 'the copy starts as the proposed version');
        await setDoc(aDoc, 'export const a = 42; // mine\n');
        await controls.proposals.editBeforeApplying(p1, 1);
        await waitUntil(() => state().files[1].active, 'switched to b.js');
        assert.equal(state().files[0].edited, true, 'a.js edit kept after switching');
        assert.equal(fs.readFileSync(aDoc.uri.fsPath, 'utf8'), 'export const a = 42; // mine\n', 'the copy was saved when switching');
        const bDoc = await waitUntil(() => copies(p1).find((d) => d.uri.fsPath.endsWith('b.js')), 'b.js copy');
        await setDoc(bDoc, 'export const b = 99;\n');
        await waitUntil(() => state().files[1].edited, 'b.js edited');
        // 4. Reset b.js only.
        await controls.proposals.resetEditFile(p1, 1);
        assert.equal(bDoc.getText(), 'export const b = 2;\n');
        assert.deepEqual(state().files.map((f) => f.edited), [true, false, false, false, false], 'reset one file; the others keep their edits');
        // Exclude one proposed deletion (keep.js) without rejecting the proposal.
        await controls.proposals.setDeletionExcluded(p1, 4, true);
        assert.deepEqual(state().files.map((f) => f.excluded), [false, false, false, false, true]);
        await assert.rejects(controls.proposals.setDeletionExcluded(p1, 0, true), /Only proposed deletions can be excluded/);
        // Edit the new file too, after switching back and forth.
        await controls.proposals.editBeforeApplying(p1, 2);
        const cDoc = await waitUntil(() => copies(p1).find((d) => d.uri.fsPath.endsWith('c.js')), 'c.js copy');
        await setDoc(cDoc, 'export const c = 33;\n');
        await controls.proposals.editBeforeApplying(p1, 0);
        assert.equal(aDoc.getText(), 'export const a = 42; // mine\n');

        // 5./6. The first apply only shows the combined diff; nothing is written.
        assert.equal(await controls.proposals.applyEditedVersion(p1), false);
        const preview = await waitUntil(() => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'visual-agent-edit-preview' && d.uri.path.startsWith(`/${p1}/`)), 'combined diff');
        const combined = preview.getText();
        assert.match(combined, /4 of 5 file\(s\)[\s\S]*1 deletion\(s\) excluded/);
        assert.match(combined, /keep\.js\n\(deletion excluded by you: the file is kept unchanged\)/);
        assert.match(combined, /a\.js \(edited by you\)[\s\S]*\+export const a = 42; \/\/ mine/);
        assert.match(combined, /\+export const b = 2;/);
        assert.match(combined, /new file[\s\S]*\+export const c = 33;/);
        assert.match(combined, /deleted file[\s\S]*-legacy\(\);/);
        assert.equal(state().previewed, true);
        assert.deepEqual([read('a.js'), read('b.js'), read('c.js'), read('old.js')], [A, B, undefined, OLD], 'previewing writes nothing');
        assert.equal(agent.replies.length, 0, 'the agent is still waiting');

        // 7. Conflict: b.js changed on disk after the proposal → nothing is written.
        fs.writeFileSync(file('b.js'), B + '// someone else\n');
        await assert.rejects(controls.proposals.applyEditedVersion(p1), /Not applied: b\.js changed on disk[\s\S]*Nothing was written/);
        assert.deepEqual([read('a.js'), read('c.js'), read('old.js')], [A, undefined, OLD]);
        fs.writeFileSync(file('b.js'), B);

        // 8. A write fails half-way → the files already written are restored.
        controls.proposals.fileStore = { ...originalStore, write: async (abs, text) => { if (abs.endsWith('c.js')) throw new Error('disk full (injected)'); await originalStore.write(abs, text); } };
        await assert.rejects(controls.proposals.applyEditedVersion(p1), /writing c\.js failed \(disk full \(injected\)\)[\s\S]*restored to its previous content/);
        controls.proposals.fileStore = originalStore;
        assert.deepEqual([read('a.js'), read('b.js'), read('c.js'), read('old.js')], [A, B, undefined, OLD], 'no partial application');
        assert.match(recorder.getOperation(p1)!.history.map((h) => h.note).join(' '), /Your version was not applied: writing c\.js failed/);
        assert.equal(controls.proposals.isEditing(p1), true, 'the edits survive a failed apply');

        // Content changed since the preview → the combined diff is shown again first.
        await setDoc(aDoc, 'export const a = 43; // mine\n');
        assert.equal(await controls.proposals.applyEditedVersion(p1), false, 'changed since the preview: show it again');
        await waitUntil(() => /a = 43/.test(preview.getText()), 'the combined diff refreshed with the new content');
        assert.equal(read('a.js'), A);
        // Explicit approval of exactly what was previewed.
        assert.equal(await controls.proposals.applyEditedVersion(p1), true);
        await waitUntil(() => agent.replies.length === 1, 'agent write declined');
        assert.deepEqual([read('a.js'), read('b.js'), read('c.js'), read('old.js'), read('keep.js')], ['export const a = 43; // mine\n', 'export const b = 2;\n', 'export const c = 33;\n', undefined, KEEP], 'keep.js kept: its deletion was excluded');
        assert.equal(agent.replies[0].decision, 'rejected');
        assert.match(agent.replies[0].reason!, /edited version of the 5 files: a\.js \(\+1 −1, edited by the user\); b\.js \(\+1 −1\); c\.js \(\+1 −0, edited by the user\); old\.js \(deleted as proposed\); keep\.js \(your deletion was NOT applied: the user kept this file; do not delete it\)[\s\S]*do not delete the kept files[\s\S]*Read the latest version of these files/);
        const userOp = recorder.getOperations(taskId).find((o) => o.source === 'user' && o.operationType === 'Edit')!;
        assert.equal(userOp.status, 'Completed');
        assert.equal(userOp.associatedChangeIds?.length, 4);
        assert.match(userOp.description, /You applied your edited version of 4 files \(a\.js, b\.js, c\.js, old\.js; \+3 −3 vs original\); kept keep\.js \(deletion excluded\)/);
        const copyTabs = (op: string) => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath.includes(path.join('proposals', op)));
        await waitUntil(() => !copyTabs(p1).length, 'editable copy tabs closed');
        assert.ok(!fs.existsSync(path.dirname(path.dirname(aDoc.uri.fsPath))), 'editable copies deleted');

        // The agent cannot overwrite what the user applied: a stale proposal that reverts the user's a.js
        // and deletes the kept keep.js is blocked BEFORE it is written (b.js, applied unedited, is not protected).
        const stale = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p1 ? id : undefined; }, 'stale proposal');
        const cs = await controls.proposals.check(stale);
        assert.deepEqual(cs.files.map((f) => [f.rel, f.reason]), [['a.js', 'undoes-manual'], ['keep.js', 'undoes-manual']]);
        assert.match(controls.proposals.describe(cs), /a\.js would undo your manual edits \(near line 1: export const a = 43; \/\/ mine\); keep\.js would undo your manual edits \(near line 1: \(the user chose to keep keep\.js/);
        for (let i = 0; i < 3; i++) await controls.runAction('approve', stale);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(agent.replies.length, 1, 'the stale proposal was NOT approved');
        assert.deepEqual([read('a.js'), read('keep.js')], ['export const a = 43; // mine\n', KEEP]);
        assert.match(recorder.getOperation(stale)!.history.map((h) => h.note).join(' '), /Approval blocked: a\.js would undo your manual edits/);
        await assert.rejects(controls.proposals.editBeforeApplying(stale), /Cannot edit: a\.js would undo your manual edits/);
        assert.ok(controller.reject(stale, 'keep my version'));
        await waitUntil(() => agent.replies.length === 2, 'stale proposal rejected');

        // 9. Cancel editing: nothing written, the proposal stays pending; then normal approval still works.
        const p2 = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p1 && id !== stale ? id : undefined; }, 'proposal 2');
        const before2 = [read('a.js'), read('b.js')];
        await controls.proposals.editBeforeApplying(p2);
        const a2 = await waitUntil(() => copies(p2).find((d) => d.uri.fsPath.endsWith('a.js')), 'p2 copy');
        await setDoc(a2, 'garbage\n');
        await controls.runAction('cancelEdit', p2);
        assert.equal(controls.proposals.isEditing(p2), false);
        assert.ok(controller.getSnapshot().pendingApprovals.includes(p2), 'still awaiting a decision');
        assert.deepEqual([read('a.js'), read('b.js')], before2);
        assert.ok(!fs.existsSync(path.dirname(path.dirname(a2.uri.fsPath))), 'copies removed');
        for (let i = 0; i < 4 && agent.replies.length < 3; i++) {
          await controls.runAction('approve', p2); // the first call opens the unseen diffs
          await new Promise((r) => setTimeout(r, 100));
        }
        await waitUntil(() => agent.replies.length === 3, 'p2 approved');
        assert.equal(agent.replies[2].decision, 'approved');
        assert.deepEqual([read('a.js'), read('b.js')], before2.map((t) => t + '// p2\n'), 'the agent applied its own patch after approval');

        // 10. Stopping closes clean copies and leaves unsaved drafts available.
        const p3 = await waitUntil(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p2 ? id : undefined; }, 'proposal 3');
        const before3 = [read('a.js'), read('b.js')];
        await controls.proposals.editBeforeApplying(p3);
        const a3 = await waitUntil(() => copies(p3).find((d) => d.uri.fsPath.endsWith('a.js')), 'p3 copy');
        await setDoc(a3, 'unsaved draft\n');
        controller.stop();
        await controller.whenIdle();
        await waitUntil(() => !controls.proposals.isEditing(p3) && copyTabs(p3).length === 1, 'only the dirty draft remains open');
        assert.equal(a3.isDirty, true);
        assert.equal(a3.getText(), 'unsaved draft\n');
        assert.ok(fs.existsSync(a3.uri.fsPath), 'draft backing file retained');
        assert.deepEqual([read('a.js'), read('b.js')], before3);
        assert.equal(agent.replies[3].decision, 'cancelled');
        assert.equal(recorder.getOperations(taskId).filter((o) => o.source === 'user').length, 1, 'only the one applied user version is recorded');
        await a3.save();
      } finally {
        controls.proposals.fileStore = originalStore;
        launcher.models = originalModels;
        launcher.createAdapter = originalCreate;
        if (controller.isActive) {
          controller.stop();
          await controller.whenIdle();
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        if (!process.env.VAW_TEST_TEMP_DIR) fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
  for (const [name, fn] of [...cases, ...v03Cases, ...i18nCases, ...v04Cases, ...v05Cases, ...v05ExplainCases, ...v06Cases, ...v07Cases, ...sessionCases, ...approvalSyncCases, ...multiFileCases]) {
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
  const total = cases.length + v03Cases.length + i18nCases.length + v04Cases.length + v05Cases.length + v05ExplainCases.length + v06Cases.length + v07Cases.length + sessionCases.length + approvalSyncCases.length + multiFileCases.length;
  console.log(`\n${total - failed}/${total} integration tests passed`);
  if (failed) {
    throw new Error(`${failed} integration test(s) failed`);
  }
}
