/**
 * CP003 — Durable PostgreSQL authentication stores (C005 ports, SQL here).
 *
 * These classes implement the `@devguard/auth` repository ports
 * (`AuthSessionRepository`, `AuthTransactionRepository`, `UserIdentityLinker`)
 * STRUCTURALLY: per the boundary matrix, `@devguard/db` (persistence) must not
 * import `@devguard/auth` (application), so the record/parameter types are
 * mirrored here and assignment-compatibility is enforced by a conformance test
 * at the app/test layer (tests/integration). SQL never leaves this package.
 *
 * Failures use typed `@devguard/errors`. CAS (row_version) failures preserve
 * the repository-port contract the auth service depends on: their `message`
 * begins with `VERSION_CONFLICT` so `AuthenticationService` re-reads and either
 * honors a concurrent revoke/expiry or surfaces a stable conflict.
 */
import type { TimestampIso } from '@devguard/contracts';
import { internalError, makeError } from '@devguard/errors';
import type { DevGuardPool } from '../pool.js';
import { createUnitOfWork } from '../transaction.js';
import { uuidv7 } from '../uuid.js';

// ---------------------------------------------------------------------------
// Record types (structural mirror of @devguard/auth shapes)
// ---------------------------------------------------------------------------

export interface AuthSessionRecord {
  readonly sessionIdHash: string;
  readonly userId: string;
  readonly providerIssuer: string;
  readonly providerSubject: string;
  readonly providerLogin?: string | undefined;
  readonly providerDisplayName?: string | undefined;
  readonly createdAt: TimestampIso;
  readonly lastSeenAt: TimestampIso;
  readonly idleExpiresAt: TimestampIso;
  readonly absoluteExpiresAt: TimestampIso;
  readonly revokedAt?: TimestampIso | undefined;
  readonly rowVersion: number;
}

export interface AuthTransactionRecord {
  readonly stateHash: string;
  readonly pkceVerifier: string;
  readonly returnToPath: string;
  readonly createdAt: TimestampIso;
  readonly expiresAt: TimestampIso;
  readonly consumedAt?: TimestampIso | undefined;
  readonly rowVersion: number;
}

/** pg returns timestamptz as a Date; normalize to ISO for the domain record. */
function iso(value: unknown): TimestampIso {
  const normalized = value instanceof Date ? value.toISOString() : String(value ?? '');
  return normalized as TimestampIso;
}

function isoOrUndefined(value: unknown): TimestampIso | undefined {
  if (value === null || value === undefined) return undefined;
  return iso(value);
}

/** True for non-null, non-undefined row cells (eqeqeq-safe `!= null`). */
function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** Pure row → record mapper (unit-testable without a database). */
export function mapAuthSessionRow(row: Record<string, unknown>): AuthSessionRecord {
  return {
    sessionIdHash: String(row['session_id_hash']),
    userId: String(row['user_id']),
    providerIssuer: String(row['provider_issuer']),
    providerSubject: String(row['provider_subject']),
    ...(present(row['provider_login']) ? { providerLogin: String(row['provider_login']) } : {}),
    ...(present(row['provider_display_name'])
      ? { providerDisplayName: String(row['provider_display_name']) }
      : {}),
    createdAt: iso(row['created_at']),
    lastSeenAt: iso(row['last_seen_at']),
    idleExpiresAt: iso(row['idle_expires_at']),
    absoluteExpiresAt: iso(row['absolute_expires_at']),
    revokedAt: isoOrUndefined(row['revoked_at']),
    rowVersion: Number(row['row_version'] ?? 0),
  };
}

export function mapAuthTransactionRow(row: Record<string, unknown>): AuthTransactionRecord {
  return {
    stateHash: String(row['state_hash']),
    pkceVerifier: String(row['pkce_verifier']),
    returnToPath: String(row['return_to_path']),
    createdAt: iso(row['created_at']),
    expiresAt: iso(row['expires_at']),
    consumedAt: isoOrUndefined(row['consumed_at']),
    rowVersion: Number(row['row_version'] ?? 0),
  };
}

/** Typed CAS-conflict that preserves the auth service's message-prefix contract. */
function versionConflictError(expected: number): Error {
  const error = makeError('VERSION_CONFLICT', {});
  error.message = `VERSION_CONFLICT:${expected}->stale`;
  return error;
}

// ---------------------------------------------------------------------------
// Auth session store
// ---------------------------------------------------------------------------

const SESSION_COLS = `session_id_hash, user_id, provider_issuer, provider_subject,
  provider_login, provider_display_name, created_at, last_seen_at, idle_expires_at,
  absolute_expires_at, revoked_at, row_version::text AS row_version`;

export class PostgresAuthSessionRepository {
  constructor(private readonly pool: DevGuardPool) {}

  async insert(record: AuthSessionRecord): Promise<void> {
    await this.pool
      .query({
        text: `INSERT INTO auth_sessions
  (session_id_hash, user_id, provider_issuer, provider_subject, provider_login,
   provider_display_name, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
   revoked_at, row_version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        values: [
          record.sessionIdHash,
          record.userId,
          record.providerIssuer,
          record.providerSubject,
          record.providerLogin ?? null,
          record.providerDisplayName ?? null,
          record.createdAt,
          record.lastSeenAt,
          record.idleExpiresAt,
          record.absoluteExpiresAt,
          record.revokedAt ?? null,
          record.rowVersion,
        ],
      })
      .catch((error: unknown) => {
        throw internalError(error);
      });
  }

  async findBySessionIdHash(sessionIdHash: string): Promise<AuthSessionRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${SESSION_COLS} FROM auth_sessions WHERE session_id_hash = $1`,
      values: [sessionIdHash],
    });
    const row = rows[0];
    return row !== undefined ? mapAuthSessionRow(row) : undefined;
  }

