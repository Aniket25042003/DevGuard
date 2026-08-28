/**
 * C041 §8/§13 — durable workspace aggregate record (application-layer shape).
 *
 * The persistence implementation (C008/C011 layer in apps) owns the physical
 * table; this shape is the provider-neutral aggregate the manager and jobs
 * operate on. `resolvedSha`/`verifiedHeadSha` are exact immutable object IDs;
 * provider handles stay opaque; no host filesystem path is ever a field.
 */
import type {
  CapabilitySnapshotId,
  LimitProfileId,
  ProviderWorkspaceId,
  WorkspaceId,
} from '../ids.js';
import type { CheckoutSelector } from './selector.js';
import type { WorkspaceStatus, WorkspaceTrigger } from './fsm.js';

export const WELL_FORMED_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/;

/** Boundary check for run/session/repository ids entering the manager. */
export function isWellFormedRecordId(value: string): boolean {
  return WELL_FORMED_ID_PATTERN.test(value);
}

export interface WorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly repositoryId: string;
  readonly selector: CheckoutSelector;
  readonly requestedRefKind: string;
  readonly requestedRef: string;
  readonly resolvedSha?: string | undefined;
  readonly verifiedHeadSha?: string | undefined;
  readonly providerWorkspaceId?: ProviderWorkspaceId | undefined;
  readonly providerVersion?: string | undefined;
  readonly capabilitySnapshotId?: CapabilitySnapshotId | undefined;
  readonly limitProfileId: LimitProfileId;
  readonly status: WorkspaceStatus;
  readonly generation: number;
  readonly leaseOwner?: string | undefined;
  readonly leaseToken?: string | undefined;
  readonly leaseExpiresAtMs?: number | undefined;
  readonly rowVersion: number;
  readonly createdAtMs: number;
  readonly readyAtMs?: number | undefined;
  readonly destroyedAtMs?: number | undefined;
  readonly failureCode?: string | undefined;
  readonly failureDetailRedacted?: string | undefined;
}

/** Fields a transition may carry; everything else is carried by the CAS row. */
export interface WorkspaceTransitionPatch {
  readonly resolvedSha?: string | undefined;
  readonly verifiedHeadSha?: string | undefined;
  readonly providerWorkspaceId?: ProviderWorkspaceId | undefined;
  readonly providerVersion?: string | undefined;
  readonly capabilitySnapshotId?: CapabilitySnapshotId | undefined;
  readonly readyAtMs?: number | undefined;
  readonly destroyedAtMs?: number | undefined;
  readonly failureCode?: string | undefined;
  readonly failureDetailRedacted?: string | undefined;
  readonly leaseOwner?: string | undefined;
  readonly leaseToken?: string | undefined;
  readonly leaseExpiresAtMs?: number | undefined;
}

export interface WorkspaceReservation {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly repositoryId: string;
  readonly selector: CheckoutSelector;
  readonly limitProfileId: LimitProfileId;
  readonly generation: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly createdAtMs: number;
}

export interface WorkspaceTransitionInput {
  readonly workspaceId: WorkspaceId;
  readonly expectedRowVersion: number;
  readonly expectedStatus: WorkspaceStatus;
  readonly to: WorkspaceStatus;
  readonly trigger: WorkspaceTrigger;
  readonly patch: WorkspaceTransitionPatch;
}

export interface WorkspaceTransitionResult {
  readonly applied: boolean;
  readonly record: WorkspaceRecord;
}

export interface WorkspaceLeaseRenewal {
  readonly workspaceId: WorkspaceId;
  readonly expectedLeaseToken: string;
  readonly newLeaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly rowVersion: number;
}
