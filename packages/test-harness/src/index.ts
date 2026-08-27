/**
 * @devguard/test-harness — dev-only deterministic test runtime (C096).
 *
 * Boundary rule: exported only for test suites; production code must never
 * import this package (enforced by the C001 boundary matrix, layer `test`).
 */
export { DeterministicClock, type ClockTimeout } from './clock.js';
export { SeededRandom, SeededIdSource, seededUuidV7 } from './random.js';
export { ResourceLeaseManager, type TestLease, type TestLeaseInput } from './lease.js';
export {
  FAILURE_POINTS,
  FailureInjector,
  type FailurePoint,
  type FailureScript,
} from './failure.js';
export { LeakSentinel, assertNoLeaks, type LeakReport } from './leaks.js';
export { EvidenceWriter, type TestCaseEvidence } from './evidence.js';
import type { TestRuntimeOptions } from './runtime.js';
import {
  TEST_INFRASTRUCTURE_CODE,
  TEST_RUNTIME_CLOSED,
  registerErrorDescriptors,
} from './errors.js';
import { TestRuntime } from './runtime.js';

registerErrorDescriptors();
void TEST_RUNTIME_CLOSED;
void TEST_INFRASTRUCTURE_CODE;

export { makeError as makeHarnessError } from './errors.js';
export {
  RUNTIME_STATES,
  TestRuntime,
  type RuntimeState,
  type TestRuntimeOptions,
} from './runtime.js';
export {
  assertDisposablePostgres,
  provisionDatabase,
  teardownDatabase,
  truncateAll,
  type PostgresFixtureHandle,
  type PostgresFixtureOptions,
} from './postgres.js';

/** One-call wrapper used by suites: runs the body with a fully cleaned runtime. */
export async function withTestRuntime<T>(
  options: TestRuntimeOptions & { readonly postgresAdminUrl?: string },
  body: (runtime: TestRuntime) => Promise<T>,
): Promise<T> {
  const runtime = TestRuntime.create(options);
  try {
    const result = await body(runtime);
    return result;
  } finally {
    await runtime.cleanup();
  }
}
