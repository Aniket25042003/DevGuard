/**
 * C005 — Volatile in-memory session/transaction stores.
 *
 * EXPLICITLY dev/test-only: contents vanish on restart and are not shared
 * across processes. Production composition MUST bind durable adapters
 * (C007/C009); binding these in production fails the readiness check.
 */
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  AuthTransactionRecord,
  AuthTransactionRepository,
} from './principal.js';

export const VOLATILE_STORE_NAME = 'in-memory-auth-store';

function assertVersion(record: { readonly rowVersion: number }, expected: number): void {
  if (record.rowVersion !== expected) {
    throw new Error(`VERSION_CONFLICT:${expected}->${record.rowVersion}`);
  }
}

export class InMemoryAuthSessionRepository implements AuthSessionRepository {
  private readonly sessions = new Map<string, AuthSessionRecord>();

  async insert(record: AuthSessionRecord): Promise<void> {
    if (this.sessions.has(record.sessionIdHash)) {
      throw new Error('SESSION_CONFLICT:duplicate');
    }
    this.sessions.set(record.sessionIdHash, { ...record });
  }

  async findBySessionIdHash(sessionIdHash: string): Promise<AuthSessionRecord | undefined> {
    return this.sessions.get(sessionIdHash);
  }

  async touch(
    sessionIdHash: string,
    lastSeenAt: TimestampLike,
    idleExpiresAt: TimestampLike,
    expectedRowVersion: number,
  ): Promise<void> {
    const record = this.sessions.get(sessionIdHash);
    if (record === undefined) throw new Error('NOT_FOUND:session');
    assertVersion(record, expectedRowVersion);
    this.sessions.set(sessionIdHash, {
      ...record,
      lastSeenAt,
      idleExpiresAt,
      rowVersion: record.rowVersion + 1,
    });
  }

  async revoke(
    sessionIdHash: string,
    revokedAt: NonNullable<AuthSessionRecord['revokedAt']>,
    expectedRowVersion: number,
  ): Promise<void> {
    const record = this.sessions.get(sessionIdHash);
    if (record === undefined) throw new Error('NOT_FOUND:session');
    assertVersion(record, expectedRowVersion);
    this.sessions.set(sessionIdHash, { ...record, revokedAt, rowVersion: record.rowVersion + 1 });
  }
}

type TimestampLike = AuthSessionRecord['lastSeenAt'];

export class InMemoryAuthTransactionRepository implements AuthTransactionRepository {
  private readonly transactions = new Map<string, AuthTransactionRecord>();

  async insert(record: AuthTransactionRecord): Promise<void> {
    if (this.transactions.has(record.stateHash)) {
      throw new Error('SESSION_CONFLICT:duplicate-transaction');
    }
    this.transactions.set(record.stateHash, { ...record });
  }

  async findByStateHash(stateHash: string): Promise<AuthTransactionRecord | undefined> {
    return this.transactions.get(stateHash);
  }

  async consume(
    stateHash: string,
    consumedAt: NonNullable<AuthTransactionRecord['consumedAt']>,
    expectedRowVersion: number,
  ): Promise<void> {
    const record = this.transactions.get(stateHash);
    if (record === undefined) throw new Error('NOT_FOUND:transaction');
    if (record.consumedAt !== undefined) throw new Error('VERSION_CONFLICT:already_consumed');
    assertVersion(record, expectedRowVersion);
    this.transactions.set(stateHash, { ...record, consumedAt, rowVersion: record.rowVersion + 1 });
  }
}
