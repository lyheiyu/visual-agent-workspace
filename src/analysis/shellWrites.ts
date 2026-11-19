/**
 * Detects EXPLICIT file-content writes in a shell command, before it runs.
 *
 * Pure, local and model-free. It reads only the command text and never
 * executes anything. The goal is to keep source changes on the reviewable
 * path (an agent's file-edit/patch tool, which shows a diff first), not to
 * prove that a command is safe:
 *
 * - Detected: PowerShell writers (Add-Content, Set-Content, Out-File,
 *   Tee-Object, New-Item -Value, [IO.File]::Write*), output redirection
 *   (> and >>), tee, sed -i / perl -i, dd of=, git apply / patch, and inline
 *   interpreter code (python -c, node -e, heredoc-fed scripts) that opens or
 *   writes files. Shell wrappers such as `powershell -Command '…'` and
 *   `bash -lc "…"` are unquoted and scanned too.
 * - Not detected: writes done by programs, scripts or build tools internally,
 *   obfuscated or dynamically built commands, and copies, moves or deletes.
 *   The last group stays under command approval with the "writes files"
 *   label from describeCommand().
 */
export interface ShellWrite {
  /** How the command writes, e.g. "Add-Content", "redirection >", "inline python". */
  via: string;
  /** Target path as written in the command (variables resolved when assigned literally). */
  target?: string;
}

export interface ShellWriteFinding {
  /** True when at least one explicit write was found: the command should not run. */
  blocked: boolean;
  writes: ShellWrite[];
}

const NULL_TARGET = /^(\/dev\/(null|stdout|stderr)|nul:?|\$null|&\d?|-)$/i;

