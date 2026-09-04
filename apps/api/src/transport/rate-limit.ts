/**
 * C005 — In-memory sliding-window rate limiter (per-process).
 *
 * Development/default implementation of RateLimiterPort. A distributed
 * Redis-backed limiter replaces it in C094 without changing call sites.
 */
import type { RateLimiterPort } from './kernel.js';
import { RATE_LIMITS, type RateLimitClass } from './kernel.js';
import type { Redis } from 'ioredis';

interface Bucket {
  readonly windowStart: number;
  count: number;
}

export class InMemoryRateLimiter implements RateLimiterPort {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxKeys = 10_000) {}

  async consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const [classPart] = key.split(':');
    const limits = RATE_LIMITS[classPart as RateLimitClass] ?? RATE_LIMITS['default'];
    const now = Date.now();
    const windowStart =
      Math.floor(now / (limits.windowSeconds * 1_000)) * limits.windowSeconds * 1_000;

    if (this.buckets.size > this.maxKeys) {
      // Expiry-aware eviction: drop buckets from previous windows first
      // (they are stale by definition), then oldest-inserted. Never blanket-
      // clear: attacker-controlled key cardinality must not reset the state
      // of unrelated (including abusive) clients.
      for (const [key, bucket] of this.buckets) {
        if (bucket.windowStart < windowStart) this.buckets.delete(key);
      }
      while (this.buckets.size > this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (oldest.done === true) break;
        this.buckets.delete(oldest.value);
      }
    }

    const existing = this.buckets.get(key);
    const bucket =
      existing !== undefined && existing.windowStart === windowStart
        ? existing
        : { windowStart, count: 0 };
    bucket.count += 1;
    this.buckets.delete(key); // refresh insertion order → LRU-ish eviction
    this.buckets.set(key, bucket);

    if (bucket.count > limits.limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowStart + limits.windowSeconds * 1_000 - now) / 1_000),
      );
      return { allowed: false, retryAfterSeconds: retryAfter };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Shared sliding-window limiter for multi-instance production API deploys. */
export class RedisRateLimiter implements RateLimiterPort {
  constructor(private readonly redis: Redis) {}

  async consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const [classPart] = key.split(':');
    const limits = RATE_LIMITS[classPart as RateLimitClass] ?? RATE_LIMITS.default;
    const window = Math.floor(Date.now() / (limits.windowSeconds * 1_000));
    const redisKey = `devguard:ratelimit:${classPart}:${window}:${key}`;
    const count = Number(
      await this.redis.eval(
        `local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c`,
        1,
        redisKey,
        limits.windowSeconds,
      ),
    );
    return count > limits.limit
      ? {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            limits.windowSeconds - (Math.floor(Date.now() / 1000) % limits.windowSeconds),
          ),
        }
      : { allowed: true, retryAfterSeconds: 0 };
  }
}
