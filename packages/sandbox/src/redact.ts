/**
 * C041/C042 — self-contained output/log redaction.
 *
 * Boundary note: @devguard/logging (application layer) may be consumed by
 * this package only as type imports, so the redaction rules are mirrored here
 * (same marker style as C061) to keep secrets out of logs, persisted evidence,
 * and command output. Provider messages and command output are treated as
 * untrusted before they reach any sink.
 */

/** Known redaction paths plus secret-pattern defense-in-depth (C061 §5 mirror). */
const REDACTION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = Object.freeze([
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{10,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'bearer', pattern: /(?:authorization|auth)\s*[:=]\s*"?Bearer\s+[^\s",}]+/gi },
  { name: 'redis-url-credentials', pattern: /redis:\/\/[^/\s:]+:[^@\s/]+@/g },
  { name: 'postgres-url-credentials', pattern: /postgres(?:ql)?:\/\/[^/\s:]+:[^@\s/]+@/g },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { name: 'webhook-secret-shape', pattern: /\b(?:(?:sha256|sha1)=)?[a-f0-9]{40,64}\b/gi },
]);

/**
 * Redact a free-form string surface. Returns the original string with every
 * match replaced by a `[REDACTED:<name>]` marker — never the secret value.
 */
export function redactText(text: string): string {
  let out = text;
  for (const { name, pattern } of REDACTION_PATTERNS) {
    out = out.replace(pattern, `[REDACTED:${name}]`);
  }
  return out;
}

/**
 * Deep redaction over untrusted field values before log/evidence assembly.
 * Keys that look secret are replaced wholesale; nested values are redacted
 * recursively. Non-string scalars pass through unchanged.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|credential|private_?key|authorization/i.test(key)) {
        out[key] = '[REDACTED:key-name]';
      } else {
        out[key] = redactValue(child);
      }
    }
    return out;
  }
  return value;
}

/** True when the value contains any secret-shaped content (used by tests). */
export function containsSecretLike(value: string): boolean {
  return REDACTION_PATTERNS.some(({ pattern }) => pattern.test(value));
}
