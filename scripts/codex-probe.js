#!/usr/bin/env node
// Step 1 probe: connect to a real `codex app-server`, run ONE read-only turn
// in a disposable git repo, decline every approval request, and record the
// full message trace. Verifies the event stream before any write access.
//
//   node scripts/codex-probe.js [--trace <file>] [--prompt "<text>"]
const fs = require('node:fs');
const path = require('node:path');
const { CodexRpcClient, StdioTransport } = require('../out/adapters/codex/CodexRpcClient');
const { locateCodex, codexEnvironment } = require('../out/adapters/codex/codexLocator');
const { textInput } = require('../out/adapters/codex/protocol');
const { createDisposableRepo } = require('./lib/disposable-repo');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const tracePath = opt('--trace', path.join(require('node:os').tmpdir(), `codex-trace-${Date.now()}.jsonl`));
const prompt = opt(
  '--prompt',
  'Read validation.py and explain in two sentences what validate_samples() checks. Do not modify any files.',
);

async function main() {
  const loc = locateCodex();
  if (!loc) throw new Error('Codex binary not found');
  const repo = createDisposableRepo();
  console.log(`codex:  ${loc.executable}\nrepo:   ${repo.dir}\ntrace:  ${tracePath}`);
  const trace = fs.createWriteStream(tracePath);
  const transport = new StdioTransport(loc.executable, require('../out/adapters/codex/CodexSession').ISOLATION_ARGS.concat(['app-server']), { cwd: repo.dir, env: codexEnvironment(loc) });
  const client = new CodexRpcClient(transport);
  const seen = new Map();
  client.onTraffic(({ direction, message }) => {
    trace.write(JSON.stringify({ t: Date.now(), direction, message }) + '\n');
    if (direction === 'in' && message.method) {
      const key = message.method + (message.params?.item ? `:${message.params.item.type}` : '');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  });
  client.onProtocolNote((n) => console.log('[note]', n));
  // --approve-commands: accept command approvals (they still run inside the
  // read-only sandbox). File changes are ALWAYS declined by this probe.
  const approveCommands = argv.includes('--approve-commands');
  client.setRequestHandler(async (method, params) => {
    const accept = approveCommands && method === 'item/commandExecution/requestApproval';
    console.log(`[server-request] ${method} → ${accept ? 'accept' : 'decline'}`, JSON.stringify(params).slice(0, 400));
    if (method.endsWith('requestApproval')) return { decision: accept ? 'accept' : 'decline' };
    throw new Error(`probe does not handle ${method}`);
  });
  const closed = new Promise((r) => client.onClose(r));

  try {
    const init = await client.request('initialize', {
      clientInfo: { name: 'visual-agent-workspace', title: 'Visual Agent Workspace (probe)', version: '0.2.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    console.log('initialize →', JSON.stringify(init).slice(0, 300));
    client.notify('initialized', {});

    const models = await client.request('model/list', {});
    const visible = models.data.filter((m) => !m.hidden);
    const model = opt('--model', (visible.find((m) => m.isDefault) ?? visible[0])?.model);
    console.log('models →', visible.map((m) => m.model + (m.isDefault ? '*' : '')).join(', '), '| using', model);
    const started = await client.request('thread/start', {
      model,
      cwd: repo.dir,
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: 'visual-agent-workspace',
    });
    console.log('thread/start →', JSON.stringify({ id: started.thread.id, model: started.model, sandbox: started.sandbox, approvalPolicy: started.approvalPolicy }));

    const turnDone = new Promise((resolve) =>
      client.onNotification((n) => {
        if (n.method === 'turn/completed') resolve(n.params.turn);
        if (n.method === 'item/completed') {
          const it = n.params.item;
          const brief =
            it.type === 'commandExecution'
              ? `${it.command} [${it.status}, exit ${it.exitCode}] actions=${JSON.stringify(it.commandActions)}`
              : it.type === 'agentMessage'
                ? it.text.slice(0, 300)
                : it.type === 'fileChange'
                  ? JSON.stringify(it.changes.map((c) => [c.path, c.kind])) + ` [${it.status}]`
                  : '';
          console.log(`[item/completed] ${it.type} ${brief}`);
        }
      }),
    );
    const turn = await client.request('turn/start', { threadId: started.thread.id, input: [textInput(prompt)] });
    console.log('turn/start →', turn.turn.id, turn.turn.status);
    const final = await Promise.race([
      turnDone,
      closed.then((c) => Promise.reject(new Error(`app-server exited: ${c.detail}`))),
      new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout (240s)')), 240_000)),
    ]);
    console.log(`turn/completed → status=${final.status}${final.error ? ` error=${final.error.message}` : ''}`);
    console.log('\nmessage counts:');
    for (const [k, v] of [...seen.entries()].sort()) console.log(`  ${v}\t${k}`);
    const status = repo.status();
    console.log(`\ngit status in disposable repo: ${status ? '\n' + status : '(clean)'}`);
    if (status) process.exitCode = 3;
    for (const f of (opt('--expect-absent', '') || '').split(',').filter(Boolean)) {
      const exists = fs.existsSync(path.join(repo.dir, f));
      console.log(`sandbox check: ${f} ${exists ? 'EXISTS (write was NOT blocked)' : 'absent (write blocked)'}`);
      if (exists) process.exitCode = 4;
    }
  } finally {
    await client.close();
    trace.end();
    repo.dispose();
  }
}

main().catch((err) => {
  console.error('PROBE FAILED:', err.message);
  process.exit(1);
});
