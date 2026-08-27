/**
 * C096 §5/§6/§9 — TestRuntime.
 *
 * One runtime owns clock, seeded IDs/randomness, leases, PostgreSQL fixtures,
 * failure injection, leak sentinels and evidence collection. Its lifecycle is
 * a controlled FSM:
 *
 *   ALLOCATED → MIGRATED → SEEDED → RUNNING → ASSERTING → CLEANING → CLEAN
 *
 * with terminal FAILED_CLEANUP blocking further use. Illegal use after
 * cleanup throws TEST_RUNTIME_CLOSED. Tests cannot skip cleanup: every exit
 * path passes through `cleanup()`.
 */
import { DeterministicClock } from './clock.js';
import { registerErrorDescriptors, makeError } from './errors.js';
import type { TestCaseEvidence } from './evidence.js';
import { EvidenceWriter } from './evidence.js';
import { FailureInjector } from './failure.js';
import { LeakSentinel, assertNoLeaks, type LeakReport } from './leaks.js';
import { ResourceLeaseManager, type TestLease } from './lease.js';
import { SeededIdSource, type SeededRandom } from './random.js';
import {
  provisionDatabase,
  teardownDatabase,
  truncateAll,
  type PostgresFixtureHandle,
} from './postgres.js';

// Harness codes participate in C003's total registry like every other domain.
registerErrorDescriptors();

export const RUNTIME_STATES = [
  'ALLOCATED',
  'MIGRATED',
  'SEEDED',
  'RUNNING',
  'ASSERTING',
  'CLEANING',
  'CLEAN',
] as const;

export type RuntimeState = (typeof RUNTIME_STATES)[number] | 'FAILED_CLEANUP';

const LEGAL: Readonly<Record<string, readonly RuntimeState[]>> = {
  // ALLOCATED -> RUNNING is legal only for pure-unit runtimes (no PG fixtures);
  // provisionPostgres() otherwise enforces the full ALLOCATED→MIGRATED path.
  ALLOCATED: ['MIGRATED', 'RUNNING', 'CLEANING', 'FAILED_CLEANUP'],
  MIGRATED: ['SEEDED', 'FAILED_CLEANUP'],
  SEEDED: ['RUNNING', 'FAILED_CLEANUP'],
  RUNNING: ['ASSERTING', 'CLEANING', 'FAILED_CLEANUP'],
  ASSERTING: ['CLEANING', 'FAILED_CLEANUP'],
  CLEANING: ['CLEAN', 'FAILED_CLEANUP'],
  FAILED_CLEANUP: [],
  CLEAN: [],
};

const CLOCK_START_MS = 1_700_000_000_000;

export interface TestRuntimeOptions {
  /** Deterministic suite seed printed in evidence and required for replay. */
  readonly seed: number;
  readonly suiteId: string;
  readonly fixtureVersion?: string;
  /** Disposable PostgreSQL admin URL; absent means PG fixtures are unavailable. */
  readonly postgresAdminUrl?: string;
  readonly workerId?: string;
}

export class TestRuntime {
  #state: RuntimeState = 'ALLOCATED';
  readonly clock: DeterministicClock;
  readonly ids: SeededIdSource;
  readonly random: SeededRandom;
  readonly leases: ResourceLeaseManager;
  readonly failureInjector: FailureInjector;
  readonly leaks: LeakSentinel;
  readonly evidence: EvidenceWriter;
  readonly seed: number;
  readonly suiteId: string;
  readonly caseName: string;
  readonly fixtureVersion: string;
  readonly workerId: string;
  readonly postgresAdminUrl: string | undefined;
  #postgres?: PostgresFixtureHandle;
  #lease?: TestLease;

