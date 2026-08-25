/**
 * C093 — Secret resolution service.
 *
 * Order of enforcement (all before any backend access):
 *   1. reference state must be resolvable (AVAILABLE/EXPIRING)
 *   2. expiry must not have passed
 *   3. purpose must match exactly
 *   4. scope must match: global refs are callable from any authorized scope;
 *      narrower scopes require exact scopeType AND scopeId equality
 * Denials throw SECRET_ACCESS_DENIED without echoing the reference value;
 * unavailability throws SECRET_UNAVAILABLE (safe_retry class).
 */
import { makeError } from '@devguard/errors';
import { RESOLVABLE_STATUSES, ResolvedSecretLease } from './refs.js';
import type { AuthorizationContext, SecretRefShape } from './refs.js';

export interface SecretBackend {
  get(name: string): Promise<string | undefined>;
}

/** Lease lifetime bound — the shortest practical window (C093 §4.4). */
const LEASE_TTL_MS = 30_000;

export interface SecretServiceOptions {
  readonly backend: SecretBackend;
  readonly now?: () => Date;
  /** Lease TTL override (tests). Values below 1 ms are clamped to 1 ms. */
  readonly leaseTtlMs?: number;
}

function scopeMatches(ref: SecretRefShape, auth: AuthorizationContext): boolean {
  if (ref.scopeType === 'global') return true;
  return ref.scopeType === auth.scopeType && ref.scopeId === auth.scopeId;
}

export class SecretService {
  private readonly singleFlight = new Map<string, Promise<string>>();
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;

  constructor(private readonly options: SecretServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.leaseTtlMs = Math.max(1, options.leaseTtlMs ?? LEASE_TTL_MS);
  }

  async resolveSecret(
    ref: SecretRefShape,
    authorization: AuthorizationContext,
  ): Promise<ResolvedSecretLease> {
    // 1) state
    if (!RESOLVABLE_STATUSES.has(ref.status)) {
      throw makeError('SECRET_STATE_INVALID', {
        details: { status: ref.status },
        cause: new Error(`status ${ref.status} is not resolvable`),
      });
    }
    // 2) expiry
    if (ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= this.now().getTime()) {
      throw makeError('SECRET_UNAVAILABLE', { cause: new Error('reference expired') });
    }
    // 3) purpose
    if (ref.purpose !== authorization.purpose) {
      throw makeError('SECRET_ACCESS_DENIED', { cause: new Error('purpose mismatch') });
    }
    // 4) scope
    if (!scopeMatches(ref, authorization)) {
      throw makeError('SECRET_ACCESS_DENIED', { cause: new Error('scope mismatch') });
    }

    // Single-flight ONLY the backend fetch; every caller receives its own
    // independent lease so one release() can never clear another's access.
    const key = `${ref.name}@${ref.version}`;
    let flight = this.singleFlight.get(key);
    if (flight === undefined) {
      flight = this.options.backend
        .get(ref.name)
        .then((raw) => {
          if (raw === undefined || raw.length < 8) {
            throw makeError('SECRET_UNAVAILABLE', {
              cause: new Error('backend returned no usable secret'),
            });
          }
          return raw;
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'DevGuardError') throw error;
          throw makeError('SECRET_UNAVAILABLE', { cause: error });
        });
      this.singleFlight.set(key, flight);
      void flight.catch(() => undefined).finally(() => this.singleFlight.delete(key));
    }

    const rawValue = await flight;
    const expiresAtMs = this.now().getTime() + this.leaseTtlMs;
    return new ResolvedSecretLease(ref.name, ref.version, expiresAtMs, rawValue, undefined, () =>
      this.now().getTime(),
    );
  }

  /**
   * Scoped accessor: resolves, invokes the callback with the raw value, and
   * releases the lease afterwards (best-effort zeroization).
   */
  async withSecret<T>(
    ref: SecretRefShape,
    authorization: AuthorizationContext,
    callback: (value: string) => Promise<T> | T,
  ): Promise<T> {
    const lease = await this.resolveSecret(ref, authorization);
    try {
      if (lease.leaseExpiresAtMs <= this.now().getTime()) {
        throw makeError('SECRET_UNAVAILABLE', { cause: new Error('lease already expired') });
      }
      return await lease.use((value) => callback(value));
    } finally {
      lease.release();
    }
  }
}
