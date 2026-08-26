/**
 * C007 — Bounded pool lifecycle with graceful drain and health ping.
 *
 * The pg Pool (and its row types) terminates here: consumers receive the
 * `DevGuardPool` port, never provider-native clients (C007 §6).
 */
import { Pool, type PoolClient } from 'pg';
import type { SqlStatement } from './sql.js';
import { sqlStateOf } from './sql.js';

/** Pool configuration; every knob is bounded and explicit. */
export interface DbPoolConfig {
  readonly connectionString: string;
  readonly min?: number;
  readonly max?: number;
  readonly idleTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

/** Safe health projection consumed by readiness probes (C074); no DSN/schema internals. */
export interface DatabaseHealthStatus {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Highest applied schema_migrations version; 0 when unmigrated or unreachable. */
  readonly schemaVersion: number;
}

export interface DevGuardPool {
  /** Run a single parameterized statement on a pooled connection. */
  query<T>(statement: SqlStatement): Promise<T[]>;
  /**
   * Run `fn` on one dedicated client (same session for advisory locks,
   * multi-statement migrations, or explicit transactions).
   */
  withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  health(): Promise<DatabaseHealthStatus>;
  /** Graceful drain: stop accepting checkouts and wait for idle clients. */
  drain(): Promise<void>;
}

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Create a bounded pool. Call `drain()` on process shutdown. */
export function createPool(config: DbPoolConfig): DevGuardPool {
  const pool = new Pool({
    connectionString: config.connectionString,
    min: config.min ?? DEFAULT_MIN,
    max: config.max ?? DEFAULT_MAX,
    idleTimeoutMillis: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    // Session defaults applied to every checked-out client.
    ...(config.statementTimeoutMs === undefined
      ? {}
      : { statement_timeout: config.statementTimeoutMs }),
  });

  return {
    async query<T>(statement: SqlStatement): Promise<T[]> {
      const result = await pool.query(statement.text, statement.values as unknown[] | undefined);
      return result.rows as T[];
    },

    async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },

    async health(): Promise<DatabaseHealthStatus> {
      const startedAt = Date.now();
      try {
        const result = await pool.query<{ v: string }>(
          'SELECT max(version)::text AS v FROM schema_migrations',
        );
        const version = Number(result.rows[0]?.v ?? '0');
        return { ok: true, latencyMs: Date.now() - startedAt, schemaVersion: version };
      } catch (error) {
        // Unmigrated database is reachable-but-empty, not an outage.
        if (sqlStateOf(error) === '42P01') {
          return { ok: true, latencyMs: Date.now() - startedAt, schemaVersion: 0 };
        }
        return { ok: false, latencyMs: Date.now() - startedAt, schemaVersion: 0 };
      }
    },

    async drain(): Promise<void> {
      await pool.end();
    },
  };
}
