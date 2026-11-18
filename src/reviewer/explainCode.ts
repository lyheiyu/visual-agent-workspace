import { createHash } from 'node:crypto';
import { FunctionRange, listFunctionRanges } from '../navigation/symbolSearch';
import { redactSecrets } from '../recorder/redaction';
import { ChatMessage } from './OllamaClient';
import { languageDirective, numbered, ResponseLanguage } from './prompts';

/**
 * "Explain Code in Detail": pure planning, prompting and parsing.
 *
 * - Scopes: selected code, the function/class containing a line, or the whole file.
 * - Modes: a structured explanation (7 fixed sections) or a line-by-line
 *   explanation whose sections carry real, validated line ranges.
 * - Large inputs are split at syntax boundaries (functions/classes from the
 *   existing text parser) into chunks that fit the local model's context;
 *   each chunk carries its enclosing class/function signature. If the chunk
 *   limit is reached the rest is reported as NOT analyzed — never implied.
 */

export type ExplainScope = 'selection' | 'symbol' | 'file';
export type ExplainMode = 'structured' | 'lineByLine';

/** 1-based, inclusive. */
export interface LineSpan {
  startLine: number;
  endLine: number;
}

export interface ExplainChunk extends LineSpan {
  index: number;
  /** Enclosing definitions, outermost first, e.g. "class Optimizer(Base):  (line 12)". */
  context: string[];
}

export interface ChunkPlan {
  requested: LineSpan;
  chunks: ExplainChunk[];
  analyzed: LineSpan[];
  /** Lines of the requested range that were NOT sent to the model (chunk limit). */
  omitted: LineSpan[];
  partial: boolean;
}

export interface PlanOptions {
  /** Max characters of numbered source per chunk. */
  maxChunkChars: number;
  maxChunks: number;
}

/** Characters a line costs once numbered for the prompt ("  167 | " + text + newline). */
const lineCost = (l: string) => l.length + 10;

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function languageFamily(languageId: string, fileName = ''): 'python' | 'c-like' {
  return languageId === 'python' || /\.pyi?$/i.test(fileName) ? 'python' : 'c-like';
}

