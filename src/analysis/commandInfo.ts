/**
 * Static description of a shell command for the observation panel.
 *
 * Pure and model-free: the summary comes from the command text itself
 * (program, sub-command, redirections), and the outcome from the recorded
 * tool result. "writes" is a conservative heuristic: it flags anything that
 * may create, modify or delete files (redirection, tee, sed -i, rm/mv/cp,
 * package installs, git state changes, PowerShell writers, inline scripts
 * that open files for writing). It never claims a command is safe.
 */
export interface CommandInfo {
  /** Short purpose, e.g. "Run tests (pytest)", "Install packages (npm)". */
  summary: string;
  kind: 'test' | 'install' | 'build' | 'vcs' | 'read' | 'write' | 'delete' | 'script' | 'run';
  /** May create, modify or delete files. */
  writes: boolean;
  /** Files/paths named as write targets (redirection, tee, touch, rm, ...). */
  writeTargets: string[];
  /** Why `writes` is set (shown next to the label). */
  writeReasons: string[];
  /** Here-doc, `python -c`, `node -e`, multi-line, or very long. */
  embeddedCode: boolean;
  /** Long enough that the panel collapses it by default. */
  long: boolean;
  /** First line, truncated (for one-line display). */
  short: string;
}

const LONG = 160;

/** Split a command line into simple commands on ; && || | (outside quotes). */
export function splitCommands(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || (ch === '&' && command[i + 1] === '&') || ch === '|') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function words(simple: string): string[] {
  return (simple.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
}

const PROGRAM_LABELS: Array<[RegExp, string, CommandInfo['kind']]> = [
  [/^(pytest|py\.test)$/, 'Run tests (pytest)', 'test'],
  [/^(jest|vitest|mocha|ctest)$/, 'Run tests ($0)', 'test'],
  [/^(tsc)$/, 'Type-check / compile (tsc)', 'build'],
  [/^(make|cmake|ninja|gradle|mvn|msbuild)$/, 'Build ($0)', 'build'],
  [/^(cat|type|head|tail|less|more|wc|grep|rg|findstr|ls|dir|tree|find|Get-Content|Get-ChildItem|Select-String|pwd|which|where|echo|stat|file|du|df)$/i, 'Inspect files ($0)', 'read'],
  [/^(rm|rmdir|del|erase|rd|Remove-Item|shred|unlink)$/i, 'Delete files ($0)', 'delete'],
  [/^(mv|move|cp|copy|xcopy|robocopy|mkdir|md|touch|ln|New-Item|Copy-Item|Move-Item|Rename-Item|Set-Content|Add-Content|Out-File|chmod|chown|truncate)$/i, 'Change files ($0)', 'write'],
];

/** Describe one command line. */
export function describeCommand(command: string): CommandInfo {
  const text = command.trim();
  // Here-document bodies are data, not commands: drop them before splitting into steps.
  const parts = splitCommands(stripHeredocBodies(text));
  const writeTargets: string[] = [];
  const writeReasons: string[] = [];
  const summaries: Array<{ label: string; kind: CommandInfo['kind'] }> = [];
  const heredoc = /<<-?\s*['"]?\w+['"]?/.test(text);
  const inlineScript = /\b(python3?|py|node|deno|ruby|perl|php|bash|sh|pwsh|powershell)(\.exe)?\s+(-c|-e|--eval|-Command)\b/i.test(text);

  // Redirections to files (not >&2, not /dev/null, not NUL).
  for (const m of text.matchAll(/(?<![<>&\d])(\d?>>?|&>)\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) {
    const target = m[2].replace(/^["']|["']$/g, '');
    if (/^&\d$|^\/dev\/(null|stdout|stderr)$|^nul$/i.test(target) || /^&/.test(target)) continue;
    writeTargets.push(target);
    writeReasons.push(`redirects output to ${target}`);
  }
  for (const simple of parts) {
    const w = words(simple);
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i])) i++; // env assignments
    if (w[i] === 'sudo' || w[i] === 'env' || w[i] === 'npx' || w[i] === 'exec') i++;
    const prog = (w[i] ?? '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '');
    const sub = w[i + 1] ?? '';
    const args = w.slice(i + 1);
    const lower = prog.toLowerCase();
    if (!prog || /^(cd|pushd|popd|set-location|sl|chdir)$/i.test(prog)) continue; // navigation is not a step
    // `cat/echo/printf ... > file`: the purpose is writing that file.
    const redirect = /(?<![<>&\d])(?:\d?>>?|&>)\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/.exec(simple);
    const redirectTarget = redirect?.[1].replace(/^["']|["']$/g, '');
    if (redirectTarget && !/^&|^\/dev\/|^nul$/i.test(redirectTarget) && /^(cat|echo|printf|type|Write-Output|tee)$/i.test(prog)) {
      summaries.push({ label: `Write ${redirectTarget} (${prog})`, kind: 'write' });
      continue;
    }
    // Package managers
    if (/^(npm|pnpm|yarn|bun)$/.test(lower)) {
      if (/^(i|install|add|ci|remove|uninstall|rm|update|upgrade)$/.test(sub)) {
        summaries.push({ label: `Install/change packages (${lower})`, kind: 'install' });
        writeReasons.push(`${lower} ${sub} changes node_modules / lockfiles`);
      } else if (/^(test|t)$/.test(sub) || (sub === 'run' && /test/.test(w[i + 2] ?? ''))) {
        summaries.push({ label: `Run tests (${lower})`, kind: 'test' });
      } else if (sub === 'run' || sub === 'exec') {
        summaries.push({ label: `Run script ${w[i + 2] ?? ''} (${lower})`.replace(/\s+\(/, ' ('), kind: /build|compile/.test(w[i + 2] ?? '') ? 'build' : 'run' });
      } else {
        summaries.push({ label: `${lower} ${sub}`.trim(), kind: 'run' });
      }
      continue;
    }
    if (/^(pip|pip3|uv|poetry|conda)$/.test(lower)) {
      const installs = /^(install|add|uninstall|remove|sync|update)$/.test(sub) || (lower === 'uv' && sub === 'pip');
      summaries.push({ label: installs ? `Install/change packages (${lower})` : `${lower} ${sub}`.trim(), kind: installs ? 'install' : 'run' });
      if (installs) writeReasons.push(`${lower} ${sub} changes installed packages`);
      continue;
    }
    if (lower === 'git') {
      const writesGit = /^(add|commit|checkout|switch|reset|restore|clean|merge|rebase|pull|push|stash|apply|am|cherry-pick|revert|rm|mv|tag|branch|init|clone)$/.test(sub);
      summaries.push({ label: `Git ${sub}`.trim(), kind: 'vcs' });
      if (writesGit && !(sub === 'branch' && args.length <= 1) && !(sub === 'tag' && args.length <= 1)) writeReasons.push(`git ${sub} changes the repository or working tree`);
      continue;
    }
    if (/^(python|python3|py|node|deno|ruby|perl|php|go|cargo|dotnet|java|bash|sh|pwsh|powershell)$/.test(lower)) {
      if (/^(-c|-e|--eval|-Command)$/i.test(sub)) {
        summaries.push({ label: `Run inline ${lower} code`, kind: 'script' });
        const code = args.slice(1).join(' ');
        if (/open\([^)]*['"][wax+]|write_text|writeFile|fs\.write|Set-Content|Out-File|shutil\.(copy|move|rmtree)|os\.(remove|unlink|rename)|unlink\(/.test(code)) writeReasons.push('inline code writes or deletes files');
      } else if (lower === 'python' || lower === 'python3' || lower === 'py') {
        if (sub === '-m' && /^(pytest|unittest)$/.test(w[i + 2] ?? '')) summaries.push({ label: `Run tests (${w[i + 2]})`, kind: 'test' });
        else if (sub === '-m' && w[i + 2] === 'pip') {
          summaries.push({ label: 'Install/change packages (pip)', kind: 'install' });
          if (/^(install|uninstall)$/.test(w[i + 3] ?? '')) writeReasons.push('pip changes installed packages');
        } else summaries.push({ label: `Run ${sub ? sub.replace(/^.*[\\/]/, '') : 'python'} (python)`, kind: /test/i.test(sub) ? 'test' : 'run' });
      } else if (lower === 'node' && sub) {
        summaries.push({ label: `Run ${sub.replace(/^.*[\\/]/, '')} (node)`, kind: /test/i.test(sub) ? 'test' : 'run' });
      } else if (/^(go|cargo|dotnet)$/.test(lower)) {
        summaries.push({ label: `${lower} ${sub}`.trim(), kind: sub === 'test' ? 'test' : /build|run/.test(sub) ? 'build' : 'run' });
      } else {
        summaries.push({ label: `Run ${lower}${sub ? ' ' + sub.replace(/^.*[\\/]/, '') : ''}`, kind: 'run' });
      }
      continue;
    }
    if (lower === 'sed' && args.some((a) => /^-i/.test(a) || a === '--in-place')) {
      summaries.push({ label: 'Edit files in place (sed -i)', kind: 'write' });
      writeReasons.push('sed -i rewrites files in place');
      writeTargets.push(...args.filter((a) => !a.startsWith('-')).slice(1));
      continue;
    }
    if (lower === 'tee') {
      summaries.push({ label: 'Write output to file (tee)', kind: 'write' });
      const targets = args.filter((a) => !a.startsWith('-'));
      writeTargets.push(...targets);
      writeReasons.push(`tee writes ${targets.join(', ') || 'a file'}`);
      continue;
    }
    const known = PROGRAM_LABELS.find(([re]) => re.test(prog));
    if (known) {
      summaries.push({ label: known[1].replace('$0', prog), kind: known[2] });
      if (known[2] === 'write' || known[2] === 'delete') {
        const targets = args.filter((a) => !a.startsWith('-'));
        writeTargets.push(...(lower === 'cp' || lower === 'copy' || lower === 'mv' || lower === 'move' ? targets.slice(-1) : targets));
        writeReasons.push(`${prog} ${known[2] === 'delete' ? 'deletes' : 'creates or changes'} ${targets.join(', ') || 'files'}`);
      }
      continue;
    }
    summaries.push({ label: `Run ${prog}`, kind: 'run' });
  }
  if (heredoc && writeTargets.length) writeReasons.push('here-document written to a file');
  const first = summaries.find((s) => s.kind !== 'read') ?? summaries[0];
  const kind: CommandInfo['kind'] = first?.kind ?? 'run';
  const label = first?.label ?? 'Run command';
  const more = summaries.length > 1 ? ` (+${summaries.length - 1} more step${summaries.length > 2 ? 's' : ''})` : '';
  const firstLine = text.split(/\r?\n/)[0];
  return {
    summary: label + more,
    kind: writeReasons.length && kind !== 'delete' && kind !== 'install' && kind !== 'vcs' ? (kind === 'read' || kind === 'run' ? 'write' : kind) : kind,
    writes: writeReasons.length > 0,
    writeTargets: [...new Set(writeTargets)].slice(0, 20),
    writeReasons: [...new Set(writeReasons)].slice(0, 10),
    embeddedCode: heredoc || inlineScript || /\r?\n/.test(text),
    long: text.length > LONG || /\r?\n/.test(text),
    short: firstLine.length > 90 ? firstLine.slice(0, 89) + '…' : firstLine,
  };
}

/** Duration in ms from recorded timestamps, if both ends are known. */
export function durationMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const d = Date.parse(end) - Date.parse(start);
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Remove here-document bodies (`<<EOF ... EOF`, `<<-'X' ... X`) so their lines are not parsed as commands. */
export function stripHeredocBodies(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<-?\s*['"]?(\w+)['"]?/.exec(lines[i]);
    if (!m) continue;
    const end = lines.findIndex((l, k) => k > i && l.trim() === m[1]);
    if (end > i) i = end;
  }
  return out.join('\n');
}
