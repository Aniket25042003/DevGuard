/**
 * C041 §6/§10/§13 — provider-neutral ports for the workspace domain.
 *
 * The composition root (apps) implements these with the TrueForge adapter
 * (C036), the GitHub read adapter (C017–C020), the persistence layer
 * (C008/C011) and the outbox. Provider SDK types and SQL row shapes never
 * cross this boundary; observations arrive as validated DevGuard snapshots.
 */
import type { EventEnvelopeShape } from '@devguard/contracts';
import type { LoggerPort } from '@devguard/logging';
import type { ProviderCapabilityManifest } from './capability-gate.js';
import type { WorkspaceFence } from './fence.js';
import type { WorkspaceTrigger } from './fsm.js';
import type { SafeCheckoutPlan } from './safe-git.js';
import type { CheckoutSelector, ResolvedCheckout } from './selector.js';
import type {
  WorkspaceLeaseRenewal,
  WorkspaceRecord,
  WorkspaceReservation,
  WorkspaceTransitionInput,
  WorkspaceTransitionResult,
} from './state.js';
import type { CheckoutAttestation } from './verifier.js';
import type {
  CapabilitySnapshotId,
  LimitProfileId,
  ProviderWorkspaceId,
  WorkspaceId,
} from '../ids.js';

/** Resolves mutable selectors to an exact GitHub-owned SHA (C017–C020). */
export interface RefResolverPort {
  resolve(input: {
    readonly repositoryId: string;
    readonly selector: CheckoutSelector;
    readonly nowMs: number;
  }): Promise<ResolvedCheckout>;
}

/** Probes the pinned TrueForge adapter's provider/version/capability evidence. */
export interface CapabilityProbePort {
  probe(): Promise<ProviderCapabilityManifest>;
}

/** Provider-neutral observation of a TrueForge workspace (no paths/credentials). */
export interface ProviderWorkspaceSnapshot {
  readonly providerWorkspaceId: ProviderWorkspaceId;
  readonly status: 'creating' | 'ready' | 'degraded' | 'destroyed' | 'unknown';
  readonly observedHeadSha?: string | undefined;
  readonly observedRemoteFingerprint?: string | undefined;
  readonly treeHash?: string | undefined;
}

export interface ProviderWorkspaceCreateResult {
  readonly providerWorkspaceId: ProviderWorkspaceId;
  /** False when the idempotency key resolved to an existing workspace. */
  readonly created: boolean;
  readonly snapshot: ProviderWorkspaceSnapshot;
}

export interface ProviderDestroyResult {
  readonly destroyed: boolean;
  readonly snapshot: ProviderWorkspaceSnapshot;
}

/**
 * TrueForge workspace lifecycle (C036 verified adapter). Every call carries
 * the stable idempotency key and generation fence; ambiguous outcomes are
 * surfaced as `status: 'unknown'`, never assumed.
 */
export interface TrueForgeWorkspacePort {
  create(input: {
    readonly idempotencyKey: string;
    readonly limitProfileId: LimitProfileId;
    readonly capabilitySnapshotId: CapabilitySnapshotId;
    readonly generation: number;
    readonly checkout: SafeCheckoutPlan;
  }): Promise<ProviderWorkspaceCreateResult>;
  inspect(input: {
    readonly providerWorkspaceId: ProviderWorkspaceId;
    readonly idempotencyKey: string;
  }): Promise<ProviderWorkspaceSnapshot>;
  destroy(input: {
    readonly providerWorkspaceId: ProviderWorkspaceId;
    readonly idempotencyKey: string;
  }): Promise<ProviderDestroyResult>;
}

/** Persists checkout attestations produced by the READY gate. */
export interface CheckoutVerifierPort {
  attest(input: CheckoutAttestation): Promise<CheckoutAttestation>;
}

/** CAS workspace persistence (unique run ownership, row versions, leases). */
export interface WorkspaceStorePort {
  load(workspaceId: WorkspaceId): Promise<WorkspaceRecord>;
  loadByRunId(runId: string): Promise<WorkspaceRecord | undefined>;
  reserve(input: WorkspaceReservation): Promise<WorkspaceRecord>;
  tryTransition(input: WorkspaceTransitionInput): Promise<WorkspaceTransitionResult>;
  renewLease(input: WorkspaceLeaseRenewal): Promise<WorkspaceTransitionResult>;
}

/** Outbox-style event sink; envelopes are validated before this port. */
export interface SandboxEventPort {
  emit(envelope: EventEnvelopeShape): Promise<void>;
}

export interface WorkspaceManagerPorts {
  readonly resolver: RefResolverPort;
  readonly capabilityProbe: CapabilityProbePort;
  readonly provider: TrueForgeWorkspacePort;
  readonly verifier: CheckoutVerifierPort;
  readonly store: WorkspaceStorePort;
  readonly events: SandboxEventPort;
  readonly logger?: LoggerPort | undefined;
}

/** Fencing context reused across manager methods. */
export interface CurrentFence extends WorkspaceFence {
  readonly rowVersion: number;
}

export type { WorkspaceTrigger };
export type {
  WorkspaceRecord,
  WorkspaceReservation,
  WorkspaceTransitionInput,
  WorkspaceTransitionResult,
  WorkspaceLeaseRenewal,
};
export type { CapabilitySnapshotId, LimitProfileId, ProviderWorkspaceId, WorkspaceId };
