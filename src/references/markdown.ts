import { CodeReference, findReferences, hasForeignScheme, matchReferenceAt, parseReferenceTarget } from './codeReference';

/**
 * Small, safe Markdown parser for agent messages.
 *
 * It produces a whitelisted AST (no HTML), which the webviews render with
 * DOM APIs and `textContent` only, so raw HTML, `javascript:` links and
 * script injection in agent output are shown as text. Block structure is
 * parsed line by line and inline structure with a character scanner
 * (backtick runs, balanced brackets/parentheses), so paths with spaces in
 * link destinations and pipes inside code spans in tables survive.
 *
 * Supported: paragraphs (single newlines kept as line breaks), ATX headings,
 * fenced code, GFM tables, ordered/unordered (nested) lists, block quotes,
 * thematic breaks, code spans, links, autolinks, bare URLs, emphasis, strong,
 * strikethrough, and file references (`a.py:12`, `src/x.ts#L3`, ...).
 */

export type Ref = CodeReference & { /** Line range in the explained file itself (explanation panel). */ self?: boolean };

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'code'; c: Inline[] }
  | { t: 'em' | 'strong' | 'del'; c: Inline[] }
  /** External link: only http(s)/mailto. Never opened without confirmation. */
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'ref'; ref: Ref; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'pre'; lang?: string; v: string }
  | { t: 'ul'; items: Block[][] }
  | { t: 'ol'; start: number; items: Block[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; align: Array<'left' | 'right' | 'center' | null>; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

export interface ParseOptions {
  /**
   * Also link "Lines 12–20" / "line 7" / "L7" / "第 12–20 行" to this file
   * (explanation panel). Refs created this way carry `self: true`.
   */
  lineRefsFor?: string;
}

const MAX_INPUT = 300_000;
const MAX_DEPTH = 8;

export function parseMarkdown(text: string, options: ParseOptions = {}): Block[] {
  const src = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text;
  const blocks = parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'), options, 0);
  if (text.length > MAX_INPUT) blocks.push({ t: 'p', c: [{ t: 'text', v: `… [${text.length - MAX_INPUT} more characters not rendered]` }] });
  return blocks;
}

/** Plain text (user messages): keep every character and line break, only link file references. */
export function parsePlain(text: string): Block[] {
  const lines = text.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n');
  const c: Inline[] = [];
  lines.forEach((line, i) => {
    if (i) c.push({ t: 'br' });
    c.push(...linkify(line));
  });
  return [{ t: 'p', c }];
}

// ------------------------------------------------------------------ blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function isBlank(l: string): boolean {
  return /^\s*$/.test(l);
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line);
}

function parseBlocks(lines: string[], options: ParseOptions, depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      out.push({ t: 'pre', lang: fence[2] || undefined, v: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2] ?? '', options) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) {
        const q = QUOTE.exec(lines[i]);
        body.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push({ t: 'quote', c: parseBlocks(body, options, depth + 1) });
      continue;
    }
    if ((BULLET.test(line) || ORDERED.test(line)) && depth < MAX_DEPTH) {
      const [block, next] = parseList(lines, i, options, depth);
      out.push(block);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => {
        const s = c.trim();
        return s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null;
      });
      if (head.length === align.length) {
        i += 2;
        const rows: Inline[][][] = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) {
          const cells = splitRow(lines[i++]);
          rows.push(head.map((_, k) => parseInline((cells[k] ?? '').trim(), options)));
        }
        out.push({ t: 'table', align, head: head.map((h) => parseInline(h.trim(), options)), rows });
        continue;
      }
    }
    // Paragraph: consecutive lines that do not start another block.
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-'))) {
      para.push(lines[i++]);
    }
    const c: Inline[] = [];
    para.forEach((l, k) => {
      if (k) c.push({ t: 'br' });
      c.push(...parseInline(k < para.length - 1 ? l.replace(/\s+$/, '') : l.trim(), options));
    });
    out.push({ t: 'p', c });
  }
  return out;
}

function parseList(lines: string[], start: number, options: ParseOptions, depth: number): [Block, number] {
  const first = ORDERED.exec(lines[start]);
  const ordered = !!first;
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
    if (!m) break;
    const indent = ordered ? m[1].length + m[2].length + m[3].length + m[4].length : m[1].length + m[2].length + m[3].length;
    const body = [ordered ? m[5] : m[4]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // A blank line continues the item only if the next line is indented into it.
        if (i + 1 < lines.length && /^\s+/.test(lines[i + 1]) && lines[i + 1].length - lines[i + 1].trimStart().length >= Math.min(indent, 2)) {
          body.push('');
          i++;
          continue;
        }
        break;
      }
      const lead = l.length - l.trimStart().length;
      if (lead >= Math.min(indent, 4) && lead > 0) {
        body.push(l.slice(Math.min(lead, indent)));
        i++;
      } else if (!startsBlock(l)) {
        body.push(l); // lazy continuation
        i++;
      } else {
        break;
      }
    }
    items.push(parseBlocks(body, options, depth + 1));
    while (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length && (ordered ? ORDERED : BULLET).test(lines[i + 1])) i++;
  }
  return [ordered ? { t: 'ol', start: Number(first![2]), items } : { t: 'ul', items }, i];
}

