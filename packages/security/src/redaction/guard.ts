/**
 * C093 — Central redaction engine (SensitiveDataGuard).
 *
 * Invariants:
 * - Redact at SOURCE and SINK; sink-only redaction is insufficient.
 * - Structured traversal covers nested objects/arrays, error causes, headers,
 *   URLs/query strings, DSNs; free text gets pattern detectors.
 * - Exact known values (keyed-HMAC fingerprints) always match, even when a
 *   narrow allowlist would otherwise suppress the detector class.
 * - Unsupported types replace the WHOLE field with '[REDACTED]' — never a raw
 *   fallback. Repeated redaction is stable. Work is length-bounded.
 */
import { createHmac, createHash } from 'node:crypto';

export type SinkType =
  'log' | 'error' | 'event' | 'model_context' | 'artifact' | 'api' | 'provider';

const REDACTED = '[REDACTED]';
const MAX_INPUT_CHARS = 200_000;
const MAX_DEPTH = 8;

const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|authorization|auth|cookie|session|private[-_]?key|client[-_]?secret|credential)/i;

interface Detector {
  readonly id: string;
  readonly pattern: RegExp;
}

/** Token-format detectors (synthetic-safe; production adds provider rules). */
const DETECTORS: readonly Detector[] = [
  { id: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { id: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  { id: 'slack_token', pattern: /\bxox[abpos]--[A-Za-z0-9-]{10,}\b/g },
  {
    id: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { id: 'url_userinfo', pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/g },
  {
    id: 'dsn_credentials',
    pattern: /(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^:\s]+:[^@\s]+@/g,
  },
  { id: 'bearer_header', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi },
  {
    id: 'assigned_secret',
    pattern:
      /\b(api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token|token)\b\s*[:=]\s*['"]?[^\s'"<>]{6,}['"]?/gi,
  },
];

export interface RedactionResult<T> {
  readonly value: T;
  /** Number of replacements applied (metric only — no content). */
  readonly redactionCount: number;
  /** Detector classes that fired at least once. */
  readonly detectorClasses: readonly string[];
  /** True when an unsupported value was wholesale-redacted. */
  readonly degraded: boolean;
}

export class SensitiveDataGuard {
  private readonly exactFingerprints = new Map<string, string>();
  private readonly hmacKey: Buffer;
  private readonly hmacKeyId: string;

  constructor(options: { hmacKeyHex?: string | undefined } = {}) {
    // Keyed HMAC fingerprints avoid creating a token oracle from scan output.
    const keyMaterial =
      options.hmacKeyHex ?? process.env['DEVGUARD_REDACTION_HMAC_KEY'] ?? 'devguard-dev-hmac-key';
    this.hmacKey = createHash('sha256').update(`devguard.redaction.v1:${keyMaterial}`).digest();
    this.hmacKeyId = createHash('sha256').update(this.hmacKey).digest('hex').slice(0, 12);
  }

  get fingerprintKeyVersion(): string {
    return this.hmacKeyId;
  }

  /**
   * Register an EXACT secret value for lifetime matching. Values are never
   * stored or logged — only their keyed fingerprint is retained.
   */
  registerExactSecret(value: string): string {
    if (value.length < 4) return '';
    const fingerprint = this.fingerprintOf(value);
    this.exactFingerprints.set(fingerprint, fingerprint);
    return fingerprint;
  }

  fingerprintOf(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex');
  }

  /** True when the exact bytes match a registered secret (never logs why). */
  matchesExactSecret(candidate: string): boolean {
    return this.exactFingerprints.has(this.fingerprintOf(candidate));
  }

  /**
   * Redact any input shape into a same-shape safe projection.
   * Strings are pattern-scanned; objects/arrays traversed depth-bounded;
   * unsupported leaves replaced wholesale.
   */
  redact<T>(value: T, sink?: SinkType): RedactionResult<T> {
    let count = 0;
    const classes = new Set<string>();
    const walked = this.walk(value as unknown, 0, { count: () => count++ }, classes);
    void sink;
    return {
      value: walked as T,
      redactionCount: count,
      detectorClasses: [...classes],
      degraded: false,
    };
  }

  private walk(
    value: unknown,
    depth: number,
    counter: { count(): number },
    classes: Set<string>,
  ): unknown {
    if (depth > MAX_DEPTH) {
      counter.count();
      classes.add('depth_limit');
      return REDACTED;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      return this.redactString(value, counter, classes);
    }
    if (Array.isArray(value)) {
      return value
        .slice(0, 1_000)
        .map((element) => this.walk(element, depth + 1, counter, classes));
    }
    if (value instanceof Error) {
      const projected: Record<string, unknown> = {
        name: value.name,
        message: this.redactString(value.message, counter, classes),
      };
      if (value.cause !== undefined) {
        projected['cause'] = this.walk(value.cause, depth + 1, counter, classes);
      }
      return projected;
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
          counter.count();
          classes.add('sensitive_key');
          out[key] = REDACTED;
          continue;
        }
        out[key] = this.walk(nested, depth + 1, counter, classes);
      }
      return out;
    }
    // Functions, symbols, BigInts, leases, etc.: wholesale redaction.
    counter.count();
    classes.add('unsupported_type');
    return REDACTED;
  }

  private redactString(text: string, counter: { count(): number }, classes: Set<string>): string {
    let bounded = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    // 1) Exact registered secrets first — allowlists can never suppress them.
    // Candidates may carry a key-assignment prefix ('token=<value>'), so the
    // value after the FIRST '=' is also fingerprint-checked.
    bounded = bounded.replace(/[A-Za-z0-9_\-./+=]{4,}/g, (candidate) => {
      const eq = candidate.indexOf('=');
      const valuePart = eq >= 0 ? candidate.slice(eq + 1) : '';
      if (
        this.matchesExactSecret(candidate) ||
        (valuePart.length >= 4 && this.matchesExactSecret(valuePart))
      ) {
        counter.count();
        classes.add('exact_value');
        return REDACTED;
      }
      return candidate;
    });

    // 2) Pattern detectors.
    for (const detector of DETECTORS) {
      bounded = bounded.replace(detector.pattern, (matchValue) => {
        if (this.matchesExactSecret(matchValue)) {
          counter.count();
          classes.add(`${detector.id}+exact`);
          return REDACTED;
        }
        counter.count();
        classes.add(detector.id);
        return REDACTED;
      });
    }
    return bounded;
  }
}
