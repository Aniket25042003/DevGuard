/**
 * C096 self-tests — failure injection boundaries, leases, leaks, evidence.
 */
import { describe, expect, it } from 'vitest';
import {
  DeterministicClock,
  FailureInjector,
  LeakSentinel,
  assertNoLeaks,
  ResourceLeaseManager,
  SeededRandom,
  TestRuntime,
  assertDisposablePostgres,
} from '@devguard/test-harness';

describe('FailureInjector', () => {
  it('injects only at declared points and refuses unknown ones', () => {
    const injector = new FailureInjector();
    expect(() =>
      injector.arm('provider.send', { errorFactory: () => new Error('boom') }),
    ).not.toThrow();
    expect(() => injector.arm('not-a-point' as never, { errorFactory: () => new Error() })).toThrow(
      TypeError,
    );
    expect(() => injector.maybeInject('queue.enqueue')).not.toThrow();
    expect(() => injector.maybeInject('provider.send')).toThrow('boom');
    // Default `once`: disarmed itself after firing.
    expect(injector.pendingCount()).toBe(0);
    expect(() => injector.maybeInject('provider.send')).not.toThrow();
  });

  it('sticky scripts fire repeatedly until disarmed', () => {
    const injector = new FailureInjector();
    injector.arm('db.before-commit', { once: false, errorFactory: () => new Error('nope') });
    expect(() => injector.maybeInject('db.before-commit')).toThrow('nope');
    // Sticky: still armed for the next call.
    expect(() => injector.maybeInject('db.before-commit')).toThrow('nope');
    injector.disarmAll();
    expect(injector.pendingCount()).toBe(0);
  });
});

describe('ResourceLeaseManager', () => {
  const clock = new DeterministicClock(0);
  const manager = new ResourceLeaseManager(new SeededRandom(5), clock);

  it('issues unique namespaced resources per worker/case', () => {
    const a = manager.issue({ workerId: 'w1', caseName: 'case-a', seed: 1 });
    const b = manager.issue({ workerId: 'w2', caseName: 'case-a', seed: 1 });
    expect(a.leaseId).not.toBe(b.leaseId);
    expect(a.databaseName.startsWith('dg_')).toBe(true);
    expect(a.databaseName).not.toBe(b.databaseName);
    expect(a.redisPrefix.endsWith(':')).toBe(true);
    expect(manager.activeCount()).toBe(2);
  });

  it('detects expiry by fake clock and drops expired leases on demand', () => {
    const lease = manager.issue({ workerId: 'w1', caseName: 'expiring', seed: 2 });
    expect(manager.isExpired(lease)).toBe(false);
    clock.advanceBy(31 * 60_000);
    expect(manager.isExpired(lease)).toBe(true);
    expect(manager.dropExpired()).toContain(lease.leaseId);
    expect(manager.activeCount()).toBe(0);
  });

  it('release is idempotent', () => {
    const lease = manager.issue({ workerId: 'w', caseName: 'r', seed: 3 });
    manager.release(lease);
    manager.release(lease);
    expect(manager.activeCount()).toBe(0);
  });
});