/** Split a table row on unescaped pipes that are not inside code spans. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0) {
        cur += s.slice(i, close + run.length);
        i = close + run.length - 1;
      } else {
        cur += run;
        i += run.length - 1;
      }
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

// ------------------------------------------------------------------ inline

const PUNCT = /[!-/:-@[-`{-~]/;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/iy;
const LINE_REF = /(?:\b(?:[Ll]ines?|L)\s?(\d{1,7})(?:\s?(?:[-–—~]|to)\s?L?(\d{1,7}))?\b|第\s?(\d{1,7})(?:\s?[-–—~至到]\s?(?:第\s?)?(\d{1,7}))?\s?行|行\s?(\d{1,7})(?:\s?[-–—~至到]\s?(\d{1,7}))?)/y;

export function parseInline(text: string, options: ParseOptions = {}, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  const push = (node: Inline) => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // Escapes
    if (ch === '\\' && i + 1 < text.length && PUNCT.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    // Code span: a run of N backticks closed by a run of exactly N.
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const close = findBacktickRun(text, i + run.length, run.length);
      if (close >= 0) {
        let code = text.slice(i + run.length, close);
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        push({ t: 'code', c: codeChildren(code) });
        i = close + run.length;
      } else {
        buf += run;
        i += run.length;
      }
      continue;
    }
    // Links [label](destination "title")
    if (ch === '[' && depth < MAX_DEPTH) {
      const link = parseLinkAt(text, i);
      if (link) {
        const label = parseInline(link.label, { ...options, lineRefsFor: undefined }, depth + 1);
        push(classifyLink(link.dest, label.length ? label : [{ t: 'text', v: link.dest }]));
        i = link.end;
        continue;
      }
    }
    // Autolinks <https://...>
    if (ch === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (m) {
        push({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    // Bare URLs (GFM-style), before file references so "https://x/a.py" stays a URL.
    if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') && (i === 0 || !/[\w/.]/.test(text[i - 1]))) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(text);
      if (m) {
        let url = m[0].replace(/[.,;:!?'")\]]+$/, '');
        // keep balanced trailing ")" (e.g. wikipedia links)
        while (url.endsWith(')') && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
        push({ t: 'link', href: /^www\./i.test(url) ? `https://${url}` : url, c: [{ t: 'text', v: url }] });
        i += url.length;
        continue;
      }
    }
    // file:// URLs in prose (spaces must be %20-encoded there).
    if ((ch === 'f' || ch === 'F') && /^file:\/\//i.test(text.slice(i, i + 7)) && (i === 0 || !/[\w/.]/.test(text[i - 1]))) {
      const m = /^file:\/\/[^\s<>"'`]+/i.exec(text.slice(i));
      const raw = m ? m[0].replace(/[.,;!?'")\]]+$/, '') : '';
      const fileRef = raw ? parseReferenceTarget(raw) : undefined;
      if (fileRef) {
        push({ t: 'ref', ref: fileRef, c: [{ t: 'text', v: raw }] });
        i += raw.length;
        continue;
      }
    }
    // File references in prose.
    const ref = matchReferenceAt(text, i);
    if (ref) {
      push({ t: 'ref', ref: ref.ref, c: [{ t: 'text', v: text.slice(ref.start, ref.end) }] });
      i = ref.end;
      continue;
    }
    // "Lines 12–20" in explanations of a single file.
    if (options.lineRefsFor && /[LlL第行]/.test(ch) && (i === 0 || !/[\w]/.test(text[i - 1]))) {
      LINE_REF.lastIndex = i;
      const m = LINE_REF.exec(text);
      if (m) {
        const start = Number(m[1] ?? m[3] ?? m[5]);
        const endRaw = m[2] ?? m[4] ?? m[6];
        const end = endRaw ? Number(endRaw) : undefined;
        if (start >= 1) {
          push({ t: 'ref', ref: { path: options.lineRefsFor, line: start, endLine: end && end > start ? end : undefined, self: true }, c: [{ t: 'text', v: m[0] }] });
          i += m[0].length;
          continue;
        }
      }
    }
    // Emphasis / strong / strikethrough
    if ((ch === '*' || ch === '_' || ch === '~') && depth < MAX_DEPTH) {
      const em = parseEmphasisAt(text, i, options, depth);
      if (em) {
        push(em.node);
        i = em.end;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function findBacktickRun(text: string, from: number, n: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let j = i;
    while (j < text.length && text[j] === '`') j++;
    if (j - i === n) return i;
    i = j;
  }
  return -1;
}

/** Code span content: a whole-span reference, else text with embedded references ("python scripts/run.py"). */
function codeChildren(code: string): Inline[] {
  const whole = parseReferenceTarget(code, { strict: true });
  if (whole) return [{ t: 'ref', ref: whole, c: [{ t: 'text', v: code }] }];
  const out: Inline[] = [];
  let last = 0;
  for (const m of findReferences(code)) {
    if (m.start > last) out.push({ t: 'text', v: code.slice(last, m.start) });
    out.push({ t: 'ref', ref: m.ref, c: [{ t: 'text', v: code.slice(m.start, m.end) }] });
    last = m.end;
  }
  if (last < code.length) out.push({ t: 'text', v: code.slice(last) });
  return out;
}

