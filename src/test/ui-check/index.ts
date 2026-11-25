/**
 * Manual UI check (driven from outside with real mouse/keyboard input).
 *
 * Opens a real Extension Development Host with a fixture agent that proposes a
 * 5-file patch, opens the conversation panel, then only OBSERVES: every change
 * of the edit session, the files on disk and the pending approvals is written
 * with a timestamp to $VAW_UI_DIR/state.jsonl, so click → UI-state latency can
 * be measured. Ends when $VAW_UI_DIR/done exists (max 20 min) and writes a
 * final summary. No model is called. Launched by scripts/run-ui-check.js.
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VisualAgentApi } from '../../extension';
import { MultiFileAgent } from '../support/multiFileAgent';
import { ConversationPanel } from '../../ui/ConversationPanel';

export async function run(): Promise<void> {
  const dir = process.env.VAW_UI_DIR!;
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'visual-agent-workspace')!;
  const api = (await ext.activate()) as VisualAgentApi;
  const { launcher, controller, controls, recorder } = api;
  const project = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const read = (rel: string) => (fs.existsSync(path.join(project, rel)) ? fs.readFileSync(path.join(project, rel), 'utf8') : null);
  const agent = new MultiFileAgent(project, [
    [
      { rel: 'src/math.js', kind: 'update', after: (s) => s.replace('return a / b;', 'if (b === 0) throw new Error("division by zero");\n  return a / b;') },
      { rel: 'src/format.js', kind: 'update', after: (s) => s.replace("toFixed(2)", "toFixed(3)") },
      { rel: 'src/strings.js', kind: 'update', after: (s) => s + "export const trim = (s) => s.trim();\n" },
      { rel: 'docs/CHANGES.md', kind: 'add', after: () => '# Changes\n\n- divide guards against zero\n' },
      { rel: 'legacy.js', kind: 'delete' },
    ],
  ]);
  // VAW_UI_AGENT=codex | opencode: a REAL agent session (the user's Codex login / local Ollama) instead of the fixture.
  const real = process.env.VAW_UI_AGENT;
  const instructions =
    'Read src/math.js, src/format.js, src/strings.js and legacy.js one by one. Then, using your file edit / patch tool (not a shell command), ' +
    'change divide in src/math.js so that it throws new Error("division by zero") when b === 0. Make no other change and run no commands.';
  const codexInstructions =
    'Read src/math.js, src/format.js, src/strings.js and legacy.js with shell commands (one read-only command per file; each needs approval). ' +
    'Then, using your apply_patch tool (not a shell command), change divide in src/math.js so that it throws new Error("division by zero") when b === 0. Make no other change.';
  if (real === 'codex' || real === 'opencode') {
    (launcher as any).confirmLocalResources = async () => true; // the resource dialog is modal; this check is about the UI
    const provider = real === 'codex' ? 'codex' : 'local';
    const models = await launcher.models(provider, project);
    const model = real === 'codex' ? (models.find((m) => m.isDefault && m.compatible) ?? models.find((m) => m.compatible))! : models.find((m) => m.id === (process.env.VAW_UI_MODEL || 'qwen3:8b'))!;
    await launcher.start({ provider, model: model.id, effort: model.efforts?.includes('low') ? 'low' : model.defaultEffort, profile: real === 'codex' ? 'approve-edits' : 'approved-write', workspaceRoot: project, instructions: real === 'codex' ? codexInstructions : instructions });
  } else {
    launcher.models = async () => [{ id: 'fixture', label: 'fixture', compatible: true }];
    launcher.createAdapter = () => agent;
    await launcher.start({ provider: 'local', model: 'fixture', profile: 'approved-write', workspaceRoot: project, instructions: 'Guard divide and tidy helpers (fixture agent, no model)' });
  }
  const startedTask = controller.getSnapshot().taskId!;
  const op = await new Promise<string | undefined>((resolve) => {
    const t = setInterval(() => {
      const snap = controller.getSnapshot();
      const id = snap.awaitingApprovalFor;
      if (id) { clearInterval(t); resolve(id); }
      else if (!controller.isActive || snap.awaitingInput) { clearInterval(t); resolve(undefined); }
    }, 50);
  });
  if (!op) {
    // The agent finished its turn without asking for anything: record what it did and stop.
    const ops = recorder.getOperations(startedTask).map((o) => `#${o.sequenceNumber} ${o.operationType} ${o.status} ${o.description} | ${(o.resultSummary ?? '').slice(0, 300)}`);
    fs.writeFileSync(path.join(dir, 'no-approval.txt'), ops.join('\n'));
    console.log('UI check: the agent asked for no approval; operations written to no-approval.txt');
    if (controller.isActive) { await controller.endSession().catch(() => undefined); if (controller.isActive) controller.stop(); await controller.whenIdle(); }
    return;
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('visualAgent.openConversations', recorder.getOperation(op)!.taskId);
  await vscode.commands.executeCommand('visualAgent.activity.focus'); // Agent Activity in the side bar, beside the conversation
  const files = ['src/math.js', 'src/format.js', 'src/strings.js', 'docs/CHANGES.md', 'legacy.js'];
  const initial = Object.fromEntries(files.map((f) => [f, read(f)]));
  const out = path.join(dir, 'state.jsonl');
  let last = '';
  const snapshot = () => {
    const edit = controls.proposals.editState(op);
    const editors = vscode.window.visibleTextEditors.map((e) => path.basename(e.document.uri.fsPath));
    const vm = controls.getViewModel();
    const s = {
      notices: controls.openApprovalNotices(),
      pendingAll: controller.getSnapshot().pendingApprovals,
      focusId: vm.focusId,
      taskStatus: controller.getSnapshot().taskStatus,
      awaitingInput: controller.getSnapshot().awaitingInput,
      ops: vm.operations.map((o) => `${o.seq}:${o.type}:${o.status}${o.awaitingApproval ? ':WAIT' : ''}`).join(' '),
      editing: !!edit,
      files: edit?.files.map((f) => `${f.rel}${f.active ? '*' : ''}${f.edited ? ' edited' : ''}${f.excluded ? ' kept' : ''}`),
      previewed: edit?.previewed,
      pending: controller.getSnapshot().pendingApprovals.includes(op),
      reply: agent.replies[0]?.decision,
      disk: Object.fromEntries(files.map((f) => [f, read(f) === initial[f] ? 'unchanged' : read(f) === null ? 'deleted' : 'changed'])),
      editors,
      preview: vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'visual-agent-edit-preview'),
    };
    const key = JSON.stringify(s);
    if (key !== last) {
      last = key;
      fs.appendFileSync(out, JSON.stringify({ t: Date.now(), ...s }) + '\n');
    }
  };
  fs.writeFileSync(path.join(dir, 'ready'), JSON.stringify({ op, title: path.basename(project) }));
  console.log(`UI check ready: proposal ${op}. Drive the window, then create ${path.join(dir, 'done')}.`);
  const deadline = Date.now() + 20 * 60_000;
  while (!fs.existsSync(path.join(dir, 'done')) && Date.now() < deadline) {
    // Test-only control channel: exercise the same handlers used by panel buttons.
    const actionFile = path.join(dir, 'action.json');
    if (fs.existsSync(actionFile)) {
      const action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
      fs.unlinkSync(actionFile);
      try {
        const id = controller.getSnapshot().awaitingApprovalFor;
        if (action.kind === 'review' && id) await controls.runAction('review', id);
        else if (action.kind === 'approve' && id) await ConversationPanel.receive({ type: 'action', action: 'approve', operationId: id });
        else if (action.kind === 'reject' && id) controller.reject(id, 'UI acceptance: decline this proposal');
        else if (action.kind === 'stop') controller.stop();
        else if (action.kind === 'followOff') await controls.setFollow(false);
        else if (action.kind === 'expand' && typeof action.id === 'string') controls.setExpanded(action.id);
        fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify({ ...action, id, t: Date.now() }) + '\n');
      } catch (error) { fs.appendFileSync(path.join(dir, 'actions.jsonl'), JSON.stringify({ ...action, error: String(error) }) + '\n'); }
    }
    snapshot();
    await new Promise((r) => setTimeout(r, 25));
  }
  snapshot();
  const summary = {
    disk: Object.fromEntries(files.map((f) => [f, read(f)])),
    agentReply: agent.replies[0],
    userOps: recorder.getOperations(recorder.getOperation(op)!.taskId).filter((o) => o.source === 'user').map((o) => o.description),
    notes: recorder.getOperation(op)!.history.map((h) => h.note).filter(Boolean),
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (controller.isActive) {
    controller.stop();
    await controller.whenIdle();
  }
  // Capture settled cancellation/notification state, not the instant before stop was processed.
  await new Promise((resolve) => setTimeout(resolve, 200));
  snapshot();
}
