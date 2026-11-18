import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentController, ControllerSnapshot } from '../controller/AgentController';
import { EventRecorder } from '../recorder/EventRecorder';
import { MockAgentAdapter } from '../adapters/MockAgentAdapter';
import { OpenCodeAdapter } from '../agents/opencode/OpenCodeAdapter';
import { buildOpenCodeConfig } from '../agents/opencode/OpenCodeServer';
import { ClaudeCodeAdapter, claudeAuthFromEnv, SdkQueryFn } from '../agents/claude/ClaudeCodeAdapter';
import { DESTRUCTIVE_COMMAND, mapToolCall } from '../agents/toolMapping';
import { discoverOllamaCodingModels } from '../agents/providers';
import { ReviewService } from '../reviewer/ReviewService';
import { FakeOpenCode } from './support/fakeOpenCode';
import { localWorkflowPrompt } from '../agents/opencode/localWorkflow';

const MATH = `// Small math helpers.

function add(a, b) {
  return a + b;
}

function divide(a, b) {
  return a / b;
}

module.exports = { add, divide };
`;

const tempDirs: string[] = [];
after(() => tempDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-agents-test-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'math.js'), MATH);
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  return dir;
}

function waitFor(c: AgentController, pred: (s: ControllerSnapshot) => boolean): Promise<ControllerSnapshot> {
  return new Promise((resolve) => {
    if (pred(c.getSnapshot())) return resolve(c.getSnapshot());
    const sub = c.onDidChangeState((s) => {
      if (pred(s)) {
        sub.dispose();
        resolve(s);
      }
    });
  });
}

function setup(root: string) {
  const recorder = new EventRecorder();
  const controller = new AgentController(new MockAgentAdapter(undefined, { durationScale: 0 }), recorder, { stepDelayMs: () => 0, workspaceRoot: () => root });
  return { recorder, controller };
}

// ------------------------------------------------------------------ tool mapping