  private constructor(options: TestRuntimeOptions) {
    if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
      throw new TypeError(
        `TestRuntime requires a non-negative integer seed, got ${String(options.seed)}`,
      );
    }
    this.seed = options.seed;
    this.suiteId = options.suiteId;
    this.workerId = options.workerId ?? process.pid.toString();
    this.caseName = `${options.suiteId}#${this.workerId}`;
    this.fixtureVersion = options.fixtureVersion ?? 'fixtures@1';
    this.clock = new DeterministicClock(CLOCK_START_MS);
    this.ids = new SeededIdSource(options.seed, this.clock);
    this.random = this.ids.rng;
    this.leases = new ResourceLeaseManager(this.random, this.clock);
    this.failureInjector = new FailureInjector();
    this.leaks = new LeakSentinel();
    this.evidence = new EvidenceWriter((...surfaces) => this.leaks.scanCanary(...surfaces));
    this.leaks.attach();
    this.postgresAdminUrl = options.postgresAdminUrl;
  }

  static create(options: TestRuntimeOptions): TestRuntime {
    return new TestRuntime(options);
  }

  get state(): RuntimeState {
    return this.#state;
  }

  get postgresAvailable(): boolean {
    return this.#postgres !== undefined;
  }

  #transition(next: RuntimeState): void {
    const legal = LEGAL[this.#state];
    if (!legal?.includes(next)) {
      throw new Error(`Illegal harness transition ${this.#state} -> ${next}`);
    }
    this.#state = next;
  }

  #assertOpen(): void {
    if (this.#state === 'CLEAN' || this.#state === 'FAILED_CLEANUP') {
      throw makeError('TEST_RUNTIME_CLOSED');
    }
  }

  /**
   * Provision an isolated database with migrations applied from zero.
   * Second call while open returns the same handle (idempotent per lease).
   */
  async provisionPostgres(): Promise<PostgresFixtureHandle> {
    this.#assertOpen();
    const adminUrl = this.postgresAdminUrl;
    if (!adminUrl) throw makeError('TEST_INFRASTRUCTURE');
    if (!this.#lease) {
      this.#lease = this.leases.issue({
        workerId: this.workerId,
        caseName: this.suiteId.slice(0, 24),
        seed: this.seed,
      });
    }
    if (this.#postgres) return this.#postgres;
    this.#postgres = await provisionDatabase({ adminUrl, databaseName: this.#lease.databaseName });
    // Migrations ran from zero inside a fresh leased database; fixtures next.
    this.#transition('MIGRATED');
    this.seedFixtures();
    return this.#postgres;
  }

  /** Advance to SEEDED (no-op deterministic dev seeds today; reserved for fixtures). */
  seedFixtures(): void {
    this.#assertOpen();
    if (this.#state === 'ALLOCATED') {
      throw new Error('seedFixtures requires provisioned PostgreSQL');
    }
    this.#transition('SEEDED');
  }

  /** Mark case execution started. Legal from SEEDED (with PG) or ALLOCATED (unit-only). */
  beginCase(): void {
    this.#assertOpen();
    if (this.#state === 'RUNNING' || this.#state === 'ASSERTING') return;
    if (
      this.#state === 'ALLOCATED' &&
      this.postgresAdminUrl !== undefined &&
      this.#postgres === undefined
    ) {
      throw new Error(
        'postgresAdminUrl is configured: call provisionPostgres() before beginCase()',
      );
    }
    if (this.#state === 'SEEDED' || this.#state === 'ALLOCATED') {
      this.#transition('RUNNING');
      return;
    }
    throw new Error('beginCase expects an unstarted or seeded runtime');
  }

  /** Clear all rows inside the current lease between sub-cases. */
  async resetData(): Promise<void> {
    this.#assertOpen();
    if (!this.#postgres) throw makeError('TEST_INFRASTRUCTURE');
    await truncateAll(this.#postgres.pool);
  }

  recordCase(
    evidence: Omit<TestCaseEvidence, 'seed' | 'clockStartMs' | 'suiteId' | 'fixtureVersion'> &
      Partial<Pick<TestCaseEvidence, 'fixtureVersion'>>,
  ): void {
    this.evidence.record({
      ...evidence,
      seed: this.seed,
      clockStartMs: CLOCK_START_MS,
      suiteId: this.suiteId,
      fixtureVersion: evidence.fixtureVersion ?? this.fixtureVersion,
    });
  }

  /** Measure leaks for the just-finished case; does not clean anything up. */
  measureLeaks(): LeakReport {
    return this.leaks.report(this.clock, this.failureInjector);
  }

  requireNoLeaks(): void {
    assertNoLeaks(this.measureLeaks());
  }

  /**
   * Mandatory teardown. Collects all cleanup failures and either reaches CLEAN
   * or the terminal FAILED_CLEANUP state, which blocks further use.
   */
  async cleanup(): Promise<void> {
    let failed: unknown;
    try {
      this.#transition('CLEANING');
    } catch (error) {
      failed = error;
    }
    if (this.#postgres && this.#lease) {
      const adminUrl = this.postgresAdminUrl;
      await this.#postgres.pool.drain().catch((e: unknown) => {
        failed = failed ?? e;
      });
      if (adminUrl) {
        await teardownDatabase(adminUrl, this.#lease.databaseName).catch((e: unknown) => {
          failed = failed ?? e;
        });
      }
      this.leases.release(this.#lease);
    }
    this.clock.clearAll();
    this.failureInjector.disarmAll();
    this.leaks.detach();
    if (failed || this.#state === 'FAILED_CLEANUP') {
      this.#state = 'FAILED_CLEANUP';
      throw failed ?? new Error('Harness cleanup failed');
    }
    this.#transition('CLEAN');
  }
}
