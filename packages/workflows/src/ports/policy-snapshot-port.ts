/**
 * C045 §8/§23.6 — repository policy snapshot port (C023 integration point).
 *
 * Repository policy is durable runtime state, NEVER embedded in definitions
 * or skills (C045 §2). C046 binds the snapshot to a run at creation; C045
 * only declares the provider-neutral type and lookup contract so the
 * composition root can wire C023 in without crossing package boundaries.
 */
import type { RepositoryId } from '@devguard/contracts';

export interface RepositoryPolicySnapshot {
  /** C023 policy version identity (branded by contracts). */
  readonly policyVersionId: string;
  /** Content digest of the normalized policy. */
  readonly digest: string;
  /** Opaque durable snapshot reference (persisted by C023/C046). */
  readonly snapshotRef: string;
}

/** Resolves the CURRENT policy snapshot for a repository (never the prompt). */
export interface PolicySnapshotPort {
  getForRepository(repositoryId: RepositoryId): Promise<RepositoryPolicySnapshot>;
}

export type { RepositoryId };
