import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentController, ControllerSnapshot, SessionEvent } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { CodexAppServerAdapter } from '../adapters/codex/CodexAppServerAdapter';
import { CodexRpcClient } from '../adapters/codex/CodexRpcClient';
import { getProfile } from '../adapters/codex/profiles';
import { ClaudeCodeAdapter, SdkQueryFn } from '../agents/claude/ClaudeCodeAdapter';
import { SessionContextTracker, commandPaths } from '../agents/sessionContext';
import { commandItem, FakeCodexServer, fileChangeItem } from './support/fakeCodex';

const temps: string[] = [];
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function project(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-cont-'));
  temps.push(d);
  fs.writeFileSync(path.join(d, 'math.js'), 'function divide(a, b) {\n  return a / b;\n}\n');
  fs.writeFileSync(path.join(d, 'validation.py'), 'def validate():\n    pass\n');
  return d;
}

function waitFor(c: AgentController, p: (s: ControllerSnapshot) => boolean): Promise<ControllerSnapshot> {
  return new Promise((resolve) => {
    if (p(c.getSnapshot())) return resolve(c.getSnapshot());
    const sub = c.onDidChangeState((s) => {
      if (p(s)) {
        sub.dispose();
        resolve(s);
      }
    });
  });
}

function codexSetup(root: string, server: FakeCodexServer, opts: Record<string, unknown> = {}) {
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, { stepDelayMs: () => 0, workspaceRoot: () => root });
  const events: SessionEvent[] = [];
  controller.onDidSessionEvent((e) => events.push(e));
  const tracker = new SessionContextTracker(recorder);
  controller.onDidSessionEvent((e) => (e.kind === 'session' ? tracker.noteSession(e.taskId, e.session) : e.kind === 'usage' ? tracker.noteUsage(e.taskId, e.usage) : tracker.noteNativeTurn(e.taskId)));
  const adapter = () => new CodexAppServerAdapter({ connector: () => new CodexRpcClient(server), profile: getProfile('approve-edits'), ...opts });
  return { recorder, controller, events, tracker, adapter };
}

const turnTexts = (s: FakeCodexServer) => s.received.filter((m) => m.method === 'turn/start').map((m) => m.params.input[0].text as string);

// ---------------------------------------------------------------- Test A: native multi-turn continuity

test('Codex: inspect → modify → explain run as three turns of ONE native thread, without replaying history', async () => {
  const root = project();
  const server = new FakeCodexServer();
  let turn = 0;
  server.handlers['turn/start'] = () => {
    turn++;
    server.turnId = `turn-${turn}`;
    setTimeout(() => {
      if (turn === 1) {
        server.itemStarted(commandItem(root, { command: 'Get-Content math.js', commandActions: [{ type: 'read', command: 'Get-Content math.js', name: 'math.js', path: 'math.js' }] }));
        server.itemCompleted(commandItem(root, { status: 'completed', exitCode: 0, aggregatedOutput: 'function divide', commandActions: [{ type: 'read', command: 'Get-Content math.js', name: 'math.js', path: 'math.js' }] }));
      }
      server.notify('thread/tokenUsage/updated', { threadId: server.threadId, turnId: server.turnId, tokenUsage: { last: { inputTokens: 1000 * turn, cachedInputTokens: 800 * (turn - 1), outputTokens: 50, totalTokens: 1050 }, total: {} } });
      server.itemCompleted({ type: 'agentMessage', id: `m${turn}`, text: `answer ${turn}` });
      server.completeTurn('completed');
    }, 0);
    return { turn: { id: server.turnId, status: 'inProgress', items: [], error: null } };
  };
  const { recorder, controller, events, tracker, adapter } = codexSetup(root, server);
  const taskId = controller.start('Inspect divide in math.js', adapter());
  await waitFor(controller, (s) => s.awaitingInput);
  await controller.steer('Make divide throw on b === 0');
  await waitFor(controller, (s) => s.awaitingInput && turn === 2);
  await controller.steer('Why did you change it that way?');
  await waitFor(controller, (s) => s.awaitingInput && turn === 3);
  assert.equal(server.sentMethods().filter((m) => m === 'thread/start').length, 1, 'one native thread');
  assert.equal(server.sentMethods().filter((m) => m === 'turn/start').length, 3, 'three turns in it');
  assert.ok(server.received.filter((m) => m.method === 'turn/start').every((m) => m.params.threadId === 'thr-1'));
  assert.deepEqual(turnTexts(server), ['Inspect divide in math.js', 'Make divide throw on b === 0', 'Why did you change it that way?'], 'follow-ups are sent as-is: no saved-conversation replay');
  assert.equal(recorder.getTask(taskId)!.session?.id, 'thr-1');
  assert.equal(recorder.getTask(taskId)!.session?.continuity, 'new');
  const m = tracker.metrics(taskId);
  assert.deepEqual([m.threadsStarted, m.threadsResumed, m.nativeTurns, m.reconstructed], [1, 0, 2, 0]);
  assert.equal(m.reads, 1);
  assert.equal(m.usageReports, 3, 'provider-reported tokens recorded per turn');
  assert.ok(events.some((e) => e.kind === 'usage'));
  assert.equal(recorder.getTask(taskId)!.turns?.length, 3);
  await controller.endSession();
  await controller.whenIdle();
  assert.equal(recorder.getTask(taskId)!.status, 'Completed');
});

