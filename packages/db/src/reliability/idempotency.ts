/**
 * C008 — Idempotency records: scoped key hashing, canonical request
 * fingerprints, and the begin/replay/complete protocol (C008 §8–§10, §20).
 *
 * Keys are opaque to this package: callers pass a scope (actor/repository/
 * operation) plus raw key; only `sha256(scope + NUL + key)` is persisted.
 * Fingerprints are canonical-JSON (recursively sorted keys) sha256 digests so
 * logically equal requests collide and reordered duplicates are detected.
 */
import { createHash } from 'node:crypto';
import { makeError } from '@devguard/errors';
import type { TransactionContext } from '../transaction.js';
import { uuidv7 } from '../uuid.js';

/** sha256 hex of scope + NUL + key; the NUL keeps (scope,key) splits unambiguous. */
export function idempotencyKeyHash(scope: string, key: string): string {
  return createHash('sha256').update(`${scope}\u0000${key}`, 'utf8').digest('hex');
}

/** Deterministic JSON with recursively sorted object keys. Array order is significant. */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJsonStringify(element)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, element]) => element !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`)
    .join(',')}}`;
}

/** Canonical fingerprint of a request payload (ordering-insensitive for objects). */
export function requestFingerprint(request: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(request), 'utf8').digest('hex');
}

/** Bounded safe result projection stored with the record (never credentials/artifacts). */
export interface StoredResult {
  readonly responseCode: number;
  readonly responseJson: unknown;
}

export type BeginOutcome =
  | { readonly kind: 'acquired'; readonly token: string }
  | { readonly kind: 'replay'; readonly result: StoredResult }
  | { readonly kind: 'conflict' };

export interface BeginInput {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly leaseMs: number;
}

interface IdempotencyRow {
  readonly status: string;
  readonly request_fingerprint: string | null;
  readonly response_code: number | null;
  readonly response_json: unknown;
  readonly lease_expires_at: Date | null;
}

const INSERT_FRESH = `
INSERT INTO idempotency_records
  (id, scope, key_hash, status, owner_token, lease_expires_at, request_fingerprint)
VALUES ($1, $2, $3, 'processing', $4, now() + ($5::double precision / 1000) * interval '1 second', $6)
ON CONFLICT (scope, key_hash) DO NOTHING
RETURNING id`;

const SELECT_FOR_UPDATE = `
SELECT status, request_fingerprint, response_code, response_json, lease_expires_at
FROM idempotency_records
WHERE scope = $1 AND key_hash = $2
FOR UPDATE`;

const RECLAIM_LEASE = `
UPDATE idempotency_records
SET owner_token = $3,
    lease_expires_at = now() + ($4::double precision / 1000) * interval '1 second',
    updated_at = now(),
    row_version = row_version + 1
WHERE scope = $1 AND key_hash = $2
  -- Live lease guard: a record still owned by another caller must NOT be
  -- reclaimed; only an expired (or NULL-never-leased) record is eligible.
  AND lease_expires_at IS NOT NULL
  AND lease_expires_at <= now()
RETURNING id`;

const COMPLETE_BY_TOKEN = `
UPDATE idempotency_records
SET status = 'completed',
    response_code = $2,
    response_json = $3,
    updated_at = now(),
    row_version = row_version + 1
WHERE owner_token = $1 AND status = 'processing'
RETURNING id`;

export class IdempotencyStore {
  /**
   * Acquire, replay, or conflict inside the caller's transaction.
   * - fresh insert → acquired(token)
   * - completed record, same fingerprint → replay(storedResult)
   * - processing record with an expired lease → reclaimed, acquired(new token)
   * - processing record with a live lease → conflict (another owner in flight)
   * - any record whose stored fingerprint differs → IDEMPOTENCY_KEY_REUSED.
   */
  async begin(input: BeginInput, tx: TransactionContext): Promise<BeginOutcome> {
    const keyHash = idempotencyKeyHash(input.scope, input.key);
    const token = uuidv7();
    const inserted = await tx.query<{ id: string }>({
      text: INSERT_FRESH,
      values: [uuidv7(), input.scope, keyHash, token, input.leaseMs, input.fingerprint],
    });
    if (inserted.length > 0) return { kind: 'acquired', token };

    const rows = await tx.query<IdempotencyRow>({
      text: SELECT_FOR_UPDATE,
      values: [input.scope, keyHash],
    });
    // Unique insert raced and vanished: treat as retryable conflict.
    const row = rows[0];
    if (!row) return { kind: 'conflict' };

    if (row.request_fingerprint !== null && row.request_fingerprint !== input.fingerprint) {
      throw makeError('IDEMPOTENCY_KEY_REUSED');
    }
    if (row.status === 'completed') {
      return {
        kind: 'replay',
        result: {
          responseCode: row.response_code ?? 200,
          responseJson: row.response_json,
        },
      };
    }
    // Expiry is enforced by the database clock inside the reclaim statement
    // (eliminating app-vs-DB clock-skew windows). A live lease owned by
    // another caller yields no reclaimed rows -> retryable conflict.
    const reclaimed = await tx.query<{ id: string }>({
      text: RECLAIM_LEASE,
      values: [input.scope, keyHash, token, input.leaseMs],
    });
    if (reclaimed.length === 0) return { kind: 'conflict' };
    return { kind: 'acquired', token };
  }

  /** CAS-complete by owner token; stale/unknown tokens fail closed. */
  async complete(token: string, result: StoredResult, tx: TransactionContext): Promise<void> {
    const serialized = JSON.stringify(result.responseJson ?? null);
    if (Buffer.byteLength(serialized, 'utf8') > 65_536) {
      throw makeError('VALIDATION_FAILED', {
        cause: new Error('idempotency response exceeds 64KB'),
      });
    }
    const updated = await tx.query<{ id: string }>({
      text: COMPLETE_BY_TOKEN,
      values: [token, result.responseCode, result.responseJson],
    });
    if (updated.length === 0) {
      throw new TypeError(`Unknown or non-processing idempotency token '${token}'.`);
    }
  }
}