test('tool mapping: real diff of a proposed edit is computed BEFORE it is applied; function found by parsing', () => {
  const root = workspace();
  const op = mapToolCall({
    tool: 'edit',
    input: { filePath: path.join(root, 'math.js'), oldString: 'function divide(a, b) {\n  return a / b;\n}', newString: 'function divide(a, b) {\n  if (b === 0) {\n    throw new Error("division by zero");\n  }\n  return a / b;\n}' },
    workspaceRoot: root,
  });
  assert.equal(op.operationType, 'Edit');
  assert.equal(op.filePath, 'math.js');
  assert.equal(op.functionName, 'divide');
  assert.match(op.description, /Edit math\.js › divide\(\) \(\+3 −0\)/);
  assert.match(op.changes![0].unifiedDiff, /\+  if \(b === 0\) \{/);
  assert.deepEqual(op.changedRanges, [{ filePath: 'math.js', side: 'new', startLine: 8, endLine: 10 }]);
  assert.equal(fs.readFileSync(path.join(root, 'math.js'), 'utf8'), MATH, 'mapping never writes');

  const bash = mapToolCall({ tool: 'Bash', input: { command: 'node test.js' }, workspaceRoot: root });
  assert.equal(bash.operationType, 'Test');
  assert.equal(bash.command?.command, 'node test.js');
  const rd = mapToolCall({ tool: 'Read', input: { file_path: path.join(root, 'math.js') }, workspaceRoot: root });
  assert.equal(rd.description, 'Read math.js');
  const write = mapToolCall({ tool: 'Write', input: { file_path: path.join(root, 'new.js'), content: 'x\n' }, workspaceRoot: root });
  assert.match(write.description, /Create new\.js \(\+1 −0\)/);
  assert.ok(DESTRUCTIVE_COMMAND.test('rm -rf build'));
  assert.ok(DESTRUCTIVE_COMMAND.test('git reset --hard HEAD~1'));
  assert.ok(DESTRUCTIVE_COMMAND.test('git push origin main'));
  assert.ok(!DESTRUCTIVE_COMMAND.test('node test.js'));
  assert.ok(!DESTRUCTIVE_COMMAND.test('git status'));
});

test('OpenCode config is local-only with runtime-enforced permissions', () => {
  const ro = buildOpenCodeConfig({ ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextLimit: 32768, outputLimit: 8192, profile: 'read-only' }) as any;
  assert.deepEqual(ro.enabled_providers, ['ollama']);
  assert.ok(ro.disabled_providers.includes('opencode'), 'built-in cloud provider disabled');
  assert.equal(ro.model, 'ollama/qwen3:8b');
  assert.equal(ro.small_model, 'ollama/qwen3:8b', 'title/summary model also local');
  assert.equal(ro.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1');
  assert.equal(ro.permission.edit, 'deny');
  assert.equal(ro.permission.bash, 'deny');
  assert.equal(ro.permission.webfetch, 'deny');
  assert.equal(ro.permission.external_directory, 'deny');
  assert.equal(ro.permission.read['*.env'], 'deny');
  assert.equal(ro.permission.read['.git/*'], 'deny');
  const rw = buildOpenCodeConfig({ ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextLimit: 32768, outputLimit: 8192, profile: 'approved-write' }) as any;
  assert.equal(rw.permission.edit['*'], 'ask');
  assert.equal(rw.permission.edit['*.env'], 'deny');
  assert.equal(rw.permission.bash, 'ask');
  assert.equal(rw.permission.task, 'deny');
});

// ------------------------------------------------------------------ OpenCode adapter

function openCode(root: string, fake: FakeOpenCode, profile: 'read-only' | 'approved-write') {
  return new OpenCodeAdapter({
    connector: async () => fake,
    launch: { executable: 'x', homeDir: path.join(root, '.home'), ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', contextLimit: 32768, outputLimit: 8192, profile },
  });
}

test('local agent: read-only analysis — observed reads, answer recorded, session continues with a follow-up, then ends', async () => {
  const root = workspace();
  const fake = new FakeOpenCode();
  fake.turns = [
    async (s) => {
      s.user();
      s.text('prt_u', 'Read math.js…', 'msg_u1'); // user prompt text is not agent output
      s.assistant();
      s.tool('call_r1', 'read', 'pending', {});
      s.tool('call_r1', 'read', 'running', { filePath: path.join(root, 'math.js') });
      s.tool('call_r1', 'read', 'completed', { filePath: path.join(root, 'math.js') }, { output: '<content>…', title: 'math.js', metadata: {} });
      s.text('prt_t1', '`divide(a, b)` returns a / b.');
      s.idle();
    },
    async (s) => {
      s.assistant('msg_a2');
      s.text('prt_t2', 'It does not guard against b === 0.', 'msg_a2');
      s.idle();
    },
  ];
  const { recorder, controller } = setup(root);
  const taskId = controller.start('Explain divide()', openCode(root, fake, 'read-only'));
  await waitFor(controller, (s) => s.awaitingInput);
  assert.equal(controller.getSnapshot().taskStatus, 'Running', 'session stays open after the turn');
  assert.equal(controller.getSnapshot().capabilities.followUp, true);
  await controller.steer('Any edge cases?');
  await waitFor(controller, (s) => s.awaitingInput && recorder.getOperations(taskId).some((o) => /b === 0/.test(o.description)));
  assert.ok(await controller.endSession());
  await controller.whenIdle();

  const ops = recorder.getOperations(taskId);
  assert.match(ops[0].description, /Local agent session started: OpenCode .* \+ Ollama qwen3:8b/);
  const read = ops.find((o) => o.operationType === 'Read')!;
  assert.equal(read.filePath, 'math.js');
  assert.equal(read.enforcement, 'none', 'reads are observed only');
  assert.equal(read.status, 'Completed');
  assert.ok(ops.some((o) => o.description === 'Local agent: `divide(a, b)` returns a / b.'));
  assert.ok(!ops.some((o) => /Read math\.js…/.test(o.description)), 'user prompt not recorded as agent output');
  assert.equal(ops.filter((o) => o.operationType === 'Instruct').length, 1);
  assert.equal(fake.requests.filter((r) => r.route.endsWith('/prompt_async')).length, 2, 'follow-up used the SAME session');
  assert.ok(fake.requests.every((r) => !r.route.includes('/prompt_async') || r.route.includes(fake.sessionId)));
  const body = fake.requests.find((r) => r.route.endsWith('/prompt_async'))!.body;
  assert.deepEqual(body.model, { providerID: 'ollama', modelID: 'qwen3:8b' });
  assert.equal(body.system, localWorkflowPrompt('read-only', 'plan-files', root));
  assert.ok(body.system.includes(JSON.stringify(root)), 'actual selected workspace is supplied to the model');
  const prompts = fake.requests.filter((r) => r.route.endsWith('/prompt_async'));
  assert.equal(prompts[1].body.system, body.system, 'follow-up retains workflow without an extra planning request');
  assert.equal(body.parts[0].text, 'Explain divide()');
  assert.equal(prompts[1].body.parts[0].text, 'Any edge cases?');
  assert.equal(recorder.getTask(taskId)!.status, 'Completed');
  assert.deepEqual(recorder.getTask(taskId)!.messages?.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Explain divide()' },
    { role: 'assistant', text: '`divide(a, b)` returns a / b.' },
    { role: 'user', text: 'Any edge cases?' },
    { role: 'assistant', text: 'It does not guard against b === 0.' },
  ], 'saved conversation includes both turns, without tool output or duplicate user events');
  assert.ok(fake.closed);
});

test('local agent: edit is blocked until approved (diff shown first); test command approved; real exit code recorded', async () => {
  const root = workspace();
  const fake = new FakeOpenCode();
  let editReply = '';
  let bashReply = '';
  const newDivide = 'function divide(a, b) {\n  if (b === 0) {\n    throw new Error("division by zero");\n  }\n  return a / b;\n}';
  fake.turns = [
    async (s) => {
      s.assistant();
      const input = { filePath: path.join(root, 'math.js'), oldString: 'function divide(a, b) {\n  return a / b;\n}', newString: newDivide };
      s.tool('call_e1', 'edit', 'pending', {});
      s.tool('call_e1', 'edit', 'running', input);
      editReply = await s.permission('per_e1', 'edit', 'call_e1', { filepath: path.join(root, 'math.js'), diff: 'Index: x\n===\n@@ -7,3 +7,6 @@\n function divide(a, b) {\n+  if (b === 0) {\n+    throw new Error("division by zero");\n+  }\n   return a / b;\n }\n' }, ['math.js']);
      s.tool('call_e1', 'edit', 'completed', input, { output: 'Edit applied successfully.', title: 'math.js', metadata: {} });
      s.tool('call_b1', 'bash', 'pending', {});
      s.tool('call_b1', 'bash', 'running', { command: 'node test.js', workdir: root });
      bashReply = await s.permission('per_b1', 'bash', 'call_b1', { command: 'node test.js' }, ['node test.js']);
      s.tool('call_b1', 'bash', 'completed', { command: 'node test.js' }, { output: 'all tests passed\n', title: 'node test.js', metadata: { output: 'all tests passed\n', exit: 0 } });
      s.idle();
    },
  ];
  const { recorder, controller } = setup(root);
  const taskId = controller.start('Make divide throw on zero, then run node test.js', openCode(root, fake, 'approved-write'));

  let snap = await waitFor(controller, (s) => !!s.awaitingApprovalFor);
  const edit = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(edit.operationType, 'Edit');
  assert.equal(edit.status, 'Proposed', 'blocked, not running');
  assert.equal(edit.enforcement, 'agent-approval');
  assert.equal(edit.functionName, 'divide');
  assert.deepEqual(edit.affectedFunctions?.map((f) => f.name), ['divide']);
  assert.equal(editReply, '', 'OpenCode is still waiting');
  controller.approve(edit.operationId);

  snap = await waitFor(controller, (s) => !!s.awaitingApprovalFor && s.awaitingApprovalFor !== edit.operationId);
  const run = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(run.operationType, 'Test');
  assert.equal(run.command?.command, 'node test.js');
  controller.approve(run.operationId);
  await waitFor(controller, (s) => s.awaitingInput);
  await controller.endSession();
  await controller.whenIdle();

  assert.equal(editReply, 'once');
  assert.equal(bashReply, 'once');
  const ops = recorder.getOperations(taskId);
  assert.equal(ops.find((o) => o.operationId === edit.operationId)!.status, 'Completed');
  const ran = ops.find((o) => o.operationId === run.operationId)!;
  assert.equal(ran.status, 'Completed');
  assert.equal(ran.command?.exitCode, 0);
  assert.equal(ran.command?.stdout, 'all tests passed\n');
});

test('local agent: rejection, protected files, read-only auto-deny, destructive warning, and Stop', async () => {
  const root = workspace();
  const fake = new FakeOpenCode();
  const replies: string[] = [];
  fake.turns = [
    async (s) => {
      s.assistant();
      s.tool('call_env', 'edit', 'running', { filePath: path.join(root, '.env'), oldString: 'SECRET=1', newString: 'SECRET=2' });
      replies.push(await s.permission('per_env', 'edit', 'call_env', { filepath: path.join(root, '.env'), diff: '' }));
      s.tool('call_out', 'edit', 'running', { filePath: path.join(root, '..', 'outside.js'), oldString: '', newString: 'x' });
      replies.push(await s.permission('per_out', 'edit', 'call_out', { filepath: path.join(root, '..', 'outside.js'), diff: '' }));
      s.tool('call_web', 'webfetch', 'running', { url: 'https://example.com' });
      replies.push(await s.permission('per_web', 'webfetch', 'call_web', { url: 'https://example.com' }));
      s.tool('call_rm', 'bash', 'running', { command: 'rm -rf build' });
      replies.push(await s.permission('per_rm', 'bash', 'call_rm', { command: 'rm -rf build' }));
      s.tool('call_rm', 'bash', 'error', { command: 'rm -rf build' }, { error: 'The user rejected permission to use this specific tool call.' });
      s.tool('call_t', 'bash', 'running', { command: 'node test.js' });
      replies.push(await s.permission('per_t', 'bash', 'call_t', { command: 'node test.js' }));
    },
  ];
  const { recorder, controller } = setup(root);
  const taskId = controller.start('x', openCode(root, fake, 'approved-write'));
  let snap = await waitFor(controller, (s) => !!s.awaitingApprovalFor);
  const rm = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(rm.command?.command, 'rm -rf build');
  assert.match(rm.history.map((h) => h.note).join(' '), /potentially destructive/);
  controller.reject(rm.operationId, 'no deletions');
  snap = await waitFor(controller, (s) => !!s.awaitingApprovalFor && s.awaitingApprovalFor !== rm.operationId);
  assert.ok(controller.stop());
  await controller.whenIdle();
  assert.deepEqual(replies, ['reject', 'reject', 'reject', 'reject', 'reject']);
  assert.ok(fake.aborted, 'Stop aborted the OpenCode turn');
  const ops = recorder.getOperations(taskId);
  assert.match(ops.find((o) => o.externalId === 'call_env')!.history.at(-1)!.note!, /protected file: \.env/);
  assert.match(ops.find((o) => o.externalId === 'call_out')!.history.at(-1)!.note!, /outside the workspace/);
  assert.match(ops.find((o) => o.externalId === 'call_web')!.history.at(-1)!.note!, /not granted/);
  assert.equal(ops.find((o) => o.externalId === 'call_rm')!.status, 'Rejected');
  assert.equal(recorder.getTask(taskId)!.status, 'Stopped');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'SECRET=1\n');

  // read-only profile: any permission request is denied without asking.
  const fake2 = new FakeOpenCode();
  let ro = '';
  fake2.turns = [
    async (s) => {
      s.tool('call_x', 'bash', 'running', { command: 'ls' });
      ro = await s.permission('per_x', 'bash', 'call_x', { command: 'ls' });
      s.idle();
    },
  ];
  const t2 = setup(root);
  t2.controller.start('x', openCode(root, fake2, 'read-only'));
  await waitFor(t2.controller, (s) => s.awaitingInput);
  assert.equal(ro, 'reject');
  assert.equal(t2.controller.getSnapshot().pendingApprovals.length, 0);
  t2.controller.stop();
  await t2.controller.whenIdle();
});

test('local agent: replies from a different provider/model abort the task (no silent substitution)', async () => {
  const root = workspace();
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => s.assistant('msg_x', 'big-pickle', 'opencode')];
  const { recorder, controller } = setup(root);
  const taskId = controller.start('x', openCode(root, fake, 'read-only'));
  await controller.whenIdle();
  assert.equal(recorder.getTask(taskId)!.status, 'Failed');
  assert.match(recorder.getTask(taskId)!.summary!, /opencode\/big-pickle instead of ollama\/qwen3:8b/);
});