  async touch(
    sessionIdHash: string,
    lastSeenAt: TimestampIso,
    idleExpiresAt: TimestampIso,
    expectedRowVersion: number,
  ): Promise<void> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `UPDATE auth_sessions
SET last_seen_at = $2, idle_expires_at = $3, row_version = row_version + 1
WHERE session_id_hash = $1 AND row_version = $4
RETURNING row_version`,
      values: [sessionIdHash, lastSeenAt, idleExpiresAt, expectedRowVersion],
    });
    if (rows.length === 0) throw versionConflictError(expectedRowVersion);
  }

  async revoke(
    sessionIdHash: string,
    revokedAt: TimestampIso,
    expectedRowVersion: number,
  ): Promise<void> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `UPDATE auth_sessions
SET revoked_at = $2, row_version = row_version + 1
WHERE session_id_hash = $1 AND row_version = $3
RETURNING row_version`,
      values: [sessionIdHash, revokedAt, expectedRowVersion],
    });
    if (rows.length === 0) throw versionConflictError(expectedRowVersion);
  }
}

// ---------------------------------------------------------------------------
// Auth transaction (OAuth login) store
// ---------------------------------------------------------------------------

export class PostgresAuthTransactionRepository {
  constructor(private readonly pool: DevGuardPool) {}

  async insert(record: AuthTransactionRecord): Promise<void> {
    await this.pool
      .query({
        text: `INSERT INTO auth_transactions
  (state_hash, pkce_verifier, return_to_path, created_at, expires_at, consumed_at, row_version)
VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        values: [
          record.stateHash,
          record.pkceVerifier,
          record.returnToPath,
          record.createdAt,
          record.expiresAt,
          record.consumedAt ?? null,
          record.rowVersion,
        ],
      })
      .catch((error: unknown) => {
        throw internalError(error);
      });
  }

  async findByStateHash(stateHash: string): Promise<AuthTransactionRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT state_hash, pkce_verifier, return_to_path, created_at, expires_at,
  consumed_at, row_version::text AS row_version
FROM auth_transactions WHERE state_hash = $1`,
      values: [stateHash],
    });
    const row = rows[0];
    return row !== undefined ? mapAuthTransactionRow(row) : undefined;
  }

  async consume(
    stateHash: string,
    consumedAt: TimestampIso,
    expectedRowVersion: number,
  ): Promise<void> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `UPDATE auth_transactions
SET consumed_at = $2, row_version = row_version + 1
WHERE state_hash = $1 AND row_version = $3 AND consumed_at IS NULL AND expires_at > $2
RETURNING row_version`,
      values: [stateHash, consumedAt, expectedRowVersion],
    });
    if (rows.length === 0) throw versionConflictError(expectedRowVersion);
  }
}

// ---------------------------------------------------------------------------
// User identity linker (C009 users + external_identities)
// ---------------------------------------------------------------------------

export interface IdentityProfileInput {
  readonly login: string;
  readonly displayName?: string | undefined;
}

export class PostgresUserIdentityLinker {
  private readonly pool: DevGuardPool;

  constructor(pool: DevGuardPool) {
    this.pool = pool;
  }

  async resolve(
    issuer: string,
    providerSubject: string,
    profile: IdentityProfileInput,
  ): Promise<string> {
    const existing = await this.pool.query<{ user_id: string }>({
      text: 'SELECT user_id FROM external_identities WHERE issuer = $1 AND subject = $2',
      values: [issuer, providerSubject],
    });
    if (existing[0] !== undefined) {
      // Opportunistic profile-snapshot refresh; identity binding unchanged.
      await this.pool
        .query({
          text: `UPDATE external_identities
SET last_seen_at = now(), login_snapshot = $3
WHERE issuer = $1 AND subject = $2`,
          values: [issuer, providerSubject, profile.login],
        })
        .catch((error: unknown) => {
          throw internalError(error);
        });
      return String(existing[0].user_id);
    }

    // New subject: create a user + identity atomically. A concurrent login for
    // the same (issuer, subject) loses the identity upsert; RETURNING yields
    // the canonical user_id inside the same transaction, and the orphan user
    // row we may have created is cleaned up so one subject binds one user.
    const candidateId = uuidv7();
    const boundUserId = await createUnitOfWork(this.pool).transaction(async (tx) => {
      await tx.query({
        text: 'INSERT INTO users (id, login, display_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        values: [candidateId, profile.login, profile.displayName ?? null],
      });
      const inserted = await tx.query<{ user_id: string }>({
        text: `INSERT INTO external_identities (id, user_id, issuer, subject, login_snapshot)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (issuer, subject) DO UPDATE SET last_seen_at = now(), login_snapshot = EXCLUDED.login_snapshot
RETURNING user_id`,
        values: [uuidv7(), candidateId, issuer, providerSubject, profile.login],
      });
      return String(inserted[0]?.user_id ?? candidateId);
    });
    if (boundUserId !== candidateId) {
      // We lost a concurrent race for this (issuer, subject): drop the orphan.
      await this.pool
        .query({
          text: `DELETE FROM users
WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM external_identities WHERE user_id = $1)`,
          values: [candidateId],
        })
        .catch(() => undefined);
    }
    return boundUserId;
  }
}
