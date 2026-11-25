#!/usr/bin/env node
// REAL OpenCode server lifecycle test (no model inference: only /global/health,
// /config and /session are called). Uses the bundled or configured opencode
// binary, a disposable XDG home and a disposable state file.
//
//   npm run test:opencode-server
//
// Covers: automatic start + readiness, authentication, reuse (no duplicate),
// unexpected exit → Error → automatic restart → same session still available,
// extension-host crash → re-adoption by a new manager, clean shutdown, settings
// change, a recorded PID that is not ours is never stopped, idle stop, manual
// restart, restart limit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { OpenCodeServerManager } = require('../out/agents/opencode/OpenCodeServerManager');
const { locateOpenCode, processAlive } = require('../out/agents/opencode/OpenCodeServer');

const root = path.resolve(__dirname, '..');
const exe = process.env.VAW_OPENCODE || locateOpenCode(undefined, root);
if (!exe) {
  console.error('OpenCode binary not found (npm install, or set VAW_OPENCODE).');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vaw-oc-server-'));
const stateFile = path.join(tmp, 'state', 'opencode-server.json');
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const launch = (over = {}) => ({ executable: exe, homeDir: path.join(tmp, 'home'), workspaceRoot: project, ollamaBaseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', contextLimit: 8192, outputLimit: 2048, profile: 'approved-write', ...over });
const logs = [];
const manager = (name, extra = {}) => {
  const m = new OpenCodeServerManager({ stateFile, log: (l) => { logs.push(`${name} ${l}`); if (process.env.VAW_VERBOSE) console.log(`    ${name} ${l}`); }, healthIntervalMs: 500, ...extra });
  const states = [];
  m.onStatus((s) => { if (states.at(-1) !== s.state) states.push(s.state); });
  return { m, states };
};
const opencodePids = () => {
  if (process.platform !== 'win32') return [];
  const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq opencode.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter((l) => l.includes('opencode')).map((l) => Number(l.split('","')[1]));
};
const waitFor = async (probe, what, ms = 20000) => {
  const t = Date.now();
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(true);
    console.log(`  ✔ ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    results.push(false);
    console.error(`  ✖ ${name}\n    ${err.stack}`);
  }
}

(async () => {
  console.log(`OpenCode: ${exe}\nTemp: ${tmp}`);
  const before = new Set(opencodePids());
  const A = manager('A');
  let conn, sessionId, pid1;

  await step('starts automatically when a connection is needed; Starting → Running; authenticated', async () => {
    assert.equal(A.m.status().state, 'Stopped');
    conn = await A.m.connect(launch());
    const s = A.m.status();
    assert.deepEqual(A.states, ['Stopped', 'Starting', 'Running'].slice(1));
    assert.equal(s.state, 'Running');
    assert.ok(s.pid && processAlive(s.pid));
    assert.match(s.version ?? '', /^\d+\.\d+/);
    assert.equal(s.connections, 1);
    pid1 = s.pid;
    const rec = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(rec.pid, pid1, 'owned process recorded');
    const anon = await fetch(`http://127.0.0.1:${s.port}/global/health`);
    assert.equal(anon.status, 401, 'requests without the password are refused');
    const session = await conn.request('POST', '/session', { title: 'lifecycle test' });
    sessionId = session.id;
    assert.ok(sessionId);
    assert.ok(logs.some((l) => /ready in \d+ ms \(OpenCode/.test(l)), 'startup logged');
  });

  await step('reuses the healthy server: a second connection starts no duplicate', async () => {
    const n = opencodePids().filter((p) => !before.has(p)).length;
    const c2 = await A.m.connect(launch());
    assert.equal(A.m.status().pid, pid1);
    assert.equal(A.m.status().connections, 2);
    assert.equal(opencodePids().filter((p) => !before.has(p)).length, n, 'no new opencode process');
    await c2.close();
    assert.equal(A.m.status().connections, 1);
    assert.equal(A.m.status().state, 'Running', 'releasing a connection keeps the server');
  });

  await step('unexpected exit → Error, the active connection is told, automatic restart → Running; the same session is still there (reconnect)', async () => {
    let told = '';
    conn.onExit((d) => (told = d));
    execFileSync('taskkill', ['/PID', String(pid1), '/F'], { stdio: 'ignore' });
    await waitFor(() => told, 'connection told about the exit');
    assert.match(told, /stopped unexpectedly[\s\S]*send your message again/);
    await waitFor(() => A.m.status().state === 'Running' && A.m.status().pid !== pid1, 'automatic restart');
    assert.ok(A.states.includes('Error'), `states: ${A.states.join(' → ')}`);
    assert.equal(A.m.status().restarts, 1);
    await conn.close();
    const again = await A.m.connect(launch());
    const s = await again.request('GET', `/session/${sessionId}`);
    assert.equal(s.id, sessionId, 'session restored from the OpenCode data directory');
    await again.close();
    pid1 = A.m.status().pid;
  });

  await step('clean extension shutdown (dispose) stops the owned server and removes the record', async () => {
    A.m.dispose();
    await waitFor(() => !processAlive(pid1), 'owned server stopped on dispose');
    assert.equal(fs.existsSync(stateFile), false);
  });

  await step('extension host crash (process killed): no orphaned server is left (Windows); the stale record is cleaned up; after the restart the same session is available', async () => {
    // A separate Node process plays the extension host: it starts the server, then is killed hard.
    const host = spawn(process.execPath, ['-e', `
      const { OpenCodeServerManager } = require(${JSON.stringify(path.join(root, 'out', 'agents', 'opencode', 'OpenCodeServerManager.js'))});
      const m = new OpenCodeServerManager({ stateFile: ${JSON.stringify(stateFile)}, log: () => {} });
      m.connect(${JSON.stringify(launch())}).then(() => console.log(JSON.stringify(m.status())), (e) => { console.error(e.message); process.exit(1); });
      setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    host.stdout.on('data', (d) => (out += d));
    const started = JSON.parse(await waitFor(() => out.includes('}') && out, 'host started the server'));
    host.kill(); // the "extension host" dies without deactivating
    await waitFor(() => host.exitCode !== null || host.signalCode !== null, 'host gone');
    if (process.platform === 'win32') {
      // Windows (libuv job object): the server dies with its host, so a crash leaves no orphan.
      await waitFor(() => !processAlive(started.pid), 'server ended with its host');
      const B = manager('B');
      const c = await B.m.connect(launch());
      assert.notEqual(B.m.status().pid, started.pid);
      assert.equal(B.m.status().adopted, false);
      assert.ok(logs.some((l) => new RegExp(`B \\[opencode\\] recorded server pid ${started.pid} is no longer running`).test(l)), 'stale record cleaned up');
      assert.equal(opencodePids().filter((p) => !before.has(p)).length, 1, 'exactly one server');
      const s = await c.request('GET', `/session/${sessionId}`);
      assert.equal(s.id, sessionId, 'after the restart the same session is available');
      await c.close();
      B.m.dispose();
    } else {
      assert.ok(processAlive(started.pid), 'the orphaned server is still running');
    }
  });

  await step('a server that outlives its extension host (macOS/Linux behaviour) is re-adopted, not duplicated', async () => {
    // Simulated in-process: X is frozen (no monitoring, no shutdown), as if its host vanished while the server kept running.
    const X = manager('X');
    const cx = await X.m.connect(launch());
    const orphan = X.m.status().pid;
    X.m.disposed = true;
    clearInterval(X.m.healthTimer);
    const n = opencodePids().filter((p) => !before.has(p)).length;
    const B = manager('B2');
    const c = await B.m.connect(launch());
    assert.equal(B.m.status().pid, orphan, 'same process');
    assert.equal(B.m.status().adopted, true);
    assert.equal(opencodePids().filter((p) => !before.has(p)).length, n, 'no duplicate started');
    assert.ok(logs.some((l) => /B2 \[opencode\] re-adopted server pid/.test(l)));
    const s = await c.request('GET', `/session/${sessionId}`);
    assert.equal(s.id, sessionId, 'the adopted server serves the same sessions');
    await c.close();
    B.m.dispose();
    await waitFor(() => !processAlive(orphan), 'adopted server stopped on dispose');
    assert.equal(fs.existsSync(stateFile), false);
    await cx.close();
  });

  await step('a settings change (profile) replaces the server; the config really loaded is verified', async () => {
    const C = manager('C');
    const c1 = await C.m.connect(launch());
    const p1 = C.m.status().pid;
    await c1.close();
    const c2 = await C.m.connect(launch({ profile: 'read-only' }));
    const p2 = C.m.status().pid;
    assert.notEqual(p2, p1);
    await waitFor(() => !processAlive(p1), 'previous server stopped');
    assert.equal(C.m.status().profile, 'read-only');
    // With a connection in use, other settings are refused instead of killing it.
    await assert.rejects(C.m.connect(launch({ model: 'other:1b' })), /in use by another local-agent session/);
    await c2.close();
    C.m.dispose();
    await waitFor(() => !processAlive(p2), 'stopped');
  });

  await step('a recorded PID that does not answer with our password is never stopped', async () => {
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ pid: foreign.pid, port: 9, password: 'x', key: 'y', executable: exe, model: 'm', profile: 'read-only', startedAt: new Date().toISOString() }));
    const D = manager('D');
    const c = await D.m.connect(launch());
    assert.ok(processAlive(foreign.pid), 'the foreign process is still running');
    assert.notEqual(D.m.status().pid, foreign.pid);
    assert.ok(logs.some((l) => /does not answer .* leaving it alone/.test(l)));
    await c.close();
    D.m.dispose();
    foreign.kill();
  });

  await step('idle stop: the owned server stops after the idle time without connections', async () => {
    const E = manager('E', { idleStopMs: 1500 });
    const c = await E.m.connect(launch());
    const p = E.m.status().pid;
    await c.close();
    await waitFor(() => E.m.status().state === 'Stopped', 'idle stop', 10000);
    assert.match(E.m.status().message ?? '', /idle/);
    await waitFor(() => !processAlive(p), 'process gone');
    E.m.dispose();
  });

  await step('manual restart; the restart limit stops automatic restarts after 3 failures in 5 minutes', async () => {
    const F = manager('F', { maxAutoRestarts: 1 });
    const c = await F.m.connect(launch());
    const p0 = F.m.status().pid;
    await F.m.restart();
    const p1 = F.m.status().pid;
    assert.notEqual(p1, p0);
    assert.equal(F.m.status().state, 'Running');
    execFileSync('taskkill', ['/PID', String(p1), '/F'], { stdio: 'ignore' });
    await waitFor(() => F.m.status().state === 'Running' && F.m.status().pid !== p1, 'auto restart 1');
    const p2 = F.m.status().pid;
    execFileSync('taskkill', ['/PID', String(p2), '/F'], { stdio: 'ignore' });
    await waitFor(() => F.m.status().state === 'Error' && /Automatic restart stopped/.test(F.m.status().message ?? ''), 'limit reached');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(F.m.status().state, 'Error', 'no further restart');
    await F.m.restart();
    assert.equal(F.m.status().state, 'Running', 'manual restart recovers');
    await c.close();
    F.m.dispose();
  });

  await step('a missing executable is a clear error', async () => {
    const G = manager('G');
    await assert.rejects(G.m.connect(launch({ executable: path.join(tmp, 'nope.exe') })), /OpenCode executable not found/);
    assert.equal(G.m.status().state, 'Error');
  });

  const leftovers = opencodePids().filter((p) => !before.has(p));
  await step('no opencode processes left behind', async () => {
    await waitFor(() => opencodePids().filter((p) => !before.has(p)).length === 0, `leftover pids ${leftovers.join(', ')}`, 10000);
  });
  if (process.env.VAW_VERBOSE !== '1') {
    console.log('\nLog excerpt:');
    for (const l of logs.filter((l) => /\[opencode\]/.test(l)).slice(0, 14)) console.log(`    ${l}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} real OpenCode server lifecycle checks passed`);
  process.exit(failed ? 1 : 0);
})();