/** Plan chunks for `span` (1-based) of `text`. */
export function planChunks(text: string, family: 'python' | 'c-like', span: LineSpan, options: PlanOptions): ChunkPlan {
  const lines = text.split(/\r?\n/);
  const requested = { startLine: clamp(span.startLine, 1, lines.length), endLine: clamp(span.endLine, 1, lines.length) };
  if (requested.endLine < requested.startLine) requested.endLine = requested.startLine;
  const defs = listFunctionRanges(text, family).map((d) => ({ ...d, startLine: d.startLine + 1, endLine: d.endLine + 1 }));
  const max = Math.max(400, options.maxChunkChars);
  const cost = (a: number, b: number) => {
    let c = 0;
    for (let i = a; i <= b; i++) c += lineCost(lines[i - 1] ?? '');
    return c;
  };
  const signature = (d: FunctionRange) => {
    for (let i = d.startLine; i <= Math.min(d.endLine, d.startLine + 10); i++) {
      const l = lines[i - 1] ?? '';
      if (l.includes(d.name) && !/^\s*@/.test(l)) return `${l.trim().slice(0, 200)}  (line ${i})`;
    }
    return `${(lines[d.startLine - 1] ?? '').trim().slice(0, 200)}  (line ${d.startLine})`;
  };

  type Unit = LineSpan & { context: string[] };
  const units: Unit[] = [];
  /** Split [a,b] into syntax units; `self` is the definition that IS this range (not a child). */
  const split = (a: number, b: number, parentContext: string[], self?: FunctionRange, depth = 0): void => {
    if (cost(a, b) <= max) {
      units.push({ startLine: a, endLine: b, context: parentContext });
      return;
    }
    // Pieces of a split definition keep its signature as context.
    const context = self ? [...parentContext, signature(self)] : parentContext;
    const inner = depth > 6 ? [] : outermost(defs.filter((d) => d !== self && d.startLine >= a && d.endLine <= b && !(self && d.startLine === self.startLine && d.endLine === self.endLine)));
    if (!inner.length) {
      // No smaller definitions: cut by lines, preferring blank lines as boundaries.
      let s = a;
      while (s <= b) {
        let e = s;
        let used = lineCost(lines[s - 1] ?? '');
        while (e < b && used + lineCost(lines[e] ?? '') <= max) used += lineCost(lines[e++] ?? '');
        if (e < b) {
          for (let k = e; k > s + Math.floor((e - s) * 0.6); k--) {
            if (!(lines[k - 1] ?? '').trim()) {
              e = k;
              break;
            }
          }
        }
        units.push({ startLine: s, endLine: e, context });
        s = e + 1;
      }
      return;
    }
    let cursor = a;
    for (const d of inner) {
      if (d.startLine > cursor) split(cursor, d.startLine - 1, context, undefined, depth + 1);
      split(d.startLine, d.endLine, context, d, depth + 1);
      cursor = d.endLine + 1;
    }
    if (cursor <= b) split(cursor, b, context, undefined, depth + 1);
  };
  const enclosing = defs
    .filter((d) => d.startLine < requested.startLine && d.endLine >= requested.endLine)
    .sort((x, y) => x.startLine - y.startLine)
    .map(signature);
  const selfDef = defs.find((d) => d.startLine === requested.startLine && d.endLine === requested.endLine);
  split(requested.startLine, requested.endLine, enclosing, selfDef);

  // Pack consecutive units into chunks; a chunk lists every enclosing definition of its units
  // (each signature carries its line number, so the model can tell which lines it encloses).
  const all: ExplainChunk[] = [];
  for (const u of units) {
    const last = all[all.length - 1];
    if (last && last.endLine + 1 === u.startLine && cost(last.startLine, u.endLine) <= max) {
      last.endLine = u.endLine;
      for (const c of u.context) if (!last.context.includes(c)) last.context.push(c);
    } else {
      all.push({ index: all.length, startLine: u.startLine, endLine: u.endLine, context: [...u.context] });
    }
  }
  // Drop chunks that are only blank lines (nothing to explain).
  const meaningful = all.filter((c) => !isBlankRange(lines, c)).map((c, i) => ({ ...c, index: i }));
  const kept = meaningful.slice(0, Math.max(1, options.maxChunks));
  const omitted = meaningful.slice(kept.length).map(({ startLine, endLine }) => ({ startLine, endLine }));
  return {
    requested,
    chunks: kept,
    analyzed: merge(kept),
    omitted: merge(omitted),
    partial: omitted.length > 0,
  };
}

function outermost(defs: Array<FunctionRange>): FunctionRange[] {
  const sorted = [...defs].sort((x, y) => x.startLine - y.startLine || y.endLine - x.endLine);
  const out: FunctionRange[] = [];
  for (const d of sorted) {
    const last = out[out.length - 1];
    if (!last || d.startLine > last.endLine) out.push(d);
  }
  return out;
}

function isBlankRange(lines: string[], s: LineSpan): boolean {
  for (let i = s.startLine; i <= s.endLine; i++) if ((lines[i - 1] ?? '').trim()) return false;
  return true;
}

function merge(spans: LineSpan[]): LineSpan[] {
  const out: LineSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, s.endLine);
    else out.push({ startLine: s.startLine, endLine: s.endLine });
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(Math.trunc(n) || lo, lo), Math.max(lo, hi));
}

