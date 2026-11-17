import { redactSecrets } from '../recorder/redaction';
import { ChatMessage } from './OllamaClient';

/**
 * Prompt builders for the Local AI Reviewer. Pure functions.
 *
 * Token discipline: context is assembled from prioritized sections and cut
 * to `budgetChars`; lower-priority sections are dropped first. Everything is
 * passed through secret redaction before it leaves the extension.
 */

export type ReviewKind = 'explain' | 'review' | 'impact' | 'error';

export interface CodeBlock {
  filePath: string;
  /** 1-based line of the first line of `code`. */
  startLine: number;
  code: string;
  label?: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** The exact context sent (for display/export). */
  context: string;
  truncated: boolean;
}

const SYSTEM = [
  'You are a careful, concise code reviewer helping a developer understand code.',
  'You only see the excerpts provided; you cannot run code or see other files.',
  'Refer to code as path:line using the line numbers shown.',
  'If something cannot be determined from the excerpts, say so explicitly instead of guessing.',
  'Do not propose running commands. Answer in Markdown.',
].join(' ');

export function numbered(block: CodeBlock): string {
  const lines = block.code.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const width = String(block.startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(block.startLine + i).padStart(width)} | ${l}`).join('\n');
}

function fence(block: CodeBlock): string {
  const head = `${block.label ? `${block.label} — ` : ''}${block.filePath}:${block.startLine}`;
  return `${head}\n\`\`\`\n${numbered(block)}\n\`\`\``;
}

interface Section {
  text: string;
  /** Lower = more important. Sections with the same priority are kept in order. */
  priority: number;
}

function assemble(sections: Section[], budgetChars: number): { text: string; truncated: boolean } {
  const ordered = sections.map((s, i) => ({ ...s, i })).sort((a, b) => a.priority - b.priority || a.i - b.i);
  const kept = new Set<number>();
  let used = 0;
  let truncated = false;
  for (const s of ordered) {
    if (used + s.text.length <= budgetChars) {
      kept.add(s.i);
      used += s.text.length;
    } else {
      truncated = true;
      // Keep a cut version of the highest-priority section rather than nothing.
      if (kept.size === 0) {
        sections[s.i] = { ...sections[s.i], text: sections[s.i].text.slice(0, budgetChars) + '\n… [truncated]' };
        kept.add(s.i);
        used = budgetChars;
      }
    }
  }
  const text = sections.filter((_, i) => kept.has(i)).map((s) => s.text).join('\n\n');
  return { text: redactSecrets(text) + (truncated ? '\n\n(Some context was omitted to stay within the size limit.)' : ''), truncated };
}

/**
 * Response-language directive. The model answers directly in the requested
 * language (no English-then-translate); bilingual answers come from ONE
 * request. Identifiers, code, paths, commands and error/API names stay as-is.
 */
export function languageDirective(lang: ResponseLanguage): string {
  const keep =
    'Keep code identifiers, code snippets, file paths, commands, exception names and API names exactly as written (do not translate them).';
  if (lang === 'zh-CN') {
    return `Write the entire answer directly in Simplified Chinese (简体中文); do not write an English version first. ${keep}`;
  }
  if (lang === 'bilingual') {
    return `Write the answer in both Simplified Chinese and English in this single response: first a section headed "## 中文" with the full answer in Simplified Chinese, then a section headed "## English" with the same content in English. ${keep}`;
  }
  return `Write the answer in English. ${keep}`;
}

export type ResponseLanguage = 'zh-CN' | 'en' | 'bilingual';

function build(task: string, sections: Section[], budgetChars: number, lang: ResponseLanguage = 'en'): BuiltPrompt {
  const { text, truncated } = assemble(sections, budgetChars);
  return {
    messages: [
      { role: 'system', content: `${SYSTEM} ${languageDirective(lang)}` },
      { role: 'user', content: `${task}\n\n${text}` },
    ],
    context: text,
    truncated,
  };
}

// ------------------------------------------------------------------ builders

export function explainFunctionPrompt(
  input: { fn: CodeBlock & { name?: string }; language: string; imports?: CodeBlock; enclosing?: string; moduleDefs?: Array<{ line: number; text: string }> },
  budgetChars: number,
  lang: ResponseLanguage = 'en',
): BuiltPrompt {
  const what = input.fn.name ? `the ${input.language} function \`${input.fn.name}\`` : `the selected ${input.language} code`;
  return build(
    `Explain ${what}${input.enclosing ? ` (member of \`${input.enclosing}\`)` : ''}: its purpose, inputs, outputs/return value, side effects, and the important logic and edge cases. Keep it short.`,
    [
      { text: fence({ ...input.fn, label: 'Code' }), priority: 0 },
      ...(input.imports ? [{ text: fence({ ...input.imports, label: 'Imports' }), priority: 2 }] : []),
      ...moduleDefsSection(input.fn.filePath, input.moduleDefs),
    ],
    budgetChars,
    lang,
  );
}

function moduleDefsSection(filePath: string, defs?: Array<{ line: number; text: string }>): Section[] {
  return defs?.length
    ? [
        {
          text: `Module-level definitions referenced by this code (${filePath}):\n\`\`\`\n${defs.map((d) => `${d.line} | ${d.text}`).join('\n')}\n\`\`\``,
          priority: 1,
        },
      ]
    : [];
}

