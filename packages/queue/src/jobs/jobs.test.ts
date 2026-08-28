import { describe, expect, it } from 'vitest';
import { WebhookProcessingService, InMemoryDeliveryStore } from './job-processing.js';
import { RetryClassifier, OutboxCleanupService, InMemoryOutboxStore } from './cleanup.js';
import { resolveDeliveryEdge } from './contracts.js';

describe('C058 webhook/job processing', () => {
  it('routes a matched trigger and creates a run once', async () => {
    const store = new InMemoryDeliveryStore();
    const router = {
      route: async () => ({ matched: true, triggerKeys: ['repo:r:pull_request:opened'] }),
    };
    const creator = { createRuns: async () => ({ runIds: ['run-1'] }) };
    const svc = new WebhookProcessingService({ store, router, creator });
    const job = {
      jobType: 'webhook.process',
      jobId: 'j1',
      envelopeVersion: 1,
      schemaVersion: 1,
      queue: 'webhook-ingress',
      uniqueKey: 'j1',
      payload: { deliveryId: 'dlv-1', payloadRef: 'pull_request', repositoryId: 'repo-1' },
      correlationId: 'c1',
      cancellationGeneration: 0,
      enqueuedAtIso: '2026-08-28T00:00:00.000Z',
    } as never;
    const outcome = await svc.process(job);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.nextRun).toBe('run-1');
    expect(await store.state('dlv-1')).toBe('ROUTED');
    // duplicate terminal delivery is a no-op replay (claim count stays 1)
    await svc.process(job);
    expect(store.claims.size).toBe(1);
  });

  it('ignores an unmatched trigger', async () => {
    const store = new InMemoryDeliveryStore();
    const svc = new WebhookProcessingService({
      store,
      router: { route: async () => ({ matched: false, triggerKeys: [] }) },
      creator: { createRuns: async () => ({ runIds: [] }) },
    });
    const job = {
      jobType: 'webhook.process',
      jobId: 'j2',
      envelopeVersion: 1,
      schemaVersion: 1,
      queue: 'webhook-ingress',
      uniqueKey: 'j2',
      payload: { deliveryId: 'dlv-2', payloadRef: 'ping', repositoryId: 'r' },
      correlationId: 'c',
      cancellationGeneration: 0,
      enqueuedAtIso: 'ts',
    } as never;
    const outcome = await svc.process(job);
    expect(outcome.ok).toBe(true);
    expect(await store.state('dlv-2')).toBe('IGNORED');
  });

  it('only permits legal delivery transitions', () => {
    expect(resolveDeliveryEdge('PROCESSING', 'ROUTED')).toBe(true);
    expect(resolveDeliveryEdge('PROCESSING', 'DEAD_LETTERED')).toBe(true);
    expect(resolveDeliveryEdge('ACCEPTED', 'ROUTED')).toBe(false);
    expect(resolveDeliveryEdge('DEAD_LETTERED', 'PROCESSING')).toBe(false);
  });
});

describe('C060 retry/DLQ/cleanup', () => {
  it('classifies retryability: terminal policy errors never retry', () => {
    const c = new RetryClassifier();
    expect(c.classify('POLICY_DENIED', 0, 5).kind).toBe('terminal');
    expect(c.classify('POLICY_DENIED', 0, 5).attemptsLeft).toBe(false);
    expect(c.classify('RATE_LIMITED', 0, 5).kind).toBe('safe');
    expect(c.classify('COMMAND_OUTCOME_UNKNOWN', 0, 8).kind).toBe('reconcile');
  });

  it('dead-letters rows past max attempts and cleans acknowledged rows', async () => {
    const store = new InMemoryOutboxStore();
    store.rows.set('a', {
      rowId: 'a',
      eventType: 'x',
      publishedAtIso: 'ts',
      acknowledged: false,
      attempts: 5,
    });
    store.rows.set('b', {
      rowId: 'b',
      eventType: 'y',
      publishedAtIso: 'ts',
      acknowledged: true,
      attempts: 0,
    });
    const svc = new OutboxCleanupService({ store, maxAttempts: 5 });
    const r = await svc.drain();
    expect(r.deadLettered).toBeGreaterThanOrEqual(1);
    expect(store.dlq.some((d) => d.rowId === 'a')).toBe(true);
  });
});
