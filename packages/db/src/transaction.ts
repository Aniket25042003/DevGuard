/**
 * C007 — UnitOfWork: explicit transaction boundary with bounded, classified
 * whole-transaction retry for serialization failures and deadlocks.
 *
 * Invariants (C007 §13/§19):
 * - Callbacks receive a TransactionContext; there is no ambient transaction.
 * - Only SQLSTATE 40001/40P01 trigger retries, bounded by `retrySerialization`.
 * - A callback that may perform external side effects (`allowSideEffects`,
 *   default false) is never retried — the original error propagates instead so
 *   external effects can be reconciled before any repeat.
 */
import type { PoolClient } from 'pg';
import type { DevGuardPool } from './pool.js';
import type { SqlStatement } from './sql.js';
import { classifySqlState, sqlStateOf } from './sql.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Provider-neutral handle handed to repository code inside one transaction. */
export interface TransactionContext {
  readonly id: symbol;
  query<T>(statement: SqlStatement): Promise<T[]>;
}

export interface TransactionOptions {
  readonly isolation?: IsolationLevel;
  /** Additional whole-transaction attempts after a 40001/40P01 failure. Default: no retries. */
  readonly retrySerialization?: number;
  /**
   * Declare that `fn` performs external side effects. Retrying such a callback
   * could duplicate them, so a retryable failure rethrows instead of retrying.
   */
  readonly allowSideEffects?: boolean;
}

export interface UnitOfWork {
  transaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

class PgTransactionContext implements TransactionContext {
  readonly id: symbol;

  constructor(
    id: symbol,
    private readonly client: PoolClient,
  ) {
    this.id = id;
  }

  async query<T>(statement: SqlStatement): Promise<T[]> {
    const result = await this.client.query(statement.text, statement.values as unknown[]);
    return result.rows as T[];
  }
}

const DEFAULT_ISOLATION: IsolationLevel = 'read committed';

/** Build the UnitOfWork on top of a DevGuardPool. */
export function createUnitOfWork(pool: DevGuardPool): UnitOfWork {
  return {
    async transaction<T>(
      fn: (tx: TransactionContext) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      // Interpolation is safe: `isolation` is a closed literal union, never user input.
      const begin = `BEGIN ISOLATION LEVEL ${(options?.isolation ?? DEFAULT_ISOLATION).toUpperCase()}`;
      const maxAttempts = 1 + (options?.retrySerialization ?? 0);

      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          return await pool.withClient(async (client) => {
            await client.query(begin);
            const tx = new PgTransactionContext(Symbol('devguard.tx'), client);
            try {
              const result = await fn(tx);
              await client.query('COMMIT');
              return result;
            } catch (error) {
              try {
                await client.query('ROLLBACK');
              } catch {
                // Rollback failure must not mask the original domain error.
              }
              throw error;
            }
          });
        } catch (error) {
          const retryable = classifySqlState(sqlStateOf(error)) === 'retry';
          if (retryable && options?.allowSideEffects === true) {
            // Caller declared external side effects: never replay the callback.
            throw error;
          }
          if (retryable && attempt < maxAttempts) {
            continue;
          }
          throw error;
        }
      }
    },
  };
}
