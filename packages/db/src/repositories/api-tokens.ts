/**
 * CP004 — Durable PostgreSQL API-token store.
 *
 * Implements the `@devguard/auth` `ApiTokenRepository` port STRUCTURALLY,
 * like the auth-session stores above: per the boundary matrix `@devguard/db`
 * (persistence) must not import `@devguard/auth` (application), so the record
 * type is mirrored here and assignment-compatibility is enforced by a
 * conformance test at the app/test layer. Only the SHA-256 token hash is
 * stored or read; the raw `dgv1_` plaintext never crosses this boundary.
 */
import { internalError } from '@devguard/errors';
import type { TimestampIso } from '@devguard/contracts';
import type { DevGuardPool } from '../pool.js';

export interface ApiTokenRecord {
  readonly tokenId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly label: string;
  readonly createdAt: TimestampIso;
  readonly lastUsedAt?: TimestampIso | undefined;
  readonly expiresAt: TimestampIso;
  readonly revokedAt?: TimestampIso | undefined;
  readonly rowVersion: number;
}

/** pg returns timestamptz as a Date; normalize to ISO for the domain record. */
function iso(value: unknown): TimestampIso {
  const normalized = value instanceof Date ? value.toISOString() : String(value ?? '');
  return normalized as TimestampIso;
}

/** True for non-null, non-undefined row cells (eqeqeq-safe `!= null`). */
function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** Pure row → record mapper (unit-testable without a database). */
export function mapApiTokenRow(row: Record<string, unknown>): ApiTokenRecord {
  return {
    tokenId: String(row['token_id']),
    userId: String(row['user_id']),
    tokenHash: String(row['token_hash']),
    label: String(row['label']),
    createdAt: iso(row['created_at']),
    ...(present(row['last_used_at']) ? { lastUsedAt: iso(row['last_used_at']) } : {}),
    expiresAt: iso(row['expires_at']),
    ...(present(row['revoked_at']) ? { revokedAt: iso(row['revoked_at']) } : {}),
    rowVersion: Number(row['row_version'] ?? 0),
  };
}

const TOKEN_COLS = `token_id, user_id, token_hash, label, created_at, last_used_at,
  expires_at, revoked_at, row_version::text AS row_version`;

export class PostgresApiTokenRepository {
  constructor(private readonly pool: DevGuardPool) {}

  async insert(record: ApiTokenRecord): Promise<void> {
    await this.pool
      .query({
        text: `INSERT INTO api_tokens
  (token_id, user_id, token_hash, label, created_at, last_used_at, expires_at, revoked_at, row_version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        values: [
          record.tokenId,
          record.userId,
          record.tokenHash,
          record.label,
          record.createdAt,
          record.lastUsedAt ?? null,
          record.expiresAt,
          record.revokedAt ?? null,
          record.rowVersion,
        ],
      })
      .catch((error: unknown) => {
        throw internalError(error);
      });
  }

  async findByTokenHash(tokenHash: string): Promise<ApiTokenRecord | undefined> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${TOKEN_COLS} FROM api_tokens WHERE token_hash = $1`,
      values: [tokenHash],
    });
    const row = rows[0];
    return row !== undefined ? mapApiTokenRow(row) : undefined;
  }

  async listByOwner(userId: string): Promise<readonly ApiTokenRecord[]> {
    const rows = await this.pool.query<Record<string, unknown>>({
      text: `SELECT ${TOKEN_COLS} FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      values: [userId],
    });
    return rows.map((row) => mapApiTokenRow(row));
  }

  async revoke(tokenId: string, userId: string, revokedAt: string): Promise<void> {
    await this.pool.query({
      text: `UPDATE api_tokens
SET revoked_at = $3, row_version = row_version + 1
WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      values: [tokenId, userId, revokedAt],
    });
  }
}