describe('LeakSentinel', () => {
  it('flags canary values in captured surfaces', () => {
    const sentinel = new LeakSentinel();
    expect(sentinel.scanCanary('clean output')).toEqual([]);
    expect(sentinel.scanCanary(`prefix ${sentinel.canaryValue} suffix`)).toHaveLength(1);
    expect(sentinel.scanCanary('sk-live-realkey')).toContain('sk-live-…');
  });

  it('assertNoLeaks passes clean reports and describes problems otherwise', () => {
    expect(() =>
      assertNoLeaks({
        pendingTimers: 0,
        unhandledRejections: [],
        armedFailureScripts: 0,
        canaryHits: [],
      }),
    ).not.toThrow();
    try {
      assertNoLeaks({
        pendingTimers: 2,
        unhandledRejections: ['x'],
        armedFailureScripts: 1,
        canaryHits: [],
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(String(error)).toMatch(
        /pending fake-clock timer.*unhandled rejection.*armed failure script/s,
      );
    }
  });
});

describe('TestRuntime lifecycle FSM (C096 §9)', () => {
  it('runs unit-only cases without PostgreSQL and cleans to terminal CLEAN state', async () => {
    const runtime = TestRuntime.create({ seed: 1, suiteId: 'self.fsm' });
    expect(runtime.state).toBe('ALLOCATED');
    runtime.beginCase(); // unit-only path: ALLOCATED -> RUNNING
    expect(runtime.state).toBe('RUNNING');
    await runtime.cleanup();
    expect(runtime.state).toBe('CLEAN');
  });

  it('throws TEST_RUNTIME_CLOSED after cleanup and blocks further use', async () => {
    const runtime = TestRuntime.create({ seed: 2, suiteId: 'self.closed' });
    await runtime.cleanup();
    await expect(runtime.provisionPostgres()).rejects.toMatchObject({
      code: 'TEST_RUNTIME_CLOSED',
    });
    expect(() => runtime.beginCase()).toThrow();
  });

  it('requires provisionPostgres before beginCase when postgresAdminUrl was configured', () => {
    const runtime = TestRuntime.create({
      seed: 3,
      suiteId: 'self.pg-order',
      postgresAdminUrl: 'postgres://u:p@127.0.0.1:25432/devguard_test',
    });
    expect(() => runtime.beginCase()).toThrow(/provisionPostgres\(\) before beginCase/);
    void runtime.cleanup();
  });

  it('refuses seeds that are not non-negative safe integers', () => {
    expect(() => TestRuntime.create({ seed: -1, suiteId: 's' })).toThrow(TypeError);
    expect(() => TestRuntime.create({ seed: Number.NaN, suiteId: 's' })).toThrow(TypeError);
  });

  it('records evidence with seed/clock/suite correlation fields', () => {
    const runtime = TestRuntime.create({ seed: 77, suiteId: 'self.evidence' });
    runtime.recordCase({
      caseId: 'c1',
      attempt: 1,
      status: 'passed',
      startedAtMs: 0,
      durationMs: 5,
      assertionCount: 3,
      providerContracts: [],
      leakReport: {
        pendingTimers: 0,
        unhandledRejections: [],
        armedFailureScripts: 0,
        canaryHits: [],
      },
    });
    const manifest = JSON.parse(runtime.evidence.manifest().trim()) as Record<string, unknown>;
    expect(manifest['seed']).toBe(77);
    expect(manifest['suiteId']).toBe('self.evidence');
    expect(manifest['fixtureVersion']).toBe('fixtures@1');
    void runtime.cleanup();
  });

  it('blocks evidence containing the synthetic canary secret from clean publication', () => {
    const runtime = TestRuntime.create({ seed: 8, suiteId: 'self.canary' });
    const result = runtime.evidence.record({
      caseId: 'leaky',
      attempt: 1,
      status: 'failed',
      startedAtMs: 0,
      durationMs: 1,
      assertionCount: 0,
      providerContracts: [{ provider: 'trueforge', capability: 'session', mode: 'emulated' }],
      leakReport: {
        pendingTimers: 0,
        unhandledRejections: [],
        armedFailureScripts: 0,
        canaryHits: [],
      },
    });
    expect(result.accepted).toBe(true);
    void runtime.cleanup();
  });

  it('measures leaked timers and armed scripts per case', () => {
    const runtime = TestRuntime.create({ seed: 9, suiteId: 'self.leaks' });
    runtime.clock.setTimeout(() => undefined, 100);
    runtime.failureInjector.arm('checkpoint.wait', { errorFactory: () => new Error('armed') });
    const report = runtime.measureLeaks();
    expect(report.pendingTimers).toBe(1);
    expect(report.armedFailureScripts).toBe(1);
    expect(() => runtime.requireNoLeaks()).toThrow(/leak/i);
    runtime.clock.clearAll();
    runtime.failureInjector.disarmAll();
    void runtime.cleanup();
  });
});

describe('disposable-Postgres guard (C096/C098 reset safety)', () => {
  it('accepts clearly disposable URLs and rejects production-shaped ones', () => {
    expect(() =>
      assertDisposablePostgres('postgres://u:p@127.0.0.1:5432/devguard_test'),
    ).not.toThrow();
    expect(() => assertDisposablePostgres('postgres://u:p@127.0.0.1:5432/analytics_prod')).toThrow(
      /non-disposable/,
    );
  });
});