export function formatSpan(s: LineSpan): string {
  return s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}–${s.endLine}`;
}

/** Chunk size that leaves room for the answer inside the model's context window. */
export function chunkBudget(contextWindowTokens: number, maxContextChars: number): number {
  // ~3 characters per token for code; half of the window for the prompt, half for the answer.
  return Math.max(1500, Math.min(maxContextChars, Math.floor(contextWindowTokens * 3 * 0.5) - 1500));
}

// ------------------------------------------------------------------ prompts

export interface ExplainPromptInput {
  filePath: string;
  languageId: string;
  scope: ExplainScope;
  mode: ExplainMode;
  text: string;
  plan: ChunkPlan;
  chunk: ExplainChunk;
  totalLines: number;
  symbol?: { name: string; kind: string };
  /** Imports and module-level definitions referenced by the chunk (same file). */
  moduleLines?: Array<{ line: number; text: string }>;
  /** File outline (definitions with line numbers), for whole-file analysis. */
  outline?: Array<{ line: number; text: string }>;
  /** Call sites found by local static analysis (snippets only). */
  callers?: Array<{ filePath: string; line: number; snippet: string }>;
  /** Files in the project that import this file (local text search, snippets only). */
  dependents?: Array<{ filePath: string; line: number; snippet: string }>;
  language: ResponseLanguage;
  dirty?: boolean;
}

const SYSTEM = [
  'You explain source code to a developer who wants to understand it in depth.',
  'You see ONLY the numbered excerpt and context provided; you cannot run code or open other files.',
  'Ground every statement in the shown code and cite the real line numbers from the left margin.',
  'Mark each claim as [Fact] (directly visible in the code), [Inference] (likely, not provable from the excerpt) or [Issue] (a potential bug, edge case or risky assumption).',
  'Never invent implementation details of code that is not shown; say "not visible in the provided code" instead.',
  'Do not propose running commands or editing files. Answer in Markdown.',
].join(' ');

const STRUCTURED_SECTIONS = [
  'Overall purpose',
  'Inputs and outputs',
  'Main execution flow',
  'Important functions, classes and dependencies',
  'Key algorithms and mathematical operations',
  'Potential errors, edge cases and assumptions',
  'Relationships with other project components',
];

/** "Explain this file": what a developer needs before changing it. */
const FILE_SECTIONS = [
  'Purpose of this file',
  'Execution flow (entry points, the order things run in, what calls what)',
  'Dependencies (what it imports and uses; which project files depend on it)',
  'Modification impact (what breaks or changes if each main part is edited; what to re-test)',
  'Potential errors, edge cases and assumptions',
];

/** A function/class explained as part of the project, not in isolation. */
const SYMBOL_SECTIONS = [
  'Role within the project (who calls it, what it provides to them)',
  'Inputs and outputs',
  'Main execution flow',
  'Key algorithms and mathematical operations',
  'Potential errors, edge cases and assumptions',
  'Modification impact (callers and behaviour that depend on it)',
];

export function sectionsFor(scope: ExplainScope): string[] {
  return scope === 'file' ? FILE_SECTIONS : scope === 'symbol' ? SYMBOL_SECTIONS : STRUCTURED_SECTIONS;
}

function scopeLabel(i: ExplainPromptInput): string {
  if (i.scope === 'file') return `the file \`${i.filePath}\``;
  if (i.scope === 'symbol' && i.symbol) return `the ${i.symbol.kind} \`${i.symbol.name}\` in \`${i.filePath}\``;
  return `the selected code in \`${i.filePath}\``;
}

