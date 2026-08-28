/**
 * CP008 — durable Redis `QueueTransport` (C057/C060).
 *
 * Implemented over a minimal `RedisLike` sorted-set port so the transport logic
 * is unit-testable without a live Redis; the concrete client is ioredis (wired
 * in the worker composition root). Redis delivery is at-least-once best-effort:
 * PostgreSQL remains authoritative (C057 §2) — a lease theft/stall is fenced
 * and the job is re-claimed, exactly like `InMemoryTransport`.
 *
 * Keys:
 *   dg:q:pending:{queue}      ZSET score=availableAtMs member=uniqueKey
 *   dg:q:active:{queue}       ZSET score=leaseUntilMs member=uniqueKey
 *   dg:q:dlq:{queue}          ZSET score=deadLetterAtMs member=uniqueKey
 *   dg:q:job:{uniqueKey}      STR  JSON payload envelope
 *   dg:q:attempts:{uniqueKey} STR  attempts counter
 */
import type { JobEnvelope } from './envelope.js';
import type { QueueTransport } from './retry.js';

/** Minimal sorted-set client surface used by the transport (see ioredis). */
export interface RedisLikeClient {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  zrangebyscore(
    key: string,
    min: number,
    max: number,
    ...args: ['LIMIT', number, number]
  ): Promise<string[]>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisQueueTransportOptions {
  readonly client: RedisLikeClient;
  readonly clockNow?: () => number;
}

const q = (kind: string, queue: string): string => `dg:q:${kind}:${queue}`;
const jobKey = (uniqueKey: string): string => `dg:q:job:${uniqueKey}`;

export class RedisQueueTransport implements QueueTransport {
  private readonly client: RedisLikeClient;
  private readonly clockNow: () => number;

  constructor(options: RedisQueueTransportOptions) {
    this.client = options.client;
    this.clockNow = options.clockNow ?? (() => Date.now());
  }

  async enqueue(
    envelope: JobEnvelope,
    delayMs: number,
  ): Promise<{ accepted: boolean; duplicate: boolean }> {
    const availableAtMs = this.clockNow() + delayMs;
    const added = await this.client.zadd(
      q('pending', envelope.queue),
      availableAtMs,
      envelope.uniqueKey,
    );
    await this.client.set(jobKey(envelope.uniqueKey), JSON.stringify(envelope));
    return { accepted: added === 1, duplicate: added === 0 };
  }

  async claim(queueName: string, leaseMs: number, _workerId: string): Promise<JobEnvelope[]> {
    const now = this.clockNow();
    const keys = await this.client.zrangebyscore(q('pending', queueName), 0, now, 'LIMIT', 0, 10);
    const claimed: JobEnvelope[] = [];
    for (const key of keys) {
      const removed = await this.client.zrem(q('pending', queueName), key);
      if (removed === 0) continue; // another worker claimed it first
      await this.client.zadd(q('active', queueName), now + leaseMs, key);
      const raw = await this.client.get(jobKey(key));
      if (raw === null) continue; // payload lost; PG is authoritative
      const envelope = JSON.parse(raw) as JobEnvelope;
      const attempts = await this.client.get(`dg:q:attempts:${key}`);
      await this.client.set(
        `dg:q:attempts:${key}`,
        String(attempts === null ? 1 : Number(attempts) + 1),
      );
      claimed.push(envelope);
    }
    return claimed;
  }

  async heartbeat(uniqueKey: string, leaseMs: number, _workerId: string): Promise<boolean> {
    const queue = await this.queueOf(uniqueKey);
    if (queue === null) return false;
    await this.client.zadd(q('active', queue), this.clockNow() + leaseMs, uniqueKey);
    return true;
  }

  async complete(
    uniqueKey: string,
    _workerId: string,
  ): Promise<'completed' | 'fenced' | 'missing'> {
    const queue = await this.queueOf(uniqueKey);
    if (queue === null) return 'missing';
    const removed = await this.client.zrem(q('active', queue), uniqueKey);
    if (removed !== 1) return 'missing'; // not (or no longer) active under this worker
    await this.client.del(`dg:q:attempts:${uniqueKey}`);
    await this.client.del(jobKey(uniqueKey));
    return 'completed';
  }

  async deadLetter(uniqueKey: string, errorCode: string): Promise<void> {
    const queue = await this.queueOf(uniqueKey);
    if (queue === null) return;
    await this.client.zrem(q('active', queue), uniqueKey);
    await this.client.zadd(q('dlq', queue), this.clockNow(), uniqueKey);
    await this.client.set(`dg:q:dlq:meta:${uniqueKey}`, JSON.stringify({ errorCode }));
    await this.client.del(`dg:q:attempts:${uniqueKey}`);
  }

  async remove(uniqueKey: string): Promise<'removed' | 'active' | 'missing'> {
    const queue = await this.queueOf(uniqueKey);
    if (queue === null) return 'missing';
    const fromPending = await this.client.zrem(q('pending', queue), uniqueKey);
    const fromActive = await this.client.zrem(q('active', queue), uniqueKey);
    await this.client.del(jobKey(uniqueKey));
    return fromPending === 1 ? 'removed' : fromActive === 1 ? 'active' : 'missing';
  }

  async releaseExpiredLeases(nowMs: number): Promise<number> {
    let released = 0;
    for (const queue of [
      'webhook-processing' as const,
      'workflow-execution' as const,
      'approval-resume' as const,
      'outbox-publishing' as const,
      'cleanup' as const,
      'sandbox-monitoring' as const,
    ]) {
      const stale = await this.client.zrangebyscore(q('active', queue), 0, nowMs, 'LIMIT', 0, 100);
      for (const key of stale) {
        const removed = await this.client.zrem(q('active', queue), key);
        if (removed === 0) continue;
        await this.client.zadd(q('pending', queue), nowMs, key);
        released += 1;
      }
    }
    return released;
  }

  private async queueOf(uniqueKey: string): Promise<string | null> {
    const raw = await this.client.get(jobKey(uniqueKey));
    if (raw === null) return null;
    try {
      return (JSON.parse(raw) as JobEnvelope).queue;
    } catch {
      return null;
    }
  }
}
