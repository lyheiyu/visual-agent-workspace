/**
 * REAL Codex end-to-end tests. Runs inside an Extension Development Host whose
 * workspace is a DISPOSABLE git repository created by
 * scripts/run-codex-integration.js. Uses the developer's Codex login/quota.
 *
 * VAW_CODEX_SUITE = "readonly" (default) | "edits" | "all"
 */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VisualAgentApi } from '../../extension';
import type { AgentOperation } from '../../types/events';

type Case = [string, 'readonly' | 'edits', (api: VisualAgentApi) => Promise<void>];
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
  await waitUntil(() => !api.controller.isActive, 'task end');
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
];

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