export function buildExplainPrompt(i: ExplainPromptInput): { messages: ChatMessage[]; context: string } {
  const lines = i.text.split(/\r?\n/);
  const code = lines.slice(i.chunk.startLine - 1, i.chunk.endLine).join('\n');
  const parts = i.plan.chunks.length;
  const where = [
    `Explain ${scopeLabel(i)} (${i.languageId}), ${formatSpan(i.chunk)} of ${i.totalLines}.`,
    parts > 1 ? `This is part ${i.chunk.index + 1} of ${parts} of ${formatSpan(i.plan.requested)}; the other parts are explained separately, so explain only this part.` : '',
    i.plan.partial ? `Only part of the requested code is analyzed; ${i.plan.omitted.map(formatSpan).join(', ')} were NOT provided. Do not describe them.` : '',
    i.dirty ? 'The code comes from an unsaved editor buffer.' : '',
  ].filter(Boolean).join(' ');
  const task =
    i.mode === 'structured'
      ? [
          where,
          'Write these sections in this order as level-2 headings ("## "), translating the heading text into the answer language:',
          ...sectionsFor(i.scope).map((s, k) => `${k + 1}. ${s}`),
          'Cite line ranges as "Lines X–Y". If a section does not apply, say so in one sentence.',
          i.scope !== 'selection' ? 'Base dependency and impact statements only on the imports, call sites and dependent files listed below; if none are listed, say that no project usages were found by the local search.' : '',
        ].filter(Boolean).join('\n')
      : [
          where,
          `Explain the code line by line, in source/execution order, covering ${formatSpan(i.chunk)} without skipping statements.`,
          'Output ONLY a sequence of sections. Each section starts with a level-3 heading of exactly this form, keeping the English word "Lines" even when answering in another language:',
          '### Lines <start>–<end>: <short title>',
          'Use "### Line <n>: <short title>" for a single line. Use the real line numbers from the left margin. Group closely related statements; give important statements their own section.',
          'Under each heading explain: what the statements do; how variables and data change; conditions, loops, function calls and return values; any mathematical formula (write it out and name each symbol); external dependencies. Label claims [Fact], [Inference] or [Issue].',
        ].join('\n');
  const ctx: string[] = [];
  if (i.chunk.context.length) ctx.push(`Enclosing definitions (outermost first):\n${i.chunk.context.map((c) => `- ${c}`).join('\n')}`);
  if (i.moduleLines?.length) ctx.push(`Imports and module-level definitions used here (${i.filePath}):\n\`\`\`\n${i.moduleLines.map((d) => `${d.line} | ${d.text}`).join('\n')}\n\`\`\``);
  if (i.outline?.length && parts > 1) ctx.push(`Outline of ${i.filePath}:\n${i.outline.map((d) => `- line ${d.line}: ${d.text}`).join('\n')}`);
  if (i.dependents?.length) ctx.push(`Project files that import this file (local text search, may be incomplete):\n${i.dependents.map((c) => `- ${c.filePath}:${c.line}: \`${c.snippet}\``).join('\n')}`);
  if (i.callers?.length) ctx.push(`Call sites found by local text search (may be incomplete):\n${i.callers.map((c) => `- ${c.filePath}:${c.line}: \`${c.snippet}\``).join('\n')}`);
  ctx.push(`Code (${i.filePath}, ${formatSpan(i.chunk)}):\n\`\`\`\n${numbered({ filePath: i.filePath, startLine: i.chunk.startLine, code })}\n\`\`\``);
  const context = redactSecrets(ctx.join('\n\n'));
  return {
    messages: [
      { role: 'system', content: `${SYSTEM} ${languageDirective(i.language)}` },
      { role: 'user', content: `${task}\n\n${context}` },
    ],
    context,
  };
}

/** Overall structured summary from the per-part explanations (multi-part structured mode). */
export function buildSynthesisPrompt(input: {
  filePath: string;
  scopeText: string;
  plan: ChunkPlan;
  partTexts: Array<{ span: LineSpan; text: string }>;
  outline?: Array<{ line: number; text: string }>;
  language: ResponseLanguage;
  budgetChars: number;
  scope?: ExplainScope;
}): { messages: ChatMessage[]; context: string } {
  const per = Math.max(400, Math.floor((input.budgetChars - 1500) / Math.max(1, input.partTexts.length)));
  const parts = input.partTexts.map((p) => `### Part: ${formatSpan(p.span)}\n${p.text.length > per ? p.text.slice(0, per) + '\n… [cut]' : p.text}`).join('\n\n');
  const context = redactSecrets(
    [
      input.outline?.length ? `Outline of ${input.filePath}:\n${input.outline.map((d) => `- line ${d.line}: ${d.text}`).join('\n')}` : '',
      `Explanations of the individual parts:\n\n${parts}`,
    ].filter(Boolean).join('\n\n'),
  );
  const task = [
    `Combine the part explanations below into ONE overall explanation of ${input.scopeText}.`,
    input.plan.partial ? `Only ${input.plan.analyzed.map(formatSpan).join(', ')} were analyzed; ${input.plan.omitted.map(formatSpan).join(', ')} were not. State this and do not describe unanalyzed code.` : '',
    'Write these sections in this order as level-2 headings ("## "), translating the heading text into the answer language:',
    ...sectionsFor(input.scope ?? 'selection').map((s, k) => `${k + 1}. ${s}`),
    'Keep the [Fact]/[Inference]/[Issue] labels and the "Lines X–Y" citations from the parts. Do not add facts that are not in the parts.',
  ].filter(Boolean).join('\n');
  return {
    messages: [
      { role: 'system', content: `${SYSTEM} ${languageDirective(input.language)}` },
      { role: 'user', content: `${task}\n\n${context}` },
    ],
    context,
  };
}

