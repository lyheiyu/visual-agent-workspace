import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeShellWrites, detectShellWrites, shellWriteBlockMessage } from '../analysis/shellWrites';
import { describeCommand } from '../analysis/commandInfo';
import { CODEX_ADD_CONTENT_CASE } from './support/shellFixtures';

test('command #83 does not report the arrow in the recorded Node script as a redirection', () => {
  const command = "\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command \"node -e 'const {DatabaseSync}=require(''node:sqlite''); const db=new DatabaseSync(process.argv[1],{readOnly:true}); const row=db.prepare(''SELECT value FROM ItemTable WHERE key = ?'').get(''visual-agent-workspace.visual-agent-workspace'');const h=JSON.parse(row.value)[''visualAgent.history.v1'']; const ops=Array.isArray(h.operations)?h.operations:Object.values(h.operations??{}); for(const o of ops.filter(o=>o.sequenceNumber===48)) console.log(JSON.stringify({type:o.operationType,status:o.status,operationId:o.operationId,filePath:o.filePath,ids:o.associatedChangeIds??[o.associatedChangeId], ranges:o.changedRanges})); console.log(Object.keys(h),ops.length);' \\\"\"'$env:APPDATA'\"\\\\Code\\\\User\\\\workspaceStorage\\\\285d1bddf60f0da88d10d12c393318ca\\\\state.vscdb\\\"\"";
  const info = describeCommand(command);
  assert.equal(info.writes, false);
  assert.equal(info.sourceWrite, false);
  assert.deepEqual(info.writeTargets, []);
  assert.deepEqual(info.writeReasons, []);
});

test('redirects after quoted inline comparisons still name the actual output file', () => {
  const command = "node -e 'console.log([1, 2].filter(x => x > 1 && x >= 2 && x <= 3))'";
  assert.equal(describeCommand(command).writes, false);
  const redirected = describeCommand(command + ' 2>> "test output.log"');
  assert.equal(redirected.writes, true);
  assert.equal(redirected.sourceWrite, true);
  assert.deepEqual(redirected.writeTargets, ['test output.log']);
  assert.deepEqual(redirected.writeReasons, ['redirects output to test output.log']);
  assert.equal(describeCommand(command + ' 2>&1').writes, false);
  assert.equal(describeCommand('echo "a > b"').writes, false);
});

test('shell writes: the supplied Codex PowerShell Add-Content case is detected, with its target resolved', () => {
  const f = detectShellWrites(CODEX_ADD_CONTENT_CASE);
  assert.equal(f.blocked, true);
  assert.deepEqual(f.writes, [{ via: 'Add-Content', target: 'web/style.css' }], 'the ">" inside the here-string is data, not a redirect');
  const info = describeCommand(CODEX_ADD_CONTENT_CASE);
  assert.equal(info.sourceWrite, true);
  assert.equal(info.writes, true, 'the "writes files" label is shown too');
  assert.ok(info.writeTargets.includes('web/style.css'));
  const msg = shellWriteBlockMessage(f);
  assert.match(msg, /^Blocked before execution/);
  assert.match(msg, /Add-Content → web\/style\.css/);
  assert.match(msg, /file edit \/ patch tool/);
  assert.match(msg, /Do not retry with another shell writer/);
});

test('shell writes: explicit writers are detected (PowerShell, redirection, tee, sed -i, inline scripts, nested shells)', () => {
  const cases: Array<[string, string]> = [
    ['echo hi > a.py', 'redirection > → a.py'],
    ['echo hi>a.py', 'redirection > → a.py'],
    ['printf "x" >> src/app.js', 'redirection >> → src/app.js'],
    ["cat > a.py <<'EOF'\nprint(1)\nEOF", 'redirection > → a.py'],
    ['Set-Content -Path src\\a.ts -Value "x"', 'Set-Content → src\\a.ts'],
    ['Add-Content notes.md "x"', 'Add-Content → notes.md'],
    ['Get-Content a | Out-File b.txt', 'Out-File → b.txt'],
    ['New-Item -ItemType File -Path c.js -Value "x"', 'New-Item → c.js'],
    ["[IO.File]::WriteAllText('a.txt', 'x')", '[IO.File]::WriteAllText → a.txt'],
    [`powershell.exe -NoProfile -Command "Set-Content -LiteralPath 'x.py' -Value 'y'"`, 'Set-Content → x.py'],
    ['powershell -EncodedCommand ' + Buffer.from('Add-Content -Path z.txt -Value 1', 'utf16le').toString('base64'), 'Add-Content → z.txt'],
    [`bash -lc "printf x > a.js"`, 'redirection > → a.js'],
    ['cmd /c echo x > a.bat', 'redirection > → a.bat'],
    ["sed -i 's/a/b/' src/x.py", 'sed -i → src/x.py'],
    ['npm test | tee log.txt', 'tee → log.txt'],
    [`python -c "open('a.txt','w').write('x')"`, 'inline python code → a.txt'],
    ["python - <<'EOF'\nfrom pathlib import Path\nPath('m.py').write_text('x')\nEOF", 'inline python code → m.py'],
    [`node -e "require('fs').writeFileSync('a.js','x')"`, 'inline node code → a.js'],
    ['git apply fix.patch', 'git apply'],
  ];
  for (const [command, expected] of cases) {
    const f = detectShellWrites(command);
    assert.equal(f.blocked, true, command);
    assert.equal(describeShellWrites(f), expected, command);
  }
});

test('shell writes: reads, tests and builds are not blocked; tests/builds are flagged as possibly generating files', () => {
  const allowed = [
    'npm test',
    'python -m pytest -q',
    'npm run build',
    'tsc -p .',
    'node --test x.js 2>&1',
    'npm test > /dev/null 2>&1',
    'Get-Content a > $null',
    'npm ci | Out-Null',
    'grep -n ">" src/a.js',
    'git commit -m "a > b"',
    `node -e "[1].map(x => x * 2)"`,
    `python -c "print(1 > 0)"`,
    `python -c "print(open('a.txt').read())"`,
    'Get-Process | Tee-Object -Variable p',
    'git apply --check fix.patch',
    'New-Item -ItemType Directory -Path out',
    `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Select-String -Path a.css -Pattern 'x'\nnode --test b.test.js"`,
  ];
  for (const command of allowed) assert.equal(detectShellWrites(command).blocked, false, command);
  for (const command of ['npm test', 'python -m pytest -q', 'npm run build', 'tsc -p .', 'cargo build', 'npm install lodash']) {
    const info = describeCommand(command);
    assert.equal(info.sourceWrite, false, command);
    assert.equal(info.mayGenerate, true, command);
  }
  assert.equal(describeCommand('git status').mayGenerate, false);
  // Not detected (documented limitation): writes made inside a program or script the command runs.
  assert.equal(detectShellWrites('node scripts/generate.js').blocked, false);
});
