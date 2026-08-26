/**
 * C096 §8/§19 — resource leases.
 *
 * Parallel workers never share tenant IDs, database schemas/databases, Redis
 * prefixes, ports, provider scenario instances or filesystem roots. The lease
 * manager mints uniquely-named resources per worker/case and records expiry so
 * a crashed run can be reclaimed by name later (C096 §9 restart recovery).
 */
import type { SeededRandom } from './random.js';

export interface TestLeaseInput {
  readonly workerId: string;
  readonly caseName: string;
  readonly seed: number;
}

export interface TestLease extends TestLeaseInput {
  readonly leaseId: string;
  readonly databaseName: string;
  readonly redisPrefix: string;
  readonly filesystemRootSuffix: string;
  readonly objectPrefix: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export class ResourceLeaseManager {
  #active = new Map<string, TestLease>();

  constructor(
    private readonly random: SeededRandom,
    private readonly clock: { now(): number },
    private readonly defaultTtlMs = 30 * 60 * 1000,
  ) {}

  issue(input: TestLeaseInput): TestLease {
    const token = Math.floor(this.random.next() * Number.MAX_SAFE_INTEGER).toString(36);
    const slug = `${input.workerId}-${input.caseName}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const leaseId = `${slug}-${token}`;
    const lease: TestLease = {
      ...input,
      leaseId,
      // PostgreSQL identifiers have no hyphens; database names stay alnum+underscore.
      databaseName: `dg_${slug.replace(/-/g, '_')}_${Math.floor(this.random.next() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`.slice(0, 63),
      redisPrefix: `dg:t:${leaseId}:`,
      filesystemRootSuffix: `.dg-test/${leaseId}`,
      objectPrefix: `test/${leaseId}/`,
      issuedAtMs: this.clock.now(),
      expiresAtMs: this.clock.now() + this.defaultTtlMs,
    };
    this.#active.set(leaseId, lease);
    return lease;
  }

  isExpired(lease: TestLease, atMs = this.clock.now()): boolean {
    return atMs > lease.expiresAtMs;
  }

  release(lease: TestLease): void {
    this.#active.delete(lease.leaseId);
  }

  activeCount(): number {
    return this.#active.size;
  }

  /** Drop expired leases after crash recovery ran their cleanup. */
  dropExpired(atMs = this.clock.now()): string[] {
    const expired: string[] = [];
    for (const [id, lease] of this.#active) {
      if (this.isExpired(lease, atMs)) {
        this.#active.delete(id);
        expired.push(id);
      }
    }
    return expired;
  }
}