// ---------------------------------------------------------------- Test D: restart → resume, or safe fallback

test('Codex: a new session resumes the stored thread (thread/resume) — no thread/start, no replay', async () => {
  const root = project();
  const server = new FakeCodexServer();
  server.threadId = 'thr-old';
  server.handlers['thread/resume'] = (p) => ({ thread: { id: p.threadId }, model: 'fake-model', cwd: root, approvalPolicy: p.approvalPolicy, sandbox: { type: 'readOnly' } });
  const { recorder, controller, adapter } = codexSetup(root, server, { resumeThreadId: 'thr-old', reconstructedContext: () => 'SUMMARY ' });
  const taskId = controller.start('And now add a test', adapter());
  await waitFor(controller, (s) => s.awaitingInput);
  assert.deepEqual(server.sentMethods(), ['initialize', 'initialized', 'model/list', 'thread/resume', 'turn/start']);
  assert.equal(server.received.find((m) => m.method === 'thread/resume')!.params.threadId, 'thr-old');
  assert.deepEqual(turnTexts(server), ['And now add a test'], 'no summary when the native thread is back');
  assert.deepEqual(recorder.getTask(taskId)!.session, { provider: 'codex', id: 'thr-old', continuity: 'resumed' });
  assert.match(recorder.getOperations(taskId)[0].description, /Codex thread resumed \(native context kept\)/);
  await controller.endSession();
  await controller.whenIdle();
});

test('Codex: if the thread cannot be resumed (gone, another project, another model), a NEW thread gets a short labelled summary', async () => {
  let lastRoot = '';
  for (const [label, resume] of [
    ['gone', () => Promise.reject(Object.assign(new Error('thread not found: thr-old'), { code: -32600 }))],
    ['other project', () => ({ thread: { id: 'thr-old' }, model: 'fake-model', cwd: path.join(os.tmpdir(), 'elsewhere'), approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } })],
    // The model changed under the conversation (Codex reports another model for the thread): never continue silently.
    ['other model', () => ({ thread: { id: 'thr-old' }, model: 'other-model', cwd: lastRoot, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } })],
  ] as const) {
    const root = (lastRoot = project());
    const server = new FakeCodexServer();
    server.threadId = 'thr-new';
    server.handlers['thread/resume'] = resume as any;
    const { recorder, controller, tracker, adapter } = codexSetup(root, server, { model: 'fake-model', resumeThreadId: 'thr-old', reconstructedContext: (why?: string) => `[Reconstructed context: ${why}]\n` });
    const taskId = controller.start('Continue', adapter());
    await waitFor(controller, (s) => s.awaitingInput);
    assert.deepEqual(server.sentMethods().filter((m) => m.startsWith('thread/') || m === 'turn/start').slice(0, 3), ['thread/resume', 'thread/start', 'turn/start'], label);
    assert.match(turnTexts(server)[0], /^\[Reconstructed context: .*(thread not found|another project|runs model other-model, not fake-model).*\]\nContinue$/, label);
    const s = recorder.getTask(taskId)!.session!;
    assert.equal(s.id, 'thr-new');
    assert.equal(s.continuity, 'reconstructed', 'clearly recorded as reconstructed, not native');
    assert.match(s.recoveryReason!, /thread not found|another project|runs model other-model/);
    assert.ok(server.received.filter((m) => m.method === 'turn/start').every((m) => m.params.threadId === 'thr-new'), `${label}: nothing sent to the old thread`);
    assert.equal(tracker.metrics(taskId).reconstructed, 1);
    await controller.endSession();
    await controller.whenIdle();
  }
});

