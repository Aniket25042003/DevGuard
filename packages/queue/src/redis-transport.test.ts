/** CP008 — Redis transport: enqueue/claim/complete, lease recovery, DLQ. */
import { describe, expect, it } from 'vitest';
import { RedisQueueTransport, type RedisLikeClient } from './redis-transport.js';
import { buildEnvelope } from './envelope.js';

class MemRedis implements RedisLikeClient {
  readonly zsets = new Map<string, Map<string, number>>();
  readonly strings = new Map<string, string>();
  async zadd(key: string, score: number, member: string): Promise<unknown> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    const had = set.has(member);
    set.set(member, score);
    this.zsets.set(key, set);
    return had ? 0 : 1; // ZADD returns 1 when the member is newly added
  }
  async zrem(key: string, member: string): Promise<unknown> {
    const set = this.zsets.get(key);
    if (set === undefined || !set.delete(member)) return 0;
    return 1;
  }
  async zrangebyscore(
      key: string,
      min: number,
      max: number,
      _clause: 'LIMIT',
      _offset: number,
      limit: number,
    ): Promise<string[]> {
    const set = this.zsets.get(key);
    if (set === undefined) return [];
    return [...set.entries()]
      .filter(([, s]) => s >= min && s <= max)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([m]) => m);
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.strings.set(key, value);
    return 'OK';
  }
  async del(key: string): Promise<unknown> {
    this.strings.delete(key);
    return 1;
  }
}

function envelope(
  overrides: Partial<Parameters<typeof buildEnvelope>[0]> = {},
): ReturnType<typeof buildEnvelope> {
  return buildEnvelope({
    jobType: 'workflow.execute',
    schemaVersion: 1,
    queue: 'workflow-execution',
    uniqueKey: 'run-1',
    payload: { runId: 'run-1', stepId: 'start', stepAttempt: 0 },
    correlationId: 'c1',
    ...overrides,
  });
}

describe('RedisQueueTransport (CP008)', () => {
  it('enqueues, claims, and completes a job', async () => {
    const client = new MemRedis();
    let t = 0;
    const transport = new RedisQueueTransport({ client, clockNow: () => t });
    const e = envelope();
    const enqueued = await transport.enqueue(e, 0);
    expect(enqueued.accepted).toBe(true);

    t = 100;
    const claimed = await transport.claim('workflow-execution', 5000, 'w1');
    expect(claimed.length).toBe(1);
    expect(claimed[0]?.uniqueKey).toBe('run-1');

    expect(await transport.complete('run-1', 'w1')).toBe('completed');
    expect(await client.get('dg:q:job:run-1')).toBeNull();
  });

  it('recovers an expired lease back to pending and re-claims it', async () => {
    const client = new MemRedis();
    let t = 0;
    const transport = new RedisQueueTransport({ client, clockNow: () => t });
    await transport.enqueue(envelope(), 0);
    t = 10;
    await transport.claim('workflow-execution', 1000, 'w1');
    t = 2000; // lease expired
    const released = await transport.releaseExpiredLeases(t);
    expect(released).toBe(1);
    const claimed = await transport.claim('workflow-execution', 1000, 'w2');
    expect(claimed.length).toBe(1);
  });

  it('dead-letters and refuses completion after a fence', async () => {
    const client = new MemRedis();
    let t = 0;
    const transport = new RedisQueueTransport({ client, clockNow: () => t });
    await transport.enqueue(envelope(), 0);
    t = 10;
    await transport.claim('workflow-execution', 1000, 'w1');
    await transport.deadLetter('run-1', 'PERMANENT');
    expect(await transport.complete('run-1', 'w1')).toBe('missing');
  });
});