export function reviewChangePrompt(
  input: { filePath: string; functionName?: string; diff: string; original?: CodeBlock; modified?: CodeBlock; operationRef?: string; moduleDefs?: Array<{ line: number; text: string }> },
  budgetChars: number,
  lang: ResponseLanguage = 'en',
): BuiltPrompt {
  const target = input.functionName ? `\`${input.functionName}\` in ${input.filePath}` : input.filePath;
  return build(
    `Review this code change to ${target}. List concrete potential bugs, regressions, behaviour changes and logic errors, each with a path:line reference and a severity (high/medium/low). If the change looks correct, say so. Do not restate the diff.`,
    [
      { text: `Diff (as recorded from the coding agent${input.operationRef ? `, ${input.operationRef}` : ''}):\n\`\`\`diff\n${input.diff.trim()}\n\`\`\``, priority: 0 },
      ...(input.modified ? [{ text: fence({ ...input.modified, label: 'Modified code' }), priority: 1 }] : []),
      ...(input.original ? [{ text: fence({ ...input.original, label: 'Original code' }), priority: 2 }] : []),
      ...moduleDefsSection(input.filePath, input.moduleDefs),
    ],
    budgetChars,
    lang,
  );
}

export function impactPrompt(
  input: {
    fn: CodeBlock & { name: string };
    callers: Array<{ filePath: string; line: number; callerFunction?: string; snippet: string }>;
    callees: Array<{ name: string; filePath: string; line: number }>;
    evidenceSource: string;
    complete: boolean;
  },
  budgetChars: number,
  lang: ResponseLanguage = 'en',
): BuiltPrompt {
  const callers = input.callers.length
    ? input.callers.map((c) => `- ${c.filePath}:${c.line}${c.callerFunction ? ` in \`${c.callerFunction}\`` : ''}: \`${c.snippet}\``).join('\n')
    : '- none found';
  const callees = input.callees.length ? input.callees.map((c) => `- \`${c.name}\` (${c.filePath}:${c.line})`).join('\n') : '- none found';
  return build(
    `Analyse the impact of changing \`${input.fn.name}\`: which callers could break or change behaviour, which assumptions callers make about its inputs/outputs, and what to re-test. Base your answer only on the evidence below and state uncertainty.`,
    [
      { text: fence({ ...input.fn, label: 'Function' }), priority: 0 },
      {
        text: `Call sites (${input.evidenceSource}${input.complete ? '' : '; may be incomplete'}):\n${callers}\n\nFunctions it calls (defined in this workspace):\n${callees}`,
        priority: 1,
      },
    ],
    budgetChars,
    lang,
  );
}

export function explainErrorPrompt(
  input: { command: string; exitCode?: number; cwd?: string; output: string; related: CodeBlock[] },
  budgetChars: number,
  lang: ResponseLanguage = 'en',
): BuiltPrompt {
  const tail = tailLines(input.output, 80);
  return build(
    'Explain the most likely cause(s) of this failure and suggest concrete investigation steps (what to inspect, which assumption to check). Do not claim a cause is certain unless the output proves it.',
    [
      { text: `Command: \`${input.command}\`\nExit code: ${input.exitCode ?? 'unknown'}${input.cwd ? `\nWorking directory: ${input.cwd}` : ''}`, priority: 0 },
      { text: `Output (last lines, as recorded):\n\`\`\`\n${tail}\n\`\`\``, priority: 0 },
      ...input.related.map((b, i) => ({ text: fence({ ...b, label: b.label ?? 'Related code' }), priority: 1 + i })),
    ],
    budgetChars,
    lang,
  );
}

export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines.length <= n ? text.trim() : `… [${lines.length - n} earlier lines omitted]\n${lines.slice(-n).join('\n').trim()}`;
}

// ------------------------------------------------------------- translation

/** Translate an existing review result. Code spans must survive unchanged. */
export function translatePrompt(text: string, target: 'zh-CN' | 'en'): { role: 'system' | 'user'; content: string }[] {
  const lang = target === 'zh-CN' ? 'Simplified Chinese (简体中文)' : 'English';
  return [
    {
      role: 'system',
      content:
        `You are a precise technical translator. Translate the user's Markdown into ${lang}. ` +
        'Do not add, remove or reinterpret findings. Keep the Markdown structure. ' +
        'Copy fenced code blocks and `inline code` byte-for-byte. Keep code identifiers, file paths, path:line references, commands, exception names and API names unchanged. ' +
        'Output only the translation.',
    },
    { role: 'user', content: text },
  ];
}

/** Code spans (fenced blocks and `inline`) that must appear unchanged in a translation. */
export function codeSpans(markdown: string): string[] {
  const spans: string[] = [];
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, (m) => {
    spans.push(m.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim());
    return ' ';
  });
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    spans.push(m[1]);
  }
  return spans.filter(Boolean);
}

export function codeSpansPreserved(original: string, translated: string): boolean {
  return codeSpans(original).every((span) => translated.includes(span));
}