// ---------------------------------------------------------------- Test F: approval safety across turns / resume

test('Codex: thread reuse and resume never repeat approvals, commands or edits on their own', async () => {
  const root = project();
  const server = new FakeCodexServer();
  let turn = 0;
  const replies: unknown[] = [];
  server.handlers['turn/start'] = () => {
    turn++;
    server.turnId = `turn-${turn}`;
    setTimeout(async () => {
      if (turn === 1) {
        server.itemStarted(fileChangeItem(path.join(root, 'validation.py'), { id: 'p-1' }));
        replies.push((await server.request('item/fileChange/requestApproval', { threadId: server.threadId, turnId: server.turnId, itemId: 'p-1' })).result);
        server.itemCompleted(fileChangeItem(path.join(root, 'validation.py'), { id: 'p-1', status: 'completed' }));
      }
      server.completeTurn('completed');
    }, 0);
    return { turn: { id: server.turnId, status: 'inProgress', items: [], error: null } };
  };
  const { recorder, controller, adapter } = codexSetup(root, server);
  const taskId = controller.start('Patch validation.py', adapter());
  const pending = await waitFor(controller, (s) => !!s.awaitingApprovalFor);
  controller.approve(pending.awaitingApprovalFor!);
  await waitFor(controller, (s) => s.awaitingInput && turn === 1);
  await controller.steer('Thanks, explain it');
  await waitFor(controller, (s) => s.awaitingInput && turn === 2);
  assert.equal(replies.length, 1, 'one approval request, answered once');
  const edits = recorder.getOperations(taskId).filter((o) => o.operationType === 'Edit');
  assert.equal(edits.length, 1, 'no duplicate operation for the same patch');
  assert.equal(server.received.filter((m) => m.id !== undefined && m.method === undefined).length, 1, 'exactly one approval reply sent to Codex');
  await controller.endSession();
  await controller.whenIdle();
});

// ---------------------------------------------------------------- Claude Code

function claudeFake(failResume: boolean) {
  const calls: any[] = [];
  const fn: SdkQueryFn = ({ prompt, options }) => {
    calls.push({ options });
    const it = prompt[Symbol.asyncIterator]();
    return {
      async *[Symbol.asyncIterator]() {
        const first = await it.next();
        calls.push({ prompt: first.value });
        if (options.resume && failResume) throw new Error(`No conversation found with session ID: ${options.resume}`);
        yield { type: 'system', subtype: 'init', model: 'm', session_id: options.resume ?? 'cc-new', cwd: options.cwd, tools: [] };
        yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7 } };
        for (;;) {
          const n = await it.next();
          if (n.done) return;
          calls.push({ prompt: n.value });
          yield { type: 'result', subtype: 'success', is_error: false };
        }
      },
      interrupt: async () => undefined,
      accountInfo: async () => ({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }),
      close: () => undefined,
    } as any;
  };
  return { fn, calls };
}

