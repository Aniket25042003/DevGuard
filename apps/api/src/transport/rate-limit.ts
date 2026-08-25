/**
 * C005 — In-memory sliding-window rate limiter (per-process).
 *
 * Development/default implementation of RateLimiterPort. A distributed
 * Redis-backed limiter replaces it in C094 without changing call sites.
 */
import type { RateLimiterPort } from './kernel.js';
import { RATE_LIMITS, type RateLimitClass } from './kernel.js';

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
      this.buckets.clear(); // bounded memory; conservative reset
    }

    const existing = this.buckets.get(key);
    const bucket =
      existing !== undefined && existing.windowStart === windowStart
        ? existing
        : { windowStart, count: 0 };
    bucket.count += 1;
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
