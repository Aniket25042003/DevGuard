/**
 * C057 §22 — envelope validation, registry uniqueness, retry/backoff math,
 * lease/stall semantics, cancellation fencing and runtime loop behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  JobRegistry,
  QUEUE_NAMES,
  EnvelopeValidationError,
  UnknownJobTypeError,
  buildEnvelope,
  dlqFor,
} from '@devguard/queue';
import {
  CancellationFence,
  InMemoryTransport,
  QUEUE_RETRY_DEFAULTS,
  backoffDelayMs,
} from '@devguard/queue';
import { WorkerRuntime } from '@devguard/queue';
import type { JobEnvelope } from '@devguard/queue';

function envelope(
  uniqueKey = 'job-1',
  overrides: Partial<Parameters<typeof buildEnvelope>[0]> = {},
): JobEnvelope {
  return buildEnvelope({
    jobType: 'webhook.process',
    schemaVersion: 1,
    queue: 'webhook-processing',
    uniqueKey,
    payload: { deliveryId: 'd1' },
    correlationId: 'corr-1',
    ...overrides,
  });
}

describe('envelope validation (C057 §8)', () => {
  it('builds deterministic jobId from jobType+uniqueKey with v1 marking', () => {
    const env = envelope();
    expect(env.jobId).toBe('env1:webhook.process:job-1');
    expect(env.envelopeVersion).toBe(1);
    expect(env.cancellationGeneration).toBe(0);
  });

  it('rejects oversized payloads and forbidden fields', () => {
    expect(() => envelope('big', { payload: { blob: 'y'.repeat(40_000) } })).toThrow(
      EnvelopeValidationError,
    );
    expect(() => envelope('secret', { payload: { token: 'ghp_x' } })).toThrow(
      /forbidden payload field/,
    );
  });

  it('exposes six named queues each with a DLQ counterpart', () => {
    expect(QUEUE_NAMES).toHaveLength(6);
    expect(dlqFor('workflow-execution')).toBe('workflow-execution-dlq');
    expect(dlqFor('cleanup')).toBe('cleanup-dlq');
  });
});

describe('job registry (C057 §5)', () => {
  const handler = async (): Promise<never> => ({ outcome: 'SUCCEEDED' }) as never;

  it('rejects duplicate {jobType, schemaVersion} registrations at startup', () => {
    const registry = new JobRegistry();
    registry.register('webhook.process', 1, handler);
    expect(() => registry.register('webhook.process', 1, handler)).toThrow(/duplicate/i);
  });

  it('fails closed resolving unknown types or versions (JOB_UNKNOWN)', () => {
    const registry = new JobRegistry();
    registry.register('webhook.process', 1, handler);
    expect(() => registry.resolve('brand.new', 1)).toThrow(UnknownJobTypeError);
    expect(() => registry.resolve('webhook.process', 2)).toThrow(UnknownJobTypeError);
  });
});

describe('retry classification & backoff (C057 §4.2)', () => {
  it('grows exponentially to the cap then stays bounded', () => {
    // Deterministic random=1 → full-jitter delay equals the exponential value.
    const options = { maxAttempts: 10, backoffBaseSeconds: 1, maxBackoffSeconds: 60 };
    const delays = [1, 2, 3, 4, 5, 6, 10].map((attempt) =>
      backoffDelayMs(attempt, options, () => 1),
    );
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]);
  });

  it('full jitter never exceeds the current exponential bound', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      for (const seed of [0, 0.25, 0.5, 0.75]) {
        const delay = backoffDelayMs(attempt, { maxAttempts: 20 }, () => seed);
        const bound = Math.min(60, 2 ** (attempt - 1)) * 1000;
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('carries per-queue default attempt budgets', () => {
    expect(QUEUE_RETRY_DEFAULTS['outbox-publishing']!.maxAttempts).toBeGreaterThan(
      QUEUE_RETRY_DEFAULTS.cleanup!.maxAttempts,
    );
  });
});

function makeHarness() {
  let nowMs = 1_000_000;
  const transport = new InMemoryTransport(() => nowMs);
  const fence = new CancellationFence();
  const handled: string[] = [];
  const registry = new JobRegistry();
  registry.register('webhook.process', 1, async () => {
    handled.push('ok');
    return { outcome: 'SUCCEEDED' };
  });
  const runtime = new WorkerRuntime(registry, transport, fence, undefined, {
    queues: ['webhook-processing'],
    leaseMs: 30_000,
    pollIntervalMs: 100,
    maxConcurrent: 4,
    workerId: 'worker-a',
  });
  // Intake is gated on an explicit start() (fixer-tightened contract);
  // suites drive the loop through the started state.
  runtime.start();
  return {
    transport,
    fence,
    runtime,
    handled,
    advance: (ms: number): void => void (nowMs += ms),
    getNow: (): number => nowMs,
  };
}

describe('runtime execution semantics (C057 §9)', () => {
  it('claims and completes successfully once; duplicate enqueue is idempotent', async () => {
    const h = makeHarness();
    await h.transport.enqueue(envelope(), 0);
    // Second add of same unique key is rejected as duplicate.
    expect(await h.transport.enqueue(envelope(), 0)).toEqual({ accepted: false, duplicate: true });

    expect(await h.runtime.processOnce(h.getNow())).toBe(1);
    expect(h.handled).toEqual(['ok']);
    // Nothing left to process.
    expect(await h.runtime.processOnce(h.getNow())).toBe(0);
  });

  it('stolen-lease completion is fenced: stale owner cannot ack', async () => {
    const h = makeHarness();
    const one = envelope('fenced-1');
    await h.transport.enqueue(one, 0);
    await h.transport.claim('webhook-processing', 50, 'worker-fast');
    // Lease expires before the original owner finishes.
    h.advance(51);
    await h.transport.releaseExpiredLeases(h.getNow());
    const stolen = await h.transport.claim('webhook-processing', 30_000, 'worker-b');
    expect(stolen).toHaveLength(1);
    // Original stale owner tries to complete.
    expect(await h.transport.complete(one.uniqueKey, 'worker-fast')).toBe('fenced');
    expect(await h.transport.complete(one.uniqueKey, 'worker-b')).toBe('completed');
  });

  it('delivery is AT-LEAST-ONCE: expired leases re-deliver (reconciliation not loss)', async () => {
    const h = makeHarness();
    await h.transport.enqueue(envelope('atleast'), 0);
    await h.transport.claim('webhook-processing', 10, 'worker-crash');
    // Owner crashed without completing; after expiry the job is claimable again.
    h.advance(11);
    const reclaimed = await h.transport.claim('webhook-processing', 30_000, 'worker-recovery');
    expect(reclaimed.map((j) => j.uniqueKey)).toEqual(['atleast']);
  });

  it('cancellation generation bump fences queued work before dispatch', async () => {
    const h = makeHarness();
    const runJob = buildEnvelope({
      jobType: 'workflow.execute',
      schemaVersion: 1,
      queue: 'workflow-execution',
      uniqueKey: 'run-job',
      payload: {},
      correlationId: 'c',
      workflowRunId: 'run-77',
      cancellationGeneration: 0,
    });
    // Registry lacks workflow.execute@1 → unknown-type path would DLQ; register to test fencing.
    let executed = false;
    const registry = new JobRegistry();
    registry.register('workflow.execute', 1, async () => {
      executed = true;
      return { outcome: 'SUCCEEDED' };
    });
    const runtime = new WorkerRuntime(registry, h.transport, h.fence, undefined, {
      queues: ['workflow-execution'],
      leaseMs: 30_000,
      pollIntervalMs: 100,
      maxConcurrent: 2,
      workerId: 'w',
    });
    runtime.start();
    await h.transport.enqueue(runJob, 0);
    // Run was cancelled before processing.
    h.fence.bump('run-77');
    await runtime.processOnce(h.getNow());
    expect(executed).toBe(false); // fenced BEFORE any handler ran
    void runJob;
  });
});
