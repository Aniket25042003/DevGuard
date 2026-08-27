/**
 * C023 §8/§9/§10 — version and snapshot domain objects plus the persistence
 * port. Persistence implementations (C010 repositories) satisfy the port
 * structurally; this package never imports adapter code.
 *
 * Lifecycle: DRAFT → VALIDATED → ACTIVE → SUPERSEDED; REJECTED is terminal
 * for invalid drafts. Stored versions are immutable — lifecycle metadata only.
 */
import type { CanonicalPolicyDocument } from '../schema/policy-v1.js';
import { canonicalHash, canonicalJson } from '../normalization/canonical.js';

export const POLICY_VERSION_STATUSES = [
  'DRAFT',
  'VALIDATED',
  'ACTIVE',
  'SUPERSEDED',
  'REJECTED',
] as const;

export type PolicyVersionStatus = (typeof POLICY_VERSION_STATUSES)[number];

/** C023 §9 legal transitions. */
const LEGAL_TRANSITIONS: Readonly<Record<PolicyVersionStatus, readonly PolicyVersionStatus[]>> =
  Object.freeze({
    DRAFT: ['VALIDATED', 'REJECTED'],
    VALIDATED: ['ACTIVE', 'REJECTED'],
    ACTIVE: ['SUPERSEDED'],
    SUPERSEDED: [],
    REJECTED: [],
  });

export function canTransition(from: PolicyVersionStatus, to: PolicyVersionStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface PolicyVersionRecord {
  readonly policyVersionId: string;
  readonly repositoryId: string;
  /** Monotonic per-repository version number. */
  readonly version: number;
  readonly schemaVersion: 1;
  /** Canonical JSON bytes — immutable once written. */
  readonly canonicalJson: string;
  /** sha256 over canonicalJson including schema version binding. */
  readonly hash: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly predecessorVersionId?: string | undefined;
  readonly status: PolicyVersionStatus;
  readonly activatedAt?: string | undefined;
}

export interface RegistryBindingVersions {
  /** Tool/action registry content version at snapshot time (C024). */
  readonly toolRegistryVersionId: string;
  /** Workflow registry content version (C045/C046). */
  readonly workflowRegistryVersionId: string;
  /** Validator registry content version (C029). */
  readonly validatorRegistryVersionId: string;
  /** Global safety configuration version (outside repository control). */
  readonly globalSafetyVersionId: string;
  /** Provider capability versions (GitHub app perms / TrueForge contract). */
  readonly providerCapabilityVersions: Readonly<Record<string, string>>;
}

/**
 * Run-bound snapshot: a run NEVER sees policy updates that land after it
 * starts (C023 §4.5). Hash binds everything, enabling verification later.
 */
export interface PolicySnapshot {
  readonly snapshotId: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly policyVersionId: string;
  readonly schemaVersion: 1;
  readonly canonicalJson: string;
  readonly hash: string;
  readonly bindings: RegistryBindingVersions;
  readonly boundAt: string;
}

/** Build an immutable version record from a canonical document. */
export function buildVersionRecord(input: {
  repositoryId: string;
  policy: CanonicalPolicyDocument;
  createdBy: string;
  policyVersionId: string;
  predecessorVersionId?: string | undefined;
}): PolicyVersionRecord {
  return Object.freeze({
    policyVersionId: input.policyVersionId,
    repositoryId: input.repositoryId,
    // Assigned monotonically by the store on insert; draft records carry 0.
    version: 0,
    schemaVersion: 1 as const,
    canonicalJson: canonicalJson(input.policy),
    hash: canonicalHash(input.policy),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    predecessorVersionId: input.predecessorVersionId,
    status: 'VALIDATED' as const,
  });
}

/**
 * Port implemented by the C010 persistence layer. All mutating methods take
 * explicit transaction contexts so activation stays atomic with outbox events
 * (C023 §12/§19).
 */
export interface PolicyVersionRepositoryPort {
  insertVersion(
    record: PolicyVersionRecord,
    ctx: { transaction?: unknown },
  ): Promise<{ id: string; version: number }>;

  findActiveVersion(repositoryId: string): Promise<
    | {
        policyVersionId: string;
        version: number;
        headRowVersion: number;
      }
    | undefined
  >;

  /** Atomically supersede active + activate target under expected-version CAS. */
  activate(
    input: ActivatePolicyVersionInput & { transaction?: unknown },
  ): Promise<{ activatedAt: string }>;
}

export interface ActivatePolicyVersionInput {
  readonly repositoryId: string;
  readonly policyVersionId: string;
  /** Optimistic concurrency token of the head pointer. */
  readonly expectedActiveVersionId?: string | undefined;
  readonly expectedHeadRowVersion: number;
  readonly requestedBy: string;
}
