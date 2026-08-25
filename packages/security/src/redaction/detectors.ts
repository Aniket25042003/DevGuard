/**
 * C093 — Shared detector registry used identically by redaction and
 * publication scanning, so both controls always see the same classes.
 *
 * Confidence metadata is publication-specific; redaction replaces regardless.
 */
export interface DetectorDef {
  readonly id: string;
  readonly pattern: RegExp;
  readonly confidence: 'high' | 'medium' | 'low';
}

export const DETECTOR_REGISTRY: readonly DetectorDef[] = Object.freeze([
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g, confidence: 'high' },
  { id: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g, confidence: 'high' },
  { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, confidence: 'high' },
  {
    id: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    confidence: 'high',
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
    confidence: 'medium',
  },
  { id: 'slack_token', pattern: /\bxox[abpos]--[A-Za-z0-9-]{10,}\b/g, confidence: 'high' },
  {
    id: 'dsn_credentials',
    pattern: /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^:\s]+:[^@\s]+@/g,
    confidence: 'medium',
  },
  {
    id: 'url_userinfo',
    pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/g,
    confidence: 'medium',
  },
  { id: 'bearer_header', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, confidence: 'medium' },
  {
    id: 'assigned_secret',
    pattern:
      /\b(api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|token)\b\s*[:=]\s*['"]?[^\s'"<>]{6,}['"]?/gi,
    confidence: 'medium',
  },
]);

export interface ExactMatch {
  /** The raw matched bytes — internal to the guard; never logged. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}
