/**
 * C061 §8 — canonical OperationalLogRecord v1.
 *
 * Field allowlist: anything outside this record shape is dropped by the
 * sink (defense against accidental secret drift into logs). Logs are
 * TTL-bound operational data — never durable domain evidence (C064 owns that).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogService = 'web' | 'api' | 'worker';

/** Approved correlation fields only (C061 §3). */
export interface SafeLogFields {
  readonly event?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly repositoryId?: string;
  readonly workflowRunId?: string;
  readonly sessionId?: string;
  readonly actionId?: string;
  readonly approvalId?: string;
  readonly jobId?: string;
  readonly webhookDeliveryId?: string;
  readonly actorType?: 'user' | 'agent' | 'webhook' | 'service';
  /** Pseudonymized actor identifier (hashed), never the raw value. */
  readonly actorIdHash?: string;
  readonly provider?: 'github' | 'trueforge' | 'sandbox' | 'internal';
  readonly durationMs?: number;
  readonly status?: string;
  readonly attempt?: number;
}

export interface SerializedError {
  readonly code: string;
  readonly class: string;
  readonly retryable: boolean;
  readonly fingerprint: string;
}

export interface OperationalLogRecord extends SafeLogFields {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly service: LogService;
  readonly environment: string;
  readonly message: string;
  readonly correlationId: string;
  readonly error?: SerializedError | undefined;
}

/** Hard budgets (C061 §5): oversized events are truncated, not dropped. */
export const LOG_BUDGETS = Object.freeze({
  maxMessageLength: 512,
  maxJsonBytes: 16 * 1024,
});

const SAFE_STRING_FIELDS = new Set(Object.keys({} as SafeLogFields));
void SAFE_STRING_FIELDS;

/** Known redaction paths plus secret-pattern defense-in-depth. */
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

/** Redact a free-form string surface. Returns `[REDACTED:<name>]` markers. */
export function redactText(text: string): string {
  let out = text;
  for (const { name, pattern } of REDACTION_PATTERNS) {
    out = out.replace(pattern, `[REDACTED:${name}]`);
  }
  return out;
}

/** Deep redaction over untrusted field values before record assembly. */
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