test('local agent: server crash fails the task', async () => {
  const root = workspace();
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => s.crash()];
  const { recorder, controller } = setup(root);
  const taskId = controller.start('x', openCode(root, fake, 'read-only'));
  await controller.whenIdle();
  assert.equal(recorder.getTask(taskId)!.status, 'Failed');
});

// ------------------------------------------------------------------ Claude Code adapter (contract)

/** Fake Agent SDK query(): yields messages shaped like the SDK's SDKMessage union and calls canUseTool like Claude Code does. */
function fakeQuery(script: (opts: any, push: (m: any) => void) => Promise<void>, account: { apiKeySource?: string; apiProvider?: string; tokenSource?: string; subscriptionType?: string } = { apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }): { fn: SdkQueryFn; calls: any[]; interrupted: () => boolean } {
  const calls: any[] = [];
  let interrupted = false;
  const fn: SdkQueryFn = ({ prompt, options }) => {
    calls.push(options);
    const queue: any[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (m: any) => {
      queue.push(m);
      wake?.();
    };
    void (async () => {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      calls.push({ prompt: first.value });
      await script(options, push);
      for (;;) {
        const n = await it.next();
        if (n.done) break;
        calls.push({ prompt: n.value });
        push({ type: 'assistant', message: { content: [{ type: 'text', text: `follow-up: ${n.value.message.content}` }] } });
        push({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 5 });
      }
      done = true;
      wake?.();
    })();
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) {
            yield queue.shift();
            continue;
          }
          if (done) return;
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      },
      interrupt: async () => {
        interrupted = true;
      },
      accountInfo: async () => account,
      close: () => undefined,
    } as any;
  };
  return { fn, calls, interrupted: () => interrupted };
}