// ------------------------------------------------------------------ parsing

export interface ExplanationSection {
  title: string;
  body: string;
  /** 1-based range from the heading, when present. */
  startLine?: number;
  endLine?: number;
  /** false = the heading names lines outside the analyzed part (shown, not linked). */
  rangeValid?: boolean;
}

const HEADING = /^ {0,3}(#{2,4})\s+(.+?)\s*#*\s*$/;
const RANGE = /(?:\b(?:lines?|L)\s*|第\s*|行\s*)(\d{1,7})(?:\s*(?:[-–—~]|to|至|到)\s*(?:L|第)?\s*(\d{1,7}))?/i;

/** Split a model answer into sections at ##–#### headings (outside code fences). */
export function parseSections(markdown: string, span: LineSpan): ExplanationSection[] {
  const out: ExplanationSection[] = [];
  let cur: ExplanationSection | undefined;
  let fence: string | undefined;
  const intro: string[] = [];
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence ? (line.trim().startsWith(fence) ? undefined : fence) : f[1];
    const h = !fence && !f ? HEADING.exec(line) : null;
    if (h) {
      // Small models sometimes nest markers ("#### ### Line 10: ..."); keep only the text.
      cur = { title: h[2].replace(/^(?:#+\s*)+/, '').trim(), body: '' };
      const r = RANGE.exec(cur.title);
      if (r) {
        const a = Number(r[1]);
        const b = r[2] ? Number(r[2]) : a;
        cur.startLine = Math.min(a, b);
        cur.endLine = Math.max(a, b);
        cur.rangeValid = cur.startLine >= span.startLine && cur.endLine <= span.endLine;
      }
      out.push(cur);
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    } else {
      intro.push(line);
    }
  }
  for (const s of out) s.body = s.body.trim();
  const introText = intro.join('\n').trim();
  return introText ? [{ title: '', body: introText }, ...out] : out;
}

/** Non-blank lines of `span` not covered by any valid section range (line-by-line completeness check). */
export function uncoveredCode(sections: ExplanationSection[], span: LineSpan, text: string): LineSpan[] {
  const lines = text.split(/\r?\n/);
  const covered = new Set<number>();
  for (const s of sections) if (s.rangeValid && s.startLine) for (let i = s.startLine; i <= (s.endLine ?? s.startLine); i++) covered.add(i);
  const gaps: LineSpan[] = [];
  for (let i = span.startLine; i <= span.endLine; i++) {
    const t = (lines[i - 1] ?? '').trim();
    if (!t || covered.has(i) || /^(#|\/\/|\*|\/\*|\*\/)/.test(t) || /^[)\]};,]+$/.test(t)) continue;
    const last = gaps[gaps.length - 1];
    if (last && last.endLine >= i - 2) last.endLine = i;
    else gaps.push({ startLine: i, endLine: i });
  }
  return gaps;
}

/** File outline from the text parser (no model). */
export function outline(text: string, family: 'python' | 'c-like', max = 80): Array<{ line: number; text: string }> {
  const lines = text.split(/\r?\n/);
  return listFunctionRanges(text, family)
    .slice(0, max)
    .map((d) => {
      let at = d.startLine;
      for (let i = d.startLine; i <= Math.min(d.endLine, d.startLine + 10); i++) {
        if ((lines[i] ?? '').includes(d.name) && !/^\s*@/.test(lines[i])) {
          at = i;
          break;
        }
      }
      return { line: at + 1, text: `${d.kind} ${(lines[at] ?? '').trim().slice(0, 160)}` };
    });
}

/** Import lines of a file (bounded), for chunk context. */
export function importLines(text: string, max = 30): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < Math.min(lines.length, 200) && out.length < max; i++) {
    if (/^\s*(import\s|from\s+\S+\s+import\s|(?:const|let|var)\s+[\w{}\s,]+=\s*require\(|#include\s|using\s+[\w.]+;|package\s)/.test(lines[i])) out.push({ line: i + 1, text: lines[i].slice(0, 300) });
  }
  return out;
}

// ------------------------------------------------------------------ records

export type PartStatus = 'pending' | 'streaming' | 'done' | 'cancelled' | 'error';

export interface ExplanationPart {
  chunk: ExplainChunk;
  status: PartStatus;
  text: string;
  error?: string;
  cached?: boolean;
  durationMs?: number;
  sections: ExplanationSection[];
  /** Line-by-line: non-blank lines no section covers (the model skipped them). */
  gaps: LineSpan[];
}

export interface ExplanationRecord {
  id: string;
  createdAt: string;
  finishedAt?: string;
  file: {
    uri: string;
    fsPath: string;
    relPath: string;
    languageId: string;
    /** Editor document version and SHA-256 of the exact text that was analyzed. */
    version: number;
    hash: string;
    /** The analysis used unsaved editor contents. */
    dirty: boolean;
    lineCount: number;
  };
  scope: ExplainScope;
  mode: ExplainMode;
  target: LineSpan & { symbolName?: string; symbolKind?: string };
  model: string;
  language: ResponseLanguage;
  plan: ChunkPlan;
  parts: ExplanationPart[];
  synthesis?: ExplanationPart;
  status: 'running' | 'done' | 'cancelled' | 'error';
  error?: string;
  /** Source changed after the analysis (hash differs). */
  stale?: boolean;
}

export function scopeText(r: Pick<ExplanationRecord, 'scope' | 'target' | 'file'>): string {
  if (r.scope === 'file') return `entire file ${r.file.relPath}`;
  if (r.scope === 'symbol') return `${r.target.symbolKind ?? 'definition'} ${r.target.symbolName ?? ''} (${formatSpan(r.target)})`.replace(/\s+/g, ' ');
  return `selected code (${formatSpan(r.target)})`;
}

/** Markdown export: metadata, honesty notes, then the explanation with line ranges. */
export function renderExplanationMarkdown(r: ExplanationRecord): string {
  const out: string[] = [
    `# ${r.mode === 'structured' ? 'Structured explanation' : 'Line-by-line explanation'}: ${r.file.relPath}`,
    '',
    `> Model-generated by the local model \`${r.model}\`. Not verified by execution; [Fact]/[Inference]/[Issue] labels are the model's own.`,
    '',
    `- Source: \`${r.file.fsPath}\``,
    `- Scope: ${scopeText(r)}`,
    `- Analyzed: ${r.plan.analyzed.map(formatSpan).join(', ') || 'nothing'} of ${r.file.lineCount} lines${r.plan.partial ? ` — **partial: ${r.plan.omitted.map(formatSpan).join(', ')} not analyzed**` : ''}`,
    `- Source version: ${r.file.version}${r.file.dirty ? ' (unsaved editor contents)' : ''} · sha256 ${r.file.hash.slice(0, 16)}`,
    `- Model: ${r.model} · language: ${r.language} · started ${r.createdAt}${r.finishedAt ? ` · finished ${r.finishedAt}` : ''} · status: ${r.status}`,
  ];
  if (r.stale) out.push('', '> ⚠ The source changed after this analysis; line numbers and content may no longer match.');
  const part = (p: ExplanationPart, heading: string) => {
    out.push('', `## ${heading}`, '');
    if (p.chunk.context.length) out.push(`_Context: ${p.chunk.context.join(' › ')}_`, '');
    if (p.status !== 'done') out.push(`_${p.status}${p.error ? `: ${p.error}` : ''}_`, '');
    for (const s of p.sections) {
      if (s.title) out.push(`### ${s.title}${s.rangeValid === false ? ' _(range outside the analyzed lines)_' : ''}`, '');
      out.push(s.body, '');
    }
    if (!p.sections.length && p.text) out.push(p.text, '');
    if (p.gaps.length) out.push(`_Not covered by the model: ${p.gaps.map(formatSpan).join(', ')}_`, '');
  };
  if (r.synthesis) part(r.synthesis, 'Overall');
  r.parts.forEach((p) => part(p, r.parts.length > 1 ? `Part ${p.chunk.index + 1}/${r.parts.length} · ${formatSpan(p.chunk)}` : formatSpan(p.chunk).replace(/^l/, 'L')));
  return redactSecrets(out.join('\n').replace(/\n{3,}/g, '\n\n')) + '\n';
}