test('Claude Code: sessions are persisted and resumed natively; a lost session falls back to a labelled new one', async () => {
  for (const failResume of [false, true]) {
    const root = project();
    const fake = claudeFake(failResume);
    const recorder = new EventRecorder();
    const controller = new AgentController(new MockAgentAdapter(), recorder, { stepDelayMs: () => 0, workspaceRoot: () => root });
    const usage: unknown[] = [];
    controller.onDidSessionEvent((e) => e.kind === 'usage' && usage.push(e.usage));
    const adapter = new ClaudeCodeAdapter({ loadQuery: async () => fake.fn, model: 'm', profile: 'read-only', env: { ANTHROPIC_API_KEY: 'k' }, resumeSessionId: 'cc-old', reconstructedContext: (why) => `[Reconstructed context: ${why}]\n` });
    const taskId = controller.start('Next step', adapter);
    await waitFor(controller, (s) => s.awaitingInput);
    const opts = fake.calls.filter((c) => c.options).map((c) => c.options);
    assert.ok(opts.every((o) => o.persistSession === true), 'stored by Claude Code so it can be resumed');
    assert.equal(opts[0].resume, 'cc-old');
    const prompts = fake.calls.filter((c) => c.prompt).map((c) => c.prompt.message.content);
    const s = recorder.getTask(taskId)!.session!;
    if (!failResume) {
      assert.equal(opts.length, 1);
      assert.deepEqual(prompts, ['Next step'], 'no replay when resumed');
      assert.deepEqual([s.id, s.continuity], ['cc-old', 'resumed']);
    } else {
      assert.equal(opts.length, 2, 'one retry without resume');
      assert.equal(opts[1].resume, undefined);
      assert.match(prompts.at(-1), /^\[Reconstructed context: No conversation found with session ID: cc-old\]\nNext step$/);
      assert.deepEqual([s.id, s.continuity], ['cc-new', 'reconstructed']);
    }
    assert.deepEqual(usage[0], { inputTokens: 10, outputTokens: 2, cachedInputTokens: 7 });
    await controller.endSession();
    await controller.whenIdle();
  }
});

// ---------------------------------------------------------------- Tests B/C: change-aware context (tracker)

test('tracker: unchanged files produce no note and no re-read prompt; an external change is reported once; repeated reads and exploration are counted', () => {
  const root = project();
  const recorder = new EventRecorder();
  const tracker = new SessionContextTracker(recorder);
  const task = recorder.startTask({ description: 'Inspect divide', source: 'codex', adapterName: 'Codex', simulated: false, workspaceRoot: root });
  const done = (input: any) => {
    const op = recorder.recordOperation(task.taskId, { source: 'codex', simulated: false, requiresApproval: false, ...input });
    recorder.updateOperation(op.operationId, { status: 'Completed' });
  };
  done({ operationType: 'Read', description: 'List files' });
  done({ operationType: 'Read', description: 'Read AGENTS.md', filePath: 'AGENTS.md' });
  done({ operationType: 'Read', description: 'Read math.js', filePath: 'math.js' });
  assert.equal(tracker.changeNote(task.taskId), '', 'Test B: nothing changed → nothing to re-read');
  done({ operationType: 'Read', description: 'Read math.js', filePath: 'math.js' });
  const m = tracker.metrics(task.taskId);
  assert.deepEqual([m.reads, m.repeatedReads, m.explorations], [3, 1, 2], 'second read of an unchanged file is counted as repeated; listing + AGENTS.md as exploration');
  // Test C: the user edits math.js between turns.
  fs.writeFileSync(path.join(root, 'math.js'), 'function divide(a, b) {\n  // user note\n  return a / b;\n}\n');
  const note = tracker.changeNote(task.taskId);
  assert.match(note, /math\.js \(modified\)/);
  assert.match(note, /Re-read them before relying on earlier content/);
  assert.doesNotMatch(note, /validation\.py/);
  assert.equal(tracker.changeNote(task.taskId), '', 'the same change is reported once');
  // After the agent re-reads it, a later change is reported again.
  done({ operationType: 'Read', description: 'Read math.js', filePath: 'math.js' });
  fs.rmSync(path.join(root, 'math.js'));
  assert.match(tracker.changeNote(task.taskId), /math\.js \(deleted\)/);
  // The agent's own approved edit is not "external".
  done({ operationType: 'Edit', description: 'Edit validation.py', filePath: 'validation.py' });
  assert.equal(tracker.changeNote(task.taskId), '');
});