test('Claude Code: auth detection supports official subscription login, API keys and cloud providers', () => {
  assert.equal(claudeAuthFromEnv({}).ok, false);
  assert.match(claudeAuthFromEnv({}).reason!, /Sign in through official Claude Code/);
  assert.equal(claudeAuthFromEnv({}, { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }).kind, 'subscription');
  assert.equal(claudeAuthFromEnv({ ANTHROPIC_API_KEY: 'x' }).ok, true);
  assert.equal(claudeAuthFromEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }).method, 'Amazon Bedrock');
});

test('Claude Code (fixture): options isolate settings; canUseTool blocks edits until approved; follow-up continues the session', async () => {
  const root = workspace();
  let decision: any;
  const q = fakeQuery(async (opts, push) => {
    push({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', claude_code_version: '2.x', tools: ['Read', 'Edit', 'Bash'], session_id: 'cc1' });
    push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: path.join(root, 'math.js') } }] } });
    push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: MATH }] } });
    const input = { file_path: path.join(root, 'math.js'), old_string: 'return a / b;', new_string: 'if (b === 0) throw new Error("division by zero");\n  return a / b;' };
    push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_edit', name: 'Edit', input }] } });
    await new Promise((r) => setTimeout(r, 10)); // the SDK streams messages before asking for permission
    decision = await opts.canUseTool('Edit', input, { signal: new AbortController().signal, toolUseID: 'tu_edit' });
    push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'ok' }] } });
    push({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0.01 });
  });
  const adapter = new ClaudeCodeAdapter({ loadQuery: async () => q.fn, model: 'claude-sonnet-5-5', effort: 'medium', profile: 'approved-write', env: { ANTHROPIC_API_KEY: 'test' } });
  const { recorder, controller } = setup(root);
  const taskId = controller.start('Fix divide', adapter);
  const snap = await waitFor(controller, (s) => !!s.awaitingApprovalFor);
  const edit = recorder.getOperation(snap.awaitingApprovalFor!)!;
  assert.equal(edit.functionName, 'divide');
  assert.equal(edit.enforcement, 'agent-approval');
  assert.equal(decision, undefined, 'Claude Code is blocked in canUseTool');
  controller.approve(edit.operationId);
  await waitFor(controller, (s) => s.awaitingInput);
  assert.equal((decision as { behavior?: string } | undefined)?.behavior, 'allow');
  await controller.steer('and add a test');
  await waitFor(controller, (s) => s.awaitingInput && recorder.getOperations(taskId).some((o) => /follow-up: and add a test/.test(o.description)));
  await controller.endSession();
  await controller.whenIdle();

  const opts = q.calls[0];
  assert.equal(opts.model, 'claude-sonnet-5-5');
  assert.equal(opts.effort, 'medium');
  assert.equal(opts.permissionMode, 'default');
  assert.deepEqual(opts.settingSources, [], 'user/project settings are not loaded or changed');
  assert.ok(opts.disallowedTools.includes('WebFetch'));
  assert.equal(opts.cwd, root);
  const ops = recorder.getOperations(taskId);
  assert.ok(ops.some((o) => /Claude Code session started: claude-sonnet-5-5/.test(o.description)));
  assert.equal(ops.find((o) => o.externalId === 'tu_read')!.enforcement, 'none');
  assert.equal(recorder.getTask(taskId)!.status, 'Completed');
});

