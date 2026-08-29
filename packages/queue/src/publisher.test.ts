/** CP008 / C060 — OutboxPublisher: rows → typed jobs → advance cursor. */
import { describe, expect, it } from 'vitest';
import { OutboxPublisher, type OutboxScanPort } from './publisher.js';
import type { QueuePortShape } from './runtime.js';
import type { JobEnvelope } from './envelope.js';

class FakeOutbox implements OutboxScanPort {
  readonly rows: Array<{
    id: bigint;
    eventType: string;
    payload: Record<string, unknown>;
    correlation: Record<string, unknown>;
  }>;
  readonly published: bigint[] = [];
  private cursor = 0n;
  constructor(rows: FakeOutbox['rows']) {
    this.rows = rows;
  }
  async listUnpublished(afterId: bigint, limit: number): Promise<FakeOutbox['rows']> {
    return this.rows.filter((r) => r.id > afterId).slice(0, limit);
  }
  async markPublished(id: bigint): Promise<void> {
    this.published.push(id);
    if (id > this.cursor) this.cursor = id;
  }
  async lastPublishedId(): Promise<bigint> {
    return this.cursor;
  }
}

class RecordingQueue implements QueuePortShape {
  readonly enqueued: JobEnvelope[] = [];
  private readonly duplicates = new Set<string>();
  async enqueue(job: JobEnvelope): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (this.duplicates.has(job.uniqueKey)) return { accepted: false, duplicate: true };
    this.duplicates.add(job.uniqueKey);
    this.enqueued.push(job);
    return { accepted: true, duplicate: false };
  }
  async remove(): Promise<'removed' | 'active' | 'missing'> {
    return 'missing';
  }
}

describe('OutboxPublisher (CP008)', () => {
  it('publishes workflow.queued rows as workflow-execution jobs and advances the cursor', async () => {
    const outbox = new FakeOutbox([
      {
        id: 1n,
        eventType: 'workflow.queued',
        payload: {},
        correlation: { runId: 'run-1', repositoryId: 'repo-1' },
      },
      { id: 2n, eventType: 'workflow.queued', payload: {}, correlation: { runId: 'run-2' } },
    ]);
    const queue = new RecordingQueue();
    const publisher = new OutboxPublisher({
      outbox,
      queue,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });
    const published = await publisher.publishOnce();
    expect(published).toBe(2);
    expect(queue.enqueued.map((j) => j.jobType)).toEqual(['workflow.execute', 'workflow.execute']);
    expect(queue.enqueued[0]?.queue).toBe('workflow-execution');
    expect(queue.enqueued[0]?.workflowRunId).toBe('run-1');
    expect(outbox.published).toEqual([1n, 2n]);
    // A second pass publishes nothing new.
    expect(await publisher.publishOnce()).toBe(0);
  });

  it('skips unknown event types but still advances the cursor, and tolerates duplicate enqueues', async () => {
    const outbox = new FakeOutbox([
      { id: 1n, eventType: 'unknown.type', payload: {}, correlation: {} },
      {
        id: 2n,
        eventType: 'webhook.accepted',
        payload: { deliveryId: 'd1', payloadRef: 'ref-1', repositoryId: 'repo-1' },
        correlation: { deliveryId: 'd1' },
      },
      {
        id: 3n,
        eventType: 'webhook.accepted',
        payload: { deliveryId: 'd1', payloadRef: 'ref-1', repositoryId: 'repo-1' },
        correlation: { deliveryId: 'd1' },
      },
    ]);
    const queue = new RecordingQueue();
    const publisher = new OutboxPublisher({ outbox, queue, now: () => 0 });
    const published = await publisher.publishOnce();
    expect(published).toBe(3);
    // 'd1' is a duplicate uniqueKey → second enqueue deduped, still advances.
    expect(queue.enqueued.filter((j) => j.jobType === 'webhook.process').length).toBe(1);
    expect(outbox.published).toEqual([1n, 2n, 3n]);
  });
});
