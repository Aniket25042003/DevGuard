/**
 * C014 §13 — snapshot persistence port (C009 boundary).
 *
 * Adapter layer convention: this package defines the port; a PostgreSQL
 * implementation is deferred/owned by C009. The in-memory fake keeps unit
 * tests deterministic and enforces the same invariants: CAS on generation,
 * current-pointer per repository, and unique non-expired refresh claims.
 */
import type {
  RepositoryHealthSnapshot,
  RepositoryMetadataSnapshot,
} from '../metadata-health/contracts.js';

export type SaveResult<T> =
  | { readonly ok: true; readonly saved: T }
  | { readonly ok: false; readonly code: 'CONFLICT'; readonly current: T | undefined };

export interface MetadataSnapshotStorePort {
  findCurrentMetadata(
    repositoryDevguardId: string,
  ): Promise<RepositoryMetadataSnapshot | undefined>;
  findCurrentHealth(repositoryDevguardId: string): Promise<RepositoryHealthSnapshot | undefined>;
  /** CAS on snapshot generation: stale refreshes are rejected, not repaired. */
  compareAndSaveMetadata(
    expectedGeneration: number | undefined,
    snapshot: RepositoryMetadataSnapshot,
  ): Promise<SaveResult<RepositoryMetadataSnapshot>>;
  /** CAS on computed version so old evaluations cannot replace newer health. */
  compareAndSaveHealth(
    expectedComputedVersion: number | undefined,
    health: RepositoryHealthSnapshot,
  ): Promise<SaveResult<RepositoryHealthSnapshot>>;
  /** Idempotency claim scoped to (repositoryId, operationKey) with TTL. */
  claimRefresh(input: {
    repositoryDevguardId: string;
    operationKey: string;
    ttlMs: number;
    nowMs: number;
  }): Promise<{ granted: boolean; refreshedAtMs: number }>;
  /**
   * Release an idempotency claim (e.g. after a failed refresh) so a retry is
   * not blocked for the full TTL even though no result was persisted.
   */
  releaseRefreshClaim(input: { repositoryDevguardId: string; operationKey: string }): Promise<void>;
}

/** Deterministic in-memory fake enforcing the same CAS invariants. */
export class InMemoryMetadataSnapshotStore implements MetadataSnapshotStorePort {
  readonly metadata: Map<string, RepositoryMetadataSnapshot> = new Map();
  readonly health: Map<string, RepositoryHealthSnapshot> = new Map();
  readonly claims: Map<string, { refreshedAtMs: number }> = new Map();

  async findCurrentMetadata(
    repositoryDevguardId: string,
  ): Promise<RepositoryMetadataSnapshot | undefined> {
    return this.metadata.get(repositoryDevguardId);
  }

  async findCurrentHealth(
    repositoryDevguardId: string,
  ): Promise<RepositoryHealthSnapshot | undefined> {
    return this.health.get(repositoryDevguardId);
  }

  async compareAndSaveMetadata(
    expectedGeneration: number | undefined,
    snapshot: RepositoryMetadataSnapshot,
  ): Promise<SaveResult<RepositoryMetadataSnapshot>> {
    const current = this.metadata.get(snapshot.repositoryDevguardId);
    if (
      (expectedGeneration === undefined && current !== undefined) ||
      (expectedGeneration !== undefined &&
        (current === undefined || current.generation !== expectedGeneration))
    ) {
      return { ok: false, code: 'CONFLICT', current };
    }
    this.metadata.set(snapshot.repositoryDevguardId, snapshot);
    return { ok: true, saved: snapshot };
  }

  async compareAndSaveHealth(
    expectedComputedVersion: number | undefined,
    health: RepositoryHealthSnapshot,
  ): Promise<SaveResult<RepositoryHealthSnapshot>> {
    const current = this.health.get(health.repositoryDevguardId);
    if (
      (expectedComputedVersion === undefined && current !== undefined) ||
      (expectedComputedVersion !== undefined &&
        (current === undefined || current.computedVersion !== expectedComputedVersion))
    ) {
      return { ok: false, code: 'CONFLICT', current };
    }
    this.health.set(health.repositoryDevguardId, health);
    return { ok: true, saved: health };
  }

  async claimRefresh(input: {
    repositoryDevguardId: string;
    operationKey: string;
    ttlMs: number;
    nowMs: number;
  }): Promise<{ granted: boolean; refreshedAtMs: number }> {
    const key = `${input.repositoryDevguardId}:${input.operationKey}`;
    const existing = this.claims.get(key);
    if (existing !== undefined && input.nowMs - existing.refreshedAtMs < input.ttlMs) {
      return { granted: false, refreshedAtMs: existing.refreshedAtMs };
    }
    this.claims.set(key, { refreshedAtMs: input.nowMs });
    return { granted: true, refreshedAtMs: input.nowMs };
  }

  async releaseRefreshClaim(input: {
    repositoryDevguardId: string;
    operationKey: string;
  }): Promise<void> {
    this.claims.delete(`${input.repositoryDevguardId}:${input.operationKey}`);
  }
}