test('Claude Code (fixture): permissions enforced; a different billing mode is refused before prompting', async () => {
  const root = workspace();
  const results: any[] = [];
  const q = fakeQuery(async (opts, push) => {
    push({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', session_id: 'cc2', tools: [] });
    await new Promise((r) => setTimeout(r, 10));
    results.push(await opts.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'b1' }));
    results.push(await opts.canUseTool('Read', { file_path: path.join(root, '.env') }, { signal: new AbortController().signal, toolUseID: 'r1' }));
    push({ type: 'result', subtype: 'success', is_error: false });
  });
  const ro = new ClaudeCodeAdapter({ loadQuery: async () => q.fn, model: 'claude-sonnet-5-5', profile: 'read-only', env: { ANTHROPIC_API_KEY: 'k' } });
  const t = setup(root);
  t.controller.start('x', ro);
  await waitFor(t.controller, (s) => s.awaitingInput);
  assert.equal(results[0].behavior, 'deny');
  assert.equal(results[1].behavior, 'deny');
  assert.match(results[1].message, /protected file: \.env/);
  assert.ok(q.calls[0].disallowedTools.includes('Edit') && q.calls[0].disallowedTools.includes('Bash'));
  t.controller.stop();
  await t.controller.whenIdle();

  const oauth = fakeQuery(async (_o, push) => push({ type: 'system', subtype: 'init', model: 'm', session_id: 's', tools: [] }), { apiKeySource: 'oauth', apiProvider: 'firstParty' });
  const t2 = setup(root);
  const id2 = t2.controller.start('x', new ClaudeCodeAdapter({ loadQuery: async () => oauth.fn, model: 'm', profile: 'read-only', env: { ANTHROPIC_API_KEY: 'k' } }));
  await t2.controller.whenIdle();
  assert.equal(t2.recorder.getTask(id2)!.status, 'Failed');
  assert.match(t2.recorder.getTask(id2)!.summary!, /API-key authentication was not confirmed/);
  assert.ok(!oauth.calls.some((call) => call.prompt?.message?.content), 'auth mismatch sends no task prompt');

  const t3 = setup(root);
  const id3 = t3.controller.start('x', new ClaudeCodeAdapter({ loadQuery: async () => q.fn, model: 'm', profile: 'read-only', env: {} }));
  await t3.controller.whenIdle();
  assert.match(t3.recorder.getTask(id3)!.summary!, /Sign in through official Claude Code/);
});

