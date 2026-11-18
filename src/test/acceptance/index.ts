/**
 * REAL-runtime acceptance run (opt-in: `npm run test:acceptance`).
 *
 * Runs in a real VS Code Extension Development Host against a disposable
 * project, with the real OpenCode runtime and a real local Ollama model
 * (VAW_ACCEPT_MODEL, default qwen3:8b). It drives the same panel message
 * handlers and commands the UI uses. Extension guarantees are ASSERTED;
 * model behaviour (what the agent proposes next) is RECORDED as an
 * observation, because a real model is not deterministic.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VisualAgentApi } from '../../extension';
import { ExplainPanel } from '../../reviewer/ExplainPanel';
import { ConversationPanel } from '../../ui/ConversationPanel';

type Row = { step: string; kind: 'check' | 'observation'; ok?: boolean; detail: string };
const rows: Row[] = [];
const check = (step: string, ok: boolean, detail = '') => {
  rows.push({ step, kind: 'check', ok, detail });
  console.log(`  ${ok ? '✔' : '✖'} ${step}${detail ? ` — ${detail}` : ''}`);
};
const observe = (step: string, detail: string) => {
  rows.push({ step, kind: 'observation', detail });
  console.log(`  • ${step}: ${detail}`);
};

async function until<T>(probe: () => T | undefined | false, what: string, ms = 300_000): Promise<T | undefined> {
  const t0 = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - t0 > ms) {
      observe('timeout', what);
      return undefined;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'visual-agent-workspace')!;
  const api = (await ext.activate()) as VisualAgentApi;
  const { launcher, controller, recorder, controls, manual, explainer, reviewer, reviewerController } = api;
  const model = process.env.VAW_ACCEPT_MODEL || 'qwen3:8b';
  const project = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const math = path.join(project, 'math.js');
  const read = () => fs.readFileSync(math, 'utf8');
  const t0 = Date.now();
  try {
    await vscode.workspace.getConfiguration('visualAgent.reviewer').update('model', model, vscode.ConfigurationTarget.Global);
    await reviewer.refreshModels();
    reviewer.selectModel(model);

    // ---------------------------------------------------------- 1. explain this file
    console.log('\n[1] Explain this file (real Ollama)');
    const rec: any = await vscode.commands.executeCommand('visualAgent.explainFile', vscode.Uri.file(math));
    check('explainFile completed', rec?.status === 'done', rec?.error ?? '');
    const titles = (rec?.parts ?? []).flatMap((p: any) => p.sections.map((s: any) => s.title)).filter(Boolean);
    check('explanation has sections (purpose/flow/dependencies/impact requested)', titles.length >= 3, titles.join(' | '));
    check('panel shows the record', ExplainPanel.current?.lastState?.record?.id === rec?.id);
    check('source unchanged by explanation', !vscode.workspace.textDocuments.find((d) => d.uri.fsPath === math)?.isDirty);
    observe('model answer (start)', String(rec?.parts?.[0]?.text ?? '').slice(0, 300).replace(/\n/g, ' ⏎ '));
    ExplainPanel.current?.dispose();

    // ---------------------------------------------------------- 2. real local agent
    console.log('\n[2] Local agent (real OpenCode + Ollama)');
    (launcher as any).confirmLocalResources = async () => true; // the resource dialog is modal; accepted here explicitly
    const taskId = await launcher.start({ provider: 'local', model, profile: 'approved-write', workspaceRoot: project, instructions: 'Read math.js and test.js and summarize them in two sentences. Do not modify anything yet.' });
    check('conversation started', !!taskId);
    if (!taskId) throw new Error('The local agent conversation did not start.');
    await vscode.commands.executeCommand('visualAgent.openConversations', taskId);
    await until(() => controller.getSnapshot().awaitingInput, 'first turn', 300_000);
    let sawGenerating = false;
    const sub = controller.onDidChangeState((s) => {
      if (s.preview) sawGenerating = true;
    });

    await ConversationPanel.receive({ type: 'send', taskId, text: 'In math.js, make divide(a, b) throw new Error("division by zero") when b === 0. Use the edit tool with real newlines. Do not run any commands.' });
    const p1 = await until(() => controller.getSnapshot().awaitingApprovalFor || (controller.getSnapshot().awaitingInput && 'idle'), 'first proposal');
    observe('"Generating; review when complete" state shown before the proposal', String(sawGenerating));
    if (p1 && p1 !== 'idle' && recorder.getOperation(p1)?.operationType === 'Edit') {
      const op = recorder.getOperation(p1)!;
      observe('proposal 1', op.description);
      check('diff snapshot taken, no conflict yet', (await controls.proposals.check(p1)).ok);
      // ---- conflict blocking
      const before = read();
      fs.writeFileSync(math, before + '\n// edited by the user while the proposal was pending\n');
      await ConversationPanel.receive({ type: 'action', action: 'approve', operationId: p1 });
      await new Promise((r) => setTimeout(r, 1500));
      check('conflict: approval blocked, operation still pending', recorder.getOperation(p1)!.status === 'Proposed' && controller.getSnapshot().pendingApprovals.includes(p1));
      check('conflict: user edit not overwritten', read().includes('edited by the user while the proposal was pending'));
      check('conflict reason shown', /changed on disk/.test(controls.proposals.describe(controls.proposals.conflictFor(p1) ?? { ok: true, files: [] })));
      fs.writeFileSync(math, before);
      // ---- regeneration with feedback
      await ConversationPanel.receive({ type: 'regenerate', operationId: p1, feedback: 'Also add a one-line comment above divide explaining the zero check.' });
      check('regenerate: proposal 1 declined with the feedback', recorder.getOperation(p1)!.status === 'Rejected');
      const p2 = await until(() => { const id = controller.getSnapshot().awaitingApprovalFor; return id && id !== p1 ? id : controller.getSnapshot().awaitingInput ? 'idle' : undefined; }, 'regenerated proposal');
      observe('after regenerate', p2 === 'idle' || !p2 ? 'agent ended the turn without a new proposal' : `new proposal: ${recorder.getOperation(p2)!.description}`);
      if (p2 && p2 !== 'idle' && recorder.getOperation(p2)?.operationType === 'Edit' && recorder.getOperation(p2)?.associatedChangeId) {
        // ---- edit before applying
        await ConversationPanel.receive({ type: 'action', action: 'editProposal', operationId: p2 });
        const temp = await until(() => vscode.workspace.textDocuments.find((d) => d.uri.fsPath.includes(path.join('proposals', p2))), 'editable copy', 10_000);
        check('edit-before-apply: editable copy opened, file not written yet', !!temp && read() === before);
        if (temp) {
          const mine = temp.getText() + '\n// reviewed and adjusted by the user\n';
          const e = new vscode.WorkspaceEdit();
          e.replace(temp.uri, new vscode.Range(0, 0, temp.lineCount, 0), mine);
          await vscode.workspace.applyEdit(e);
          await ConversationPanel.receive({ type: 'action', action: 'applyEdited', operationId: p2 });
          check('edit-before-apply: file contains exactly the user version', read() === mine);
          check('edit-before-apply: agent write declined', recorder.getOperation(p2)!.status === 'Rejected');
          check('edit-before-apply: recorded as the user operation', recorder.getOperations(taskId).some((o) => o.source === 'user' && o.status === 'Completed'));
        }
      } else if (p2 && p2 !== 'idle') {
        controller.reject(p2, 'Not this one.');
      }
    } else {
      observe('first proposal', p1 === 'idle' ? 'model ended the turn without proposing an edit' : `non-edit approval: ${p1 && recorder.getOperation(p1)?.description}`);
      if (p1 && p1 !== 'idle') controller.reject(p1, 'Only edits for now.');
    }
    // Decline anything else so the turn can end.
    for (let i = 0; i < 6 && !(await until(() => controller.getSnapshot().awaitingInput || controller.getSnapshot().awaitingApprovalFor, 'turn end', 240_000), controller.getSnapshot().awaitingInput); i++) {
      const id = controller.getSnapshot().awaitingApprovalFor;
      if (id) {
        observe('extra request declined', recorder.getOperation(id)!.description);
        controller.reject(id, 'Stop here for this turn.');
      }
    }
    sub.dispose();

    // ---------------------------------------------------------- 3. continue after manual edits
    console.log('\n[3] Continue from my changes (real agent)');
    observe('tracked baselines', String(manual.tracked(taskId)));
    if (manual.tracked(taskId) && controller.getSnapshot().awaitingInput) {
      const manualLine = '// manual: callers must handle the division-by-zero error';
      fs.writeFileSync(math, read().replace('module.exports', `${manualLine}\nmodule.exports`));
      const changes = await manual.detect(taskId);
      check('manual edit detected against the baseline', changes.length === 1 && changes[0].diff.includes(manualLine));
      await ConversationPanel.receive({ type: 'manual', kind: 'continue', text: 'Add a test in test.js that divide(1, 0) throws, then run node test.js.' });
      check('continue message sent', !!recorder.getTask(taskId)?.messages?.some((m) => m.role === 'user' && /Continue from my changes/.test(m.text) && m.text.includes(manualLine)));
      for (let i = 0; i < 10; i++) {
        const s = await until(() => (controller.getSnapshot().awaitingInput && 'idle') || controller.getSnapshot().awaitingApprovalFor, 'continue turn', 300_000);
        if (!s || s === 'idle') break;
        const op = recorder.getOperation(s)!;
        const c = await controls.proposals.check(s);
        if (!c.ok) {
          observe('pre-write guard blocked', `${op.description}: ${controls.proposals.describe(c)}`);
          await controls.proposals.regenerate(s, `Keep my manual edits (${controls.proposals.describe(c)}).`);
        } else if (op.operationType === 'Edit' || (op.command && /^node\s+test\.js\s*$/.test(op.command.command.trim()))) {
          observe('approved', op.description);
          await ConversationPanel.receive({ type: 'action', action: 'approve', operationId: s });
        } else {
          observe('declined', op.description);
          controller.reject(s, 'Only edits and `node test.js` are allowed.');
        }
      }
      await until(() => !manual.isValidating(taskId), 'validation', 30_000);
      const result = manual.lastResult(taskId);
      check('post-turn preservation check recorded (from the actual files)', !!result, result?.text ?? 'none');
      observe('manual edit still in math.js', String(read().includes(manualLine)));
      observe('preservation result', result ? (result.ok ? 'kept' : 'NOT kept') : 'n/a');
    }

    // ---------------------------------------------------------- 4. command expansion / copy / explanation
    console.log('\n[4] Command details, copy, explain');
    if (controller.isActive) {
      await controller.endSession();
      await controller.whenIdle();
    }
    const cmdOp = recorder.getOperations(taskId).filter((o) => o.command).at(-1);
    if (cmdOp) {
      controls.selectOperation(cmdOp.operationId, { reveal: false });
      const vm = controls.getViewModel();
      const row = vm.operations.find((o) => o.id === cmdOp.operationId)!;
      check('row shows a purpose summary, not the raw command', !!row.cmd && row.cmd.summary.length > 0, `${row.cmd?.summary} · ${row.status}${row.cmd?.duration ? ' · ' + row.cmd.duration : ''}`);
      check('details keep the original command, cwd and exit code', vm.selected?.command?.command === cmdOp.command!.command, `exit ${vm.selected?.command?.exitCode} · cwd ${vm.selected?.command?.workingDirectory}`);
      await controls.copyFromOperation(cmdOp.operationId, 'command');
      const clip = await vscode.env.clipboard.readText();
      observe('clipboard after "Copy command"', clip === cmdOp.command!.command ? 'matches the original command' : clip ? `differs: ${clip.slice(0, 80)}` : 'empty (clipboard not readable in this host)');
      const marker = path.join(project, 'EXPLAIN_MARKER.txt');
      const before = recorder.getOperations(taskId).length;
      const r = await reviewerController.explainCommand(cmdOp.operationId);
      check('explain command completed (real Ollama)', r?.status === 'done', r?.error ?? '');
      check('explain command did not execute anything', !fs.existsSync(marker) && recorder.getOperations(taskId).length === before);
      observe('explanation headings', (r?.text.match(/^#+ .+$/gm) ?? []).join(' | '));
    } else {
      observe('commands', 'the agent ran no command in this session; command checks skipped');
    }
  } catch (err) {
    check('acceptance run', false, (err as Error).stack ?? String(err));
  } finally {
    if (controller.isActive) {
      controller.stop();
      await controller.whenIdle();
    }
    const report = { model, durationSeconds: Math.round((Date.now() - t0) / 1000), rows, finalMath: fs.existsSync(math) ? read() : undefined };
    if (process.env.VAW_ACCEPT_REPORT) fs.writeFileSync(process.env.VAW_ACCEPT_REPORT, JSON.stringify(report, null, 2));
    console.log(`\n${rows.filter((r) => r.kind === 'check' && r.ok).length}/${rows.filter((r) => r.kind === 'check').length} checks passed`);
    void explainer;
  }
  if (rows.some((r) => r.kind === 'check' && !r.ok)) throw new Error('acceptance checks failed');
}