/** Detect explicit file writes. Never executes the command. */
export function detectShellWrites(command: string): ShellWriteFinding {
  const writes: ShellWrite[] = [];
  scan(command, 'shell', writes, 0);
  const seen = new Set<string>();
  const unique = writes.filter((w) => {
    const k = `${w.via}|${w.target ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { blocked: unique.length > 0, writes: unique.slice(0, 20) };
}

/** One-line description, e.g. "Add-Content → src/style.css; redirection > → out.txt". */
export function describeShellWrites(f: ShellWriteFinding): string {
  return f.writes.map((w) => (w.target ? `${w.via} → ${w.target}` : w.via)).join('; ');
}

/**
 * The message returned to the agent when a write is blocked. It is sent
 * through the agent's normal "declined" channel (OpenCode reply message,
 * Claude Code deny message, Codex turn/steer).
 */
export function shellWriteBlockMessage(f: ShellWriteFinding): string {
  return [
    `Blocked before execution by Visual Agent Workspace: this shell command writes file content (${describeShellWrites(f)}).`,
    'A shell write cannot be shown to the user as a diff before it runs, so it was not executed.',
    'Resubmit the change with your file edit / patch tool (for example apply_patch, edit or write), so the user can review, edit and approve the diff.',
    'Do not retry with another shell writer (Add-Content, Set-Content, Out-File, > or >> redirection, tee, sed -i, or an inline script that writes files).',
    'If you only need command output, run the command without redirecting it to a file. Commands that only read, test or build can still be requested.',
  ].join(' ');
}

type Lang = 'shell' | 'powershell';

function scan(text: string, lang: Lang, out: ShellWrite[], depth: number): void {
  if (depth > 3 || !text.trim()) return;
  // Inline interpreter code and heredoc bodies fed to interpreters (before bodies are removed).
  for (const code of interpreterCode(text)) codeWrites(code.code, code.lang, out);
  const { text: noBodies } = stripBodies(text);
  const masked = maskQuoted(noBodies);
  const vars = lang === 'powershell' ? psVariables(noBodies) : new Map<string, string>();
  const resolve = (t: string | undefined) => {
    if (!t) return t;
    const m = /^\$\{?(\w+)\}?$/.exec(t);
    return m && vars.has(m[1].toLowerCase()) ? vars.get(m[1].toLowerCase()) : t;
  };

  // Output redirection outside quotes: >, >>, 1>, 2>, &>, *> (not 2>&1, =>, ->, >=).
  for (const m of masked.matchAll(/(^|[^<>=\-&])(\d|&|\*)?(>>?)(?![&>=])/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const target = resolve(readWord(noBodies, at));
    if (!target || NULL_TARGET.test(target) || target.startsWith('(')) continue;
    out.push({ via: `redirection ${m[3]}`, target });
  }

  // PowerShell writers (also detected outside an explicit PowerShell wrapper: Codex on Windows runs PowerShell).
  for (const m of masked.matchAll(/(^|[\s;|&({])(Add-Content|Set-Content|Out-File|Tee-Object|Export-Csv|Export-Clixml|New-Item)\b/gi)) {
    const start = (m.index ?? 0) + m[1].length;
    const end = statementEnd(masked, start);
    const args = words(noBodies.slice(start + m[2].length, end));
    const cmdlet = canonicalCmdlet(m[2]);
    if (cmdlet === 'New-Item' && !args.some((a) => /^-Value$/i.test(a))) continue; // creating an empty item/folder
    const target = resolve(psPathArg(cmdlet, args));
    if (cmdlet === 'Tee-Object' && !target) continue; // -Variable: no file
    if (target && NULL_TARGET.test(target)) continue;
    out.push({ via: cmdlet, target });
  }
  for (const m of noBodies.matchAll(/\[(?:System\.)?IO\.File\]::(WriteAll\w*|AppendAll\w*|Create\w*|Open\w*)\(\s*(?:'([^']*)'|"([^"]*)"|(\$\w+))?/gi)) {
    if (/^Open/i.test(m[1]) && !/Write|Append|Create/i.test(noBodies.slice(m.index ?? 0, (m.index ?? 0) + 200))) continue;
    out.push({ via: `[IO.File]::${m[1]}`, target: resolve(m[2] ?? m[3] ?? m[4]) });
  }

  // Unix-style writers.
  for (const seg of masked.matchAll(/[^;\n|&]+/g)) {
    const offset = seg.index ?? 0;
    const w = words(noBodies.slice(offset, offset + seg[0].length));
    let i = 0;
    while (i < w.length && (/^[A-Za-z_]\w*=/.test(w[i]) || /^(sudo|env|exec|command|nohup|time)$/.test(w[i]))) i++;
    const prog = (w[i] ?? '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    const args = w.slice(i + 1);
    const files = args.filter((a) => !a.startsWith('-'));
    if (prog === 'tee') out.push({ via: 'tee', target: files[0] });
    else if (prog === 'sed' && args.some((a) => /^-[a-z]*i/.test(a) || a.startsWith('--in-place'))) out.push({ via: 'sed -i', target: files[files.length - 1] });
    else if (prog === 'perl' && args.some((a) => /^-[a-z]*i/.test(a))) out.push({ via: 'perl -i', target: files[files.length - 1] });
    else if (prog === 'dd') {
      const of = args.find((a) => a.startsWith('of='));
      if (of && !NULL_TARGET.test(of.slice(3))) out.push({ via: 'dd', target: of.slice(3) });
    } else if (prog === 'patch') out.push({ via: 'patch' });
    else if (prog === 'git' && args[0] === 'apply' && !args.some((a) => /^--(check|stat|numstat|summary)$/.test(a))) out.push({ via: 'git apply' });
  }

  // Nested shells: unquote and scan the inner script.
  for (const inner of wrappedScripts(noBodies)) scan(inner.script, inner.lang, out, depth + 1);
}

function canonicalCmdlet(name: string): string {
  return ['Add-Content', 'Set-Content', 'Out-File', 'Tee-Object', 'Export-Csv', 'Export-Clixml', 'New-Item'].find((c) => c.toLowerCase() === name.toLowerCase()) ?? name;
}

const PS_SWITCHES = /^-(NoNewline|Force|Append|NoClobber|WhatIf|Confirm|PassThru|NoTypeInformation|AsByteStream|Raw)$/i;

/** -Path / -LiteralPath / -FilePath value, else the first positional argument. */
function psPathArg(cmdlet: string, args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (/^-(Path|LiteralPath|FilePath|PSPath|LP)$/i.test(args[i])) return args[i + 1];
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (!PS_SWITCHES.test(a)) i++; // skip the parameter's value
      continue;
    }
    return cmdlet === 'Tee-Object' ? undefined : a;
  }
  return undefined;
}

/** `$name = 'literal'` / `$name = "literal"` assignments (lower-cased names). */
function psVariables(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/\$(\w+)\s*=\s*(?:'([^'\n]*)'|"([^"\n$]*)")/g)) vars.set(m[1].toLowerCase(), m[2] ?? m[3]);
  return vars;
}

/** End of the PowerShell/shell statement that starts at `start` (masked text: quotes are blank). */
function statementEnd(masked: string, start: number): number {
  const m = /[;|\n]|&&/.exec(masked.slice(start));
  return m ? start + (m.index ?? 0) : masked.length;
}

/** Remove heredoc (`<<EOF … EOF`) and PowerShell here-string (`@' … '@`) bodies. */
function stripBodies(text: string): { text: string; bodies: Array<{ opener: string; body: string }> } {
  const bodies: Array<{ opener: string; body: string }> = [];
  // PowerShell here-strings: @'<newline> … <newline>'@  (and @" … "@).
  let t = text.replace(/@(['"])\r?\n([\s\S]*?)\r?\n\1@/g, (_all, q: string, body: string) => {
    bodies.push({ opener: '@' + q, body });
    return `${q}${q}`;
  });
  const lines = t.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const m = /<<-?\s*['"]?(\w+)['"]?/.exec(lines[i]);
    if (!m) continue;
    const end = lines.findIndex((l, k) => k > i && l.trim() === m[1]);
    if (end > i) {
      bodies.push({ opener: lines[i], body: lines.slice(i + 1, end).join('\n') });
      i = end;
    }
  }
  t = kept.join('\n');
  return { text: t, bodies };
}

/** Same-length copy with the contents of '…' and "…" replaced by spaces. */
function maskQuoted(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        out += '  ';
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        out += ch;
      } else out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/** Read one shell word at `at` (skipping spaces), with quotes removed. */
function readWord(text: string, at: number): string | undefined {
  let i = at;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  const w = shellWord(text, i);
  return w.value || undefined;
}

/** POSIX-style word: concatenated '…', "…" (backslash escapes) and bare runs. */
function shellWord(text: string, start: number): { value: string; end: number } {
  let i = start;
  let value = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close < 0 ? text.length : close;
      value += text.slice(i + 1, stop);
      i = stop + 1;
    } else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
          value += text[i + 1];
          i += 2;
        } else value += text[i++];
      }
      i++;
    } else if (/[\s;|&<>()]/.test(ch)) break;
    else value += text[i++];
  }
  return { value, end: i };
}

/** Unquote the rest of a command line as shell words joined by spaces. */
function unquoteRest(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const w = shellWord(text, i);
    if (w.end === i) {
      parts.push(text[i]);
      i++;
      continue;
    }
    parts.push(w.value);
    i = w.end;
  }
  return parts.join(' ');
}

/** Scripts passed to nested shells: powershell/pwsh -Command, bash/sh -c, cmd /c. */
function wrappedScripts(text: string): Array<{ script: string; lang: Lang }> {
  const out: Array<{ script: string; lang: Lang }> = [];
  for (const m of text.matchAll(/(?:^|[\s"'\\/;&|(])(powershell|pwsh)(?:\.exe)?["']?((?:\s+-(?!c\b|command\b)\w+(?:\s+(?![-'"])[^\s'"]+)?)*)\s+-(?:c|command)\s+/gi)) {
    out.push({ script: unquoteRest(text.slice((m.index ?? 0) + m[0].length)), lang: 'powershell' });
  }
  // -EncodedCommand: Base64 of UTF-16LE text.
  for (const m of text.matchAll(/(?:^|[\s"'\\/;&|(])(?:powershell|pwsh)(?:\.exe)?["']?(?:\s+-\w+)*?\s+-e(?:c|nc|ncodedcommand)?\s+['"]?([A-Za-z0-9+/=]{8,})/gi)) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf16le');
    if (decoded.trim()) out.push({ script: decoded, lang: 'powershell' });
  }
  for (const m of text.matchAll(/(?:^|[\s"'\\/;&|(])(bash|sh|zsh|dash)(?:\.exe)?["']?\s+(?:-\w+\s+)*-\w*c\s+/gi)) {
    const w = shellWord(text, (m.index ?? 0) + m[0].length);
    out.push({ script: w.value, lang: 'shell' });
  }
  for (const m of text.matchAll(/(?:^|[\s"'\\/;&|(])cmd(?:\.exe)?["']?\s+\/[cCkK]\s+/g)) {
    out.push({ script: unquoteRest(text.slice((m.index ?? 0) + m[0].length)), lang: 'shell' });
  }
  return out;
}

type CodeLang = 'python' | 'node' | 'ruby' | 'perl' | 'php';

function codeLang(prog: string): CodeLang | undefined {
  const p = prog.toLowerCase();
  if (/^(python3?|py)$/.test(p)) return 'python';
  if (/^(node|deno|bun)$/.test(p)) return 'node';
  if (p === 'ruby') return 'ruby';
  if (p === 'perl') return 'perl';
  if (p === 'php') return 'php';
  return undefined;
}

/** Inline code (`python -c`, `node -e`) and heredoc bodies fed to an interpreter. */
function interpreterCode(text: string): Array<{ code: string; lang: CodeLang }> {
  const out: Array<{ code: string; lang: CodeLang }> = [];
  for (const m of text.matchAll(/(?:^|[\s"'\\/;&|(])(python3?|py|node|deno|bun|ruby|perl|php)(?:\.exe)?["']?(?:\s+-(?!c\b|e\b|r\b|-eval\b)\S+)*\s+(-c|-e|-r|--eval|-p)\s+/gi)) {
    const lang = codeLang(m[1]);
    if (!lang) continue;
    out.push({ code: shellWord(text, (m.index ?? 0) + m[0].length).value, lang });
  }
  for (const b of stripBodies(text).bodies) {
    const m = /(?:^|[\s"'\\/;&|(])(python3?|py|node|deno|bun|ruby|perl|php)(?:\.exe)?\b/i.exec(b.opener);
    if (m) out.push({ code: b.body, lang: codeLang(m[1])! });
  }
  return out;
}

/** File writes in interpreter code (literal paths reported when present). */
function codeWrites(code: string, lang: CodeLang, out: ShellWrite[]): void {
  const via = `inline ${lang} code`;
  const lit = (s?: string) => s?.replace(/^[rbfu]*['"`]|['"`]$/gi, '');
  const patterns: RegExp[] =
    lang === 'python'
      ? [
          /\bopen\(\s*([rbfu]*(['"])[^'"]*\2)?[^)]*?,\s*(?:mode\s*=\s*)?[rbfu]*['"][^'"]*[wax+][^'"]*['"]/g,
          /(?:Path\(\s*([rbfu]*(['"])[^'"]*\2)[^)]*\))?\.write_(?:text|bytes)\(/g,
          /\bshutil\.(?:copy\w*|move)\([^,]*,\s*([rbfu]*(['"])[^'"]*\2)?/g,
          /\bos\.(?:rename|replace)\([^,]*,\s*([rbfu]*(['"])[^'"]*\2)?/g,
        ]
      : lang === 'node'
        ? [/\b(?:writeFileSync|appendFileSync|writeFile|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|rename|cpSync)\(\s*((['"`])[^'"`]*\2)?/g, /\bDeno\.write\w*\(\s*((['"`])[^'"`]*\2)?/g, /\bBun\.write\(\s*((['"`])[^'"`]*\2)?/g]
        : lang === 'ruby'
          ? [/\bFile\.(?:write|open\([^)]*['"][wa])\w*\(?\s*((['"])[^'"]*\2)?/g, /\bIO\.write\(\s*((['"])[^'"]*\2)?/g]
          : lang === 'php'
            ? [/\bfile_put_contents\(\s*((['"])[^'"]*\2)?/g, /\bfopen\(\s*((['"])[^'"]*\2)?\s*,\s*['"][wax]/g]
            : [/\bopen\s*\(?\s*\w*\s*,\s*['"]?[>+]/g];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) out.push({ via, target: lit(m[1]) || undefined });
  }
}

/** Words of a simple command (quotes removed, best effort). */
function words(simple: string): string[] {
  return (simple.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, ''));
}
