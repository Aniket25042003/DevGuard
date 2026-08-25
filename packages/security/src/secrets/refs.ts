/**
 * C093 — Secret references, leases, and authorization context.
 *
 * Invariants:
 * - References carry NO secret material.
 * - Leases are non-serializable (JSON.stringify yields '[REDACTED]') and
 *   expose the value only through an authorized callback.
 * - State machine: CONFIGURED → AVAILABLE → (EXPIRING ⇄ AVAILABLE) →
 *   ROTATING → AVAILABLE; REVOKED and UNAVAILABLE are handled explicitly.
 */
import { z } from 'zod';

export const SECRET_STATUSES = [
  'CONFIGURED',
  'AVAILABLE',
  'EXPIRING',
  'ROTATING',
  'REVOKED',
  'UNAVAILABLE',
] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

/** Statuses from which resolution is permitted. */
export const RESOLVABLE_STATUSES: ReadonlySet<SecretStatus> = new Set(['AVAILABLE', 'EXPIRING']);

const SCOPE_TYPES = ['global', 'repository', 'workflow', 'action'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface SecretRefShape {
  /** Logical name — matches the backend key (e.g. env var / manager path). */
  readonly name: string;
  readonly provider: 'environment' | 'github_app' | 'trueforge' | 'managed';
  readonly purpose: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
  readonly version: string;
  readonly expiresAt?: string | undefined;
  readonly status: SecretStatus;
}

export const secretRefSchema = z
  .object({
    name: z.string().min(1).max(128),
    provider: z.enum(['environment', 'github_app', 'trueforge', 'managed']),
    purpose: z.string().min(1).max(128),
    scopeType: z.enum(SCOPE_TYPES),
    scopeId: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    expiresAt: z.string().datetime({ offset: false }).optional(),
    status: z.enum(SECRET_STATUSES),
  })
  .strict();

/** Who may resolve what, for which purpose — checked BEFORE any backend hit. */
export interface AuthorizationContext {
  readonly callerId: string;
  readonly purpose: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string;
}

/**
 * Short-lived lease. The value is private; `use` scopes access to one
 * callback; serialization can never leak the value.
 */
export class ResolvedSecretLease {
  private value: string | undefined;

  constructor(
    readonly refName: string,
    readonly version: string,
    readonly leaseExpiresAtMs: number,
    value: string,
    private readonly onRelease?: ((value: string) => void) | undefined,
  ) {
    this.value = value;
  }

  /** Single authorized accessor; the callback receives the raw value. */
  use<T>(callback: (value: string) => T): T {
    return callback(this.value ?? '');
  }

  /** Best-effort zeroization; JS cannot guarantee memory erasure (C093 §27). */
  release(): void {
    if (this.value !== undefined && this.onRelease !== undefined) {
      this.onRelease(this.value);
    }
    this.value = undefined;
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }

  get [Symbol.toStringTag](): string {
    return 'ResolvedSecretLease';
  }
}
