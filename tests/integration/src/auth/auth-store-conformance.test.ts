/**
 * CP003 §22 — port conformance: the PostgreSQL stores are drop-in for the
 * in-memory `@devguard/auth` ports. `@devguard/db` (persistence) cannot import
 * `@devguard/auth` (application) per the boundary matrix, so this test-layer
 * suite is where structural assignability is enforced: if any method/field
 * drifts, this file fails to compile (`tsc -b tests/integration`).
 */
import { describe, expect, it } from 'vitest';
import type {
  AuthSessionRepository,
  AuthTransactionRepository,
  UserIdentityLinker,
} from '@devguard/auth';
import {
  PostgresAuthSessionRepository,
  PostgresAuthTransactionRepository,
  PostgresUserIdentityLinker,
} from '@devguard/db';
import type { DevGuardPool } from '@devguard/db';

const NOOP_POOL: DevGuardPool = {
  query: async () => [] as never[],
  withClient: async <T>(fn: (c: unknown) => Promise<T>) => fn({}),
  health: async () => ({ ok: true, latencyMs: 0, schemaVersion: 7 }),
  drain: async () => undefined,
} as unknown as DevGuardPool;

describe('CP003 durable auth store port conformance', () => {
  it('PostgresAuthSessionRepository implements AuthSessionRepository', () => {
    const sessions: AuthSessionRepository = new PostgresAuthSessionRepository(NOOP_POOL);
    expect(sessions).toBeInstanceOf(PostgresAuthSessionRepository);
  });

  it('PostgresAuthTransactionRepository implements AuthTransactionRepository', () => {
    const transactions: AuthTransactionRepository = new PostgresAuthTransactionRepository(
      NOOP_POOL,
    );
    expect(transactions).toBeInstanceOf(PostgresAuthTransactionRepository);
  });

  it('PostgresUserIdentityLinker implements UserIdentityLinker', () => {
    const identities: UserIdentityLinker = new PostgresUserIdentityLinker(NOOP_POOL);
    expect(identities).toBeInstanceOf(PostgresUserIdentityLinker);
  });
});
