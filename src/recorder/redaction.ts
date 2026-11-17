/**
 * Best-effort secret redaction applied to everything the recorder stores.
 * This is defence in depth, not a guarantee: adapters should avoid sending
 * secrets in the first place.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization header schemes (must run before the key=value rule, which
  // would otherwise redact only the word "Bearer" and leave the token).
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]'],
  // key=value / key: value style secrets
  [
    /\b((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|pwd|auth|authorization)\s*[=:]\s*)(?!(?:Bearer|Basic) \[REDACTED\])("[^"]*"|'[^']*'|\S+)/gi,
    '$1[REDACTED]',
  ],
  // Well-known token shapes
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  // Credentials embedded in URLs: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[REDACTED]@'],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} characters]`;
}

export function sanitize(text: string | undefined, maxChars: number): string | undefined {
  return text === undefined ? undefined : truncate(redactSecrets(text), maxChars);
}
