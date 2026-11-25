import { redactSecrets } from '../recorder/redaction';
import type { ResponseLanguage } from './prompts';

export interface ReviewOutputContext {
  filePath: string;
  evidence: Record<'before' | 'after', Record<number, string>>;
  incomplete: boolean;
  fingerprint: string;
  explainOnly?: boolean;
  files?: Array<{
    filePath: string;
    evidence: ReviewOutputContext['evidence'];
    changedLines: Record<'before' | 'after', ReadonlySet<number>>;
    incomplete: boolean;
  }>;
}

const labels = {
  en: {
    change: 'Change',
    confirmed: 'Confirmed issue', risk: 'Potential risk', insufficient: 'Insufficient context',
    clean: 'No issues found.', incomplete: 'Some change context was unavailable.',
    invalid: 'Some review output could not be verified against the supplied code.',
  },
  'zh-CN': {
    change: '变更',
    confirmed: '已确认问题', risk: '潜在风险', insufficient: '上下文不足',
    clean: '未发现问题。', incomplete: '部分变更上下文不可用。',
    invalid: '部分审查结果无法根据提供的代码核实。',
  },
};

export type ItemStatus = 'change' | 'confirmed' | 'risk' | 'insufficient';

/** One model claim whose quote was found on the cited line of the code that was actually sent. */
export interface VerifiedItem {
  /** 1-based index into `context.files` (1 for a single-file context). */
  file: number;
  filePath: string;
  status: ItemStatus;
  side: 'before' | 'after';
  line: number;
  quote: string;
  message: string;
}

/**
 * Parse the model's JSON array and keep only claims backed by the supplied evidence.
 * `summary` (optional, at most one, `allowSummary` only) is the model's overall explanation: it
 * cites no line, so it is returned separately and never counts as verified evidence.
 */
export function verifyReviewItems(raw: string, context: ReviewOutputContext, allowSummary = false): { items: VerifiedItem[]; summary?: string; valid: boolean } {
  let parsed: unknown;
  let partial = false;
  const text = raw.trim();
  const body = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text)?.[1] ?? text;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Small local models sometimes break one object of an otherwise usable array: keep the objects
    // that parse on their own (each is still verified below) and mark the answer as not fully valid.
    const objects = (body.match(/\{[^{}]*\}/g) ?? []).flatMap((o) => { try { return [JSON.parse(o)]; } catch { return []; } });
    if (/^\s*\[/.test(body) && objects.length) {
      parsed = objects;
      partial = true;
    }
  }
  let valid = Array.isArray(parsed) && !partial;
  let summary: string | undefined;
  const items: VerifiedItem[] = [];
  // A file named by its path instead of its number is accepted when it matches exactly one file.
  const byPath = (name: string): number | undefined => {
    const n = /^File\s+(\d+)\b/i.exec(name.trim());
    if (n) return Number(n[1]);
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const all = context.files ?? [context];
    const hits = all.map((f, i) => [norm(f.filePath), i] as const).filter(([p]) => p === norm(name) || p.endsWith('/' + norm(name)));
    return hits.length === 1 ? hits[0][1] + 1 : undefined;
  };
  for (const raw of Array.isArray(parsed) ? parsed : []) {
    if (allowSummary && raw?.status === 'summary' && typeof raw.message === 'string' && raw.message.trim() && summary === undefined) {
      summary = redactSecrets(raw.message.trim().replace(/\s+/g, ' '));
      continue;
    }
    const item = raw && typeof raw.file === 'string' ? { ...raw, file: byPath(raw.file) } : raw;
    const { status, side, line, quote, message, file = context.files && context.files.length > 1 ? undefined : 1 } = item ?? {};
    const source = Number.isSafeInteger(file) && file >= 1
      ? context.files ? context.files[file - 1] : file === 1 ? context : undefined
      : undefined;
    if (!source || (status !== 'change' && status !== 'confirmed' && status !== 'risk' && status !== 'insufficient') ||
      (side !== 'before' && side !== 'after') || !Number.isSafeInteger(line) || line < 1 ||
      typeof quote !== 'string' || !quote.trim() ||
      !source.evidence[side as 'before' | 'after'][line]?.includes(quote.trim()) ||
      (status !== 'insufficient' && context.files && !context.files[file - 1].changedLines[side as 'before' | 'after'].has(line)) ||
      typeof message !== 'string' || !message.trim()) {
      valid = false;
      continue;
    }
    items.push({ file, filePath: source.filePath, status, side, line, quote: quote.trim(), message: redactSecrets(message.trim().replace(/\s+/g, ' ')) });
  }
  return { items, summary, valid };
}

export function itemLabel(status: ItemStatus | 'summary' | 'incomplete' | 'invalid' | 'clean', language: ResponseLanguage): string {
  const all = { ...labels, en: { ...labels.en, summary: 'Overall' }, 'zh-CN': { ...labels['zh-CN'], summary: '总体' } } as Record<'en' | 'zh-CN', Record<string, string>>;
  return language === 'bilingual' ? `${all['zh-CN'][status]} / ${all.en[status]}` : all[language][status];
}

/** One verified item as a Markdown bullet (quote shown as evidence). */
export function itemEntry(item: VerifiedItem, language: ResponseLanguage): string {
  const evidence = JSON.stringify(item.quote).replace(/`/g, '\\u0060');
  return `- **${itemLabel(item.status, language)}** ${item.filePath}:${item.line} (${item.side}) \`${evidence}\` — ${item.message}`;
}

export function formatReviewOutput(raw: string, context: ReviewOutputContext, language: ResponseLanguage, allowSummary = false) {
  const label = (key: keyof typeof labels.en) => language === 'bilingual'
    ? `${labels['zh-CN'][key]} / ${labels.en[key]}` : labels[language][key];
  const lines: string[] = [];
  const explanations: string[] = [];
  const verified = verifyReviewItems(raw, context, allowSummary);
  let valid = verified.valid;
  const seen = new Set<string>();
  const explained = new Set<number>();
  const anchors = new Set<string>();
  for (const item of verified.items) {
    const { status, side, line, file } = item;
    const summary = item.message;
    const entry = itemEntry(item, language);
    if (status === 'change') {
      if (!explained.has(file)) explanations.push(entry);
      explained.add(file);
      continue;
    }
    const key = JSON.stringify([file, summary.toLowerCase().replace(/[\p{P}\s]+/gu, ' ').trim()]);
    const anchor = JSON.stringify([file, status, side, line]);
    if (seen.has(key) || anchors.has(anchor)) continue;
    seen.add(key);
    anchors.add(anchor);
    if (lines.length < 5) lines.push(entry);
  }
  if (context.incomplete) {
    const files = context.files?.filter((file) => file.incomplete).map((file) => file.filePath);
    lines.push(`**${label('insufficient')}** ${label('incomplete')}${files?.length ? ` (${files.join(', ')})` : ''}`);
  }
  if (!valid) lines.push(`**${label('insufficient')}** ${label('invalid')}`);
  if (context.explainOnly && context.files?.some((file, index) => !file.incomplete &&
    (file.changedLines.before.size || file.changedLines.after.size) && !explained.has(index + 1))) {
    if (valid) lines.push(`**${label('insufficient')}** ${label('invalid')}`);
    valid = false;
  }
  if (!lines.length && (!context.explainOnly || !explanations.length)) lines.push(label('clean'));
  const overall = verified.summary ? [`**${itemLabel('summary', language)}** — ${verified.summary}`, ''] : [];
  return { text: [...overall, ...explanations, ...lines].join('\n'), cacheable: valid };
}