test('Claude subscription: confirmed before prompting; same-session follow-up; API fallback refused even with a plan', async () => {
  const root = workspace();
  const subscription = { ok: true, kind: 'subscription' as const, method: 'Claude subscription (pro)' };
  const q = fakeQuery(async (_options, push) => {
    push({ type: 'system', subtype: 'init', model: 'haiku', session_id: 'sub1', tools: ['Read'] });
    push({ type: 'assistant', message: { content: [{ type: 'text', text: 'Ready on subscription.' }] } });
    push({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01 });
  }, { apiProvider: 'firstParty', subscriptionType: 'Claude Pro' });
  const t = setup(root);
  const id = t.controller.start('Explain', new ClaudeCodeAdapter({ loadQuery: async () => q.fn, model: 'haiku', profile: 'read-only', env: {}, authentication: subscription }));
  await waitFor(t.controller, (s) => s.awaitingInput);
  assert.match(t.recorder.getOperations(id)[0].description, /authentication confirmed: Claude subscription/);
  assert.ok(t.recorder.getOperations(id).some((op) => /not an API invoice/.test(op.resultSummary ?? '')));
  await t.controller.steer('Continue');
  await waitFor(t.controller, (s) => s.awaitingInput);
  assert.equal(t.recorder.getTask(id)!.turns!.length, 2);
  await t.controller.endSession(); await t.controller.whenIdle();
  for (const account of [{ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'Claude Pro' }, { apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }]) {
    const wrong = fakeQuery(async () => {}, account);
    const bad = setup(root);
    const badId = bad.controller.start('Must not send', new ClaudeCodeAdapter({ loadQuery: async () => wrong.fn, model: 'haiku', profile: 'read-only', env: {}, authentication: subscription }));
    await bad.controller.whenIdle();
    assert.equal(bad.recorder.getTask(badId)!.status, 'Failed');
    assert.ok(!wrong.calls.some((call) => call.prompt?.message?.content), 'wrong billing mode never receives the user prompt');
  }
});