test('tracker: files seen through shell commands are fingerprinted; a later outside change is reported; the agent\'s own command writes are not', () => {
  const root = project();
  const recorder = new EventRecorder();
  const tracker = new SessionContextTracker(recorder);
  const task = recorder.startTask({ description: 'Inspect', source: 'codex', adapterName: 'Codex', simulated: false, workspaceRoot: root });
  const run = (command: string) => {
    const op = recorder.recordOperation(task.taskId, { source: 'codex', simulated: false, requiresApproval: false, operationType: 'Execute', description: `Run: ${command}`, command: { command, workingDirectory: root, simulated: false, status: 'Completed' } as any });
    recorder.updateOperation(op.operationId, { status: 'Completed' });
  };
  assert.deepEqual(commandPaths(`"C:\\Windows\\powershell.exe" -Command "Get-Content -Raw validation.py"`).includes('validation.py'), true);
  run(`powershell.exe -Command "Get-Content -Raw validation.py"`);
  run('cat math.js | head -n 5');
  run('ls -la src'); // a directory and flags: nothing tracked
  assert.deepEqual(Object.keys(tracker.files(task.taskId)).sort(), ['math.js', 'validation.py']);
  assert.equal(tracker.changeNote(task.taskId), '', 'unchanged → no note');
  fs.appendFileSync(path.join(root, 'validation.py'), '# user note\n');
  assert.match(tracker.changeNote(task.taskId), /validation\.py \(modified\)/);
  // The agent's own write through a command refreshes the fingerprint instead of producing a note.
  run('cat math.js');
  fs.appendFileSync(path.join(root, 'math.js'), '// agent\n');
  run(`sed -i 's/a/b/' math.js`);
  assert.equal(tracker.changeNote(task.taskId), '');
  assert.equal(tracker.files(task.taskId)['math.js'].by, 'agent-edit');
  // Outside the project: ignored.
  run(`cat ${path.join(os.tmpdir(), 'nope.txt')} ../outside.py`);
  assert.equal(Object.keys(tracker.files(task.taskId)).length, 2);
});

test('tracker: the reconstructed summary is short, labelled, lists inspected/changed files and uncertain operations, and replays no full history', () => {
  const root = project();
  const recorder = new EventRecorder();
  const tracker = new SessionContextTracker(recorder);
  const task = recorder.startTask({ description: 'Guard divide', source: 'codex', adapterName: 'Codex', simulated: false, workspaceRoot: root });
  for (let i = 0; i < 40; i++) recorder.recordMessage(task.taskId, i % 2 ? 'assistant' : 'user', `message ${i} ` + 'x'.repeat(3000));
  const read = recorder.recordOperation(task.taskId, { source: 'codex', simulated: false, requiresApproval: false, operationType: 'Read', description: 'Read math.js', filePath: 'math.js' });
  recorder.updateOperation(read.operationId, { status: 'Completed' });
  const edit = recorder.recordOperation(task.taskId, { source: 'codex', simulated: false, requiresApproval: false, operationType: 'Edit', description: 'Edit math.js', filePath: 'math.js' });
  recorder.updateOperation(edit.operationId, { status: 'Completed' });
  recorder.recordOperation(task.taskId, { source: 'codex', simulated: false, requiresApproval: true, operationType: 'Execute', description: 'Run: npm test', command: { command: 'npm test', workingDirectory: root, simulated: false, status: 'Pending' } });
  const text = tracker.reconstructedContext(recorder.getTask(task.taskId)!, recorder.getOperations(task.taskId), 'thread not found');
  assert.ok(text.length < 10_000, `bounded (${text.length} chars)`);
  assert.match(text, /^\[Reconstructed context: the previous native session could not be continued \(thread not found\)/);
  assert.match(text, /Files you changed earlier: math\.js/);
  assert.match(text, /do not re-list the project unless necessary/);
  assert.match(text, /Operations without a confirmed outcome \(do not repeat them automatically[\s\S]*Run: npm test/);
  assert.equal((text.match(/message \d+/g) ?? []).length, 6, 'only the last 6 messages');
  assert.doesNotMatch(text, /Recheck current files/);
});