/** Linkify plain text (no Markdown) — URLs stay text, only file references become nodes. */
export function linkify(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of findReferences(text)) {
    // Skip matches that are part of a URL.
    const before = text.slice(0, m.start);
    if (/(?:https?:\/\/|www\.)\S*$/i.test(before)) continue;
    if (m.start > last) out.push({ t: 'text', v: text.slice(last, m.start) });
    out.push({ t: 'ref', ref: m.ref, c: [{ t: 'text', v: text.slice(m.start, m.end) }] });
    last = m.end;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

function parseLinkAt(text: string, i: number): { label: string; dest: string; end: number } | undefined {
  // Matching ']' (nested brackets, code spans and escapes respected).
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(text.slice(j))![0];
      const close = findBacktickRun(text, j + run.length, run.length);
      if (close >= 0) j = close + run.length - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) break;
  }
  if (j >= text.length || text[j + 1] !== '(') return undefined;
  const label = text.slice(i + 1, j);
  // Destination: <...> or up to the matching ')' — spaces allowed (Windows paths).
  let k = j + 2;
  let dest: string;
  if (text[k] === '<') {
    const close = text.indexOf('>', k);
    if (close < 0) return undefined;
    dest = text.slice(k + 1, close);
    k = close + 1;
    while (k < text.length && text[k] !== ')') k++;
    if (k >= text.length) return undefined;
  } else {
    let parens = 1;
    let m = k;
    for (; m < text.length; m++) {
      if (text[m] === '\\') {
        m++;
        continue;
      }
      if (text[m] === '(') parens++;
      else if (text[m] === ')' && --parens === 0) break;
      if (text[m] === '\n') return undefined;
    }
    if (m >= text.length) return undefined;
    dest = text.slice(k, m);
    k = m;
    const title = /^(.*?)\s+(?:"[^"]*"|'[^']*')\s*$/.exec(dest);
    if (title) dest = title[1];
  }
  return { label, dest: dest.trim(), end: k + 1 };
}

function classifyLink(dest: string, label: Inline[]): Inline {
  if (/^(?:https?:\/\/|mailto:)/i.test(dest)) return { t: 'link', href: dest, c: label };
  const ref = hasForeignScheme(dest) ? undefined : parseReferenceTarget(dest);
  if (ref) return { t: 'ref', ref, c: stripRefs(label) };
  // Unknown scheme (javascript:, command:, data:, vscode:, ...) or an anchor: show the label as text only.
  return { t: 'em', c: stripRefs(label) };
}

/** A link's label must not contain nested refs/links (the whole label is the target). */
function stripRefs(nodes: Inline[]): Inline[] {
  return nodes.map((n): Inline => (n.t === 'ref' || n.t === 'link' ? { t: 'text', v: textOf(n.c) } : 'c' in n ? { ...n, c: stripRefs(n.c) } : n));
}

export function textOf(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.v : n.t === 'br' ? '\n' : textOf(n.c))).join('');
}

function parseEmphasisAt(text: string, i: number, options: ParseOptions, depth: number): { node: Inline; end: number } | undefined {
  const ch = text[i];
  const prev = i > 0 ? text[i - 1] : ' ';
  let n = 1;
  while (text[i + n] === ch && n < 3) n++;
  if (ch === '~' && n !== 2) return undefined;
  const marker = ch.repeat(Math.min(n, ch === '~' ? 2 : n === 3 ? 2 : n));
  const after = text[i + marker.length];
  if (!after || /\s/.test(after)) return undefined;
  if (ch === '_' && /[A-Za-z0-9]/.test(prev)) return undefined; // snake_case is not emphasis
  let from = i + marker.length;
  for (;;) {
    const close = text.indexOf(marker, from);
    if (close < 0) return undefined;
    const before = text[close - 1];
    const next = text[close + marker.length];
    const ok = close > i + marker.length && !/\s/.test(before) && !(ch === '_' && next && /[A-Za-z0-9]/.test(next)) && text[close + marker.length] !== ch;
    if (ok) {
      const inner = parseInline(text.slice(i + marker.length, close), options, depth + 1);
      const t = ch === '~' ? 'del' : marker.length === 2 ? 'strong' : 'em';
      return { node: { t, c: inner }, end: close + marker.length };
    }
    from = close + 1;
  }
}