// ------------------------------------------------------------------ discovery & independence

test('Ollama coding-model discovery marks models without tool-calling as incompatible', async () => {
  const fakeFetch = (async (url: string, init?: any) => {
    if (url.endsWith('/api/tags')) {
      return { json: async () => ({ models: [{ name: 'qwen3:8b', size: 5.2e9, details: { parameter_size: '8.2B' } }, { name: 'llama3:8b', size: 4.7e9, details: {} }, { name: 'nomic-embed', size: 1e8, details: {} }] }) };
    }
    const model = JSON.parse(init.body).model;
    const caps: Record<string, string[]> = { 'qwen3:8b': ['completion', 'tools', 'thinking'], 'llama3:8b': ['completion'], 'nomic-embed': ['embedding'] };
    return { json: async () => ({ capabilities: caps[model], model_info: { 'qwen3.context_length': 40960 } }) };
  }) as unknown as typeof fetch;
  const ms = await discoverOllamaCodingModels('http://127.0.0.1:11434', fakeFetch);
  assert.deepEqual(ms.map((m) => [m.id, m.compatible]), [['qwen3:8b', true], ['llama3:8b', false], ['nomic-embed', false]]);
  assert.match(ms[1].reason!, /no tool-calling/);
  assert.equal(ms[0].contextLength, 40960);
});

test('coding model and reviewer model are independent', async () => {
  const root = workspace();
  const reviewer = new ReviewService({ enabled: () => true, endpoint: () => 'http://127.0.0.1:1', allowRemote: () => false, preferredModel: () => 'gpt-oss:20b', thinking: () => 'off', contextWindow: () => 8192, fetchImpl: (async () => { throw new Error('offline'); }) as any });
  const fake = new FakeOpenCode();
  fake.turns = [async (s) => s.idle()];
  const { controller } = setup(root);
  controller.start('x', openCode(root, fake, 'read-only'));
  await waitFor(controller, (s) => s.awaitingInput);
  reviewer.selectModel('anything');
  const body = fake.requests.find((r) => r.route.endsWith('/prompt_async'))!.body;
  assert.equal(body.model.modelID, 'qwen3:8b', 'coding session keeps its own model');
  assert.equal(reviewer.inferenceRequests, 0);
  await controller.endSession();
  await controller.whenIdle();
});
