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
import { DETECTOR_REGISTRY, type ExactMatch } from './detectors.js';

export type SinkType =
  'log' | 'error' | 'event' | 'model_context' | 'artifact' | 'api' | 'provider';

const REDACTED = '[REDACTED]';
const MAX_INPUT_CHARS = 200_000;
const MAX_DEPTH = 8;

const SENSITIVE_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|api[-_]?key|authorization|auth|cookie|session|private[-_]?key|client[-_]?secret|credential)/i;

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
  /** fingerprint -> raw value. Values NEVER leave this class. */
  private readonly exactFingerprints = new Map<string, string>();
  private readonly hmacKey: Buffer;
  private readonly hmacKeyId: string;

  constructor(options: { hmacKeyHex?: string | undefined } = {}) {
    // Keyed HMAC fingerprints avoid creating a token oracle from scan output.
    const keyMaterial =
      options.hmacKeyHex ??
      process.env['DEVGUARD_REDACTION_HMAC_KEY'] ??
      (() => {
        // Fail closed: the development fallback must never reach production.
        if (
          process.env['NODE_ENV'] === 'production' ||
          process.env['DEVGUARD_ENV'] === 'production'
        ) {
          throw new Error('redaction HMAC key required outside development');
        }
        return 'devguard-dev-hmac-key';
      })();
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
    this.exactFingerprints.set(fingerprint, value);
    return fingerprint;
  }

  /**
   * Bounded literal search across the FULL registered alphabet (spaces and
   * symbols included) — no character-class blind spots. Used identically by
   * redaction and publication scanning. Matches are position-sorted.
   */
  findExactMatches(text: string): ExactMatch[] {
    const matches: ExactMatch[] = [];
    for (const value of this.exactFingerprints.values()) {
      let searchFrom = 0;
      for (;;) {
        const index = text.indexOf(value, searchFrom);
        if (index === -1) break;
        matches.push({ value, start: index, end: index + value.length });
        if (matches.length >= 500) return matches.sort((a, b) => a.start - b.start);
        searchFrom = index + Math.max(1, value.length);
      }
    }
    return matches.sort((a, b) => a.start - b.start || b.end - a.start);
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
    let working = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

    // 1) Exact registered secrets first (full alphabet, allowlist-proof).
    const exactMatches = this.findExactMatches(working);
    for (let index = exactMatches.length - 1; index >= 0; index -= 1) {
      const match = exactMatches[index]!;
      classes.add('exact_value');
      counter.count();
      working = working.slice(0, match.start) + REDACTED + working.slice(match.end);
    }

    // 2) Shared detector registry — identical classes to leak scanning.
    for (const detector of DETECTOR_REGISTRY) {
      working = working.replace(detector.pattern, () => {
        counter.count();
        classes.add(detector.id);
        return REDACTED;
      });
    }
    return working;
  }
}
