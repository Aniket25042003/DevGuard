/**
 * C041 §10/§12 — WorkspaceManager orchestration.
 *
 * create: reserve (unique run ownership + lease) → capability gate (fail
 * closed) → resolve mutable selector to exact SHA (REF_CHANGED detection) →
 * safe checkout plan (no host checkout) → TrueForge create under a stable
 * idempotency key → verify exact HEAD/remote/tree → attest → READY. Every
 * provider call happens inside the fenced lease; every transition is a CAS
 * on row version + status + fence. There is no host execution and no fallback
 * path anywhere in this module.
 */
import { makeError, versionConflict } from '@devguard/errors';
import { randomUUID } from 'node:crypto';
import type { LoggerPort } from '@devguard/logging';
import {
  sandboxIdSchemas,
  type CapabilitySnapshotId,
  type LimitProfileId,
  type WorkspaceId,
} from '../ids.js';
import { SANDBOX_EVENT_TYPES, makeSandboxEvent, type SandboxEventType } from '../events.js';
import { redactValue } from '../redact.js';
import { requireWorkspaceCapabilities, type WorkspaceCapability } from './capability-gate.js';
import { assertFenceCurrent, isLeaseExpired, newLeaseToken, type WorkspaceFence } from './fence.js';
import {
  transitionWorkspace,
  workspaceCleanupRequired,
  type WorkspaceStatus,
  type WorkspaceTrigger,
  type WorkspaceTransitionGuards,
} from './fsm.js';
import {
  assertWorkspaceKeyShape,
  workspaceCreationKey,
  workspaceDestroyKey,
} from './idempotency.js';
import type { WorkspaceManagerPorts } from './ports.js';
import type {
  ProviderDestroyResult,
  ProviderWorkspaceCreateResult,
  ProviderWorkspaceId,
} from './ports.js';
import { assertNoHostCheckout, buildSafeCheckoutPlan, type CheckoutExecution } from './safe-git.js';
import type { SafeCheckoutPlan } from './safe-git.js';
import {
  describeSelector,
  expectedShaOf,
  parseCheckoutSelector,
  parseResolvedCheckout,
  type CheckoutSelector,
  type ResolvedCheckout,
} from './selector.js';
import {
  isWellFormedRecordId,
  type WorkspaceRecord,
  type WorkspaceTransitionPatch,
} from './state.js';
import { buildAttestation, verifyCheckout, type CheckoutObservation } from './verifier.js';

export const DESTROY_REASONS = [
  'run_complete',
  'run_cancelled',
  'run_failed',
  'lease_expired',
  'cleanup',
  'quarantine',
  'maintenance',
] as const;

export type DestroyReason = (typeof DESTROY_REASONS)[number];

export interface CreateWorkspaceInput {
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly repositoryId: string;
  readonly selector: CheckoutSelector;
  readonly limitProfileId: LimitProfileId;
  readonly nowMs: number;
}

export interface WorkspaceRef {
  readonly workspaceId: WorkspaceId;
  readonly runId: string;
  readonly sessionId?: string | undefined;
  readonly repositoryId: string;
  readonly resolvedSha?: string | undefined;
  readonly generation: number;
  readonly capabilitySnapshotId?: string | undefined;
  readonly status: WorkspaceStatus;
  readonly createdAtMs: number;
}

export interface WorkspaceStatusView {
  readonly workspaceId: WorkspaceId;
  readonly status: WorkspaceStatus;
  readonly providerWorkspaceId?: string | undefined;
  readonly resolvedSha?: string | undefined;
  readonly verifiedHeadSha?: string | undefined;
  readonly providerVersion?: string | undefined;
  readonly failureCode?: string | undefined;
  readonly leaseExpiresAtMs?: number | undefined;
  readonly readyAtMs?: number | undefined;
  readonly cleanupRequired: boolean;
}

export type DestroyOutcome = 'destroyed' | 'pending_cleanup' | 'quarantined';

export interface WorkspaceManagerOptions {
  readonly ports: WorkspaceManagerPorts;
  readonly leaseTtlMs: number;
  readonly checkoutExecution: CheckoutExecution;
  readonly now?: () => number;
}

export class WorkspaceManager {
  private readonly logger: LoggerPort | undefined;
  private readonly now: () => number;

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.logger = options.ports.logger;
    this.now = options.now ?? (() => Date.now());
  }

  async create(input: CreateWorkspaceInput): Promise<WorkspaceRef> {
    const startedAtMs = input.nowMs;
    const selector = parseCheckoutSelector(input.selector);
    this.assertBoundaryIds(input);
    const { runId, repositoryId } = input;

    // Unique run ownership: replay returns the existing reservation only when
    // the full creation request still matches that reservation's binding.
    // Reusing a run ID with different repository/selector/session/limit inputs
    // is a conflict, never a silent redirect to an existing workspace.
    const existing = await this.options.ports.store.loadByRunId(runId);
    if (existing !== undefined) {
      const mismatch = bindingMismatch(existing, input);
      if (mismatch !== undefined) {
        throw makeError('WORKSPACE_REPLAY_MISMATCH', { details: { field: mismatch } });
      }
      this.info('sandbox.workspace.replayed', { runId, status: existing.status });
      return toRef(existing);
    }

    const workspaceId = sandboxIdSchemas.workspaceId.parse(randomUUID());
    const leaseToken = newLeaseToken();
    const leaseExpiresAtMs = startedAtMs + this.options.leaseTtlMs;
    const reservation = await this.options.ports.store.reserve({
      workspaceId,
      runId,
      sessionId: input.sessionId,
      repositoryId,
      selector,
      limitProfileId: input.limitProfileId,
      generation: 1,
      leaseOwner: 'worker',
      leaseToken,
      leaseExpiresAtMs,
      createdAtMs: startedAtMs,
    });
    let record = reservation;
    const fence = fenceOf(reservation);
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.workspaceRequested,
      { type: 'workspace', id: workspaceId },
      {
        workspaceId,
        runId,
        requestedRefKind: selector.kind,
        requestedRef: describeSelector(selector),
      },
    );

    // Capability gate: fail closed on unknown/unverified claims (C041 §5/§15).
    const manifest = await this.options.ports.capabilityProbe.probe();
    const decision = requireWorkspaceCapabilities(manifest);
    if (!decision.allowed) {
      await this.markFailed(
        record,
        fence,
        decision.code,
        `capability '${decision.blockedCapability}' is ${decision.reason}`,
      );
      throw makeError(decision.code, { details: { capability: decision.blockedCapability } });
    }
    const requiredCapability: WorkspaceCapability =
      this.options.checkoutExecution === 'native' ? 'checkout.native' : 'checkout.sandboxed_git';
    if (
      !manifest.capabilities.some((claim) => claim.name === requiredCapability && claim.verified)
    ) {
      await this.markFailed(
        record,
        fence,
        'SANDBOX_CAPABILITY_UNSUPPORTED',
        `${requiredCapability} unverified`,
      );
      throw makeError('SANDBOX_CAPABILITY_UNSUPPORTED', {
        details: { capability: requiredCapability },
      });
    }

    // Resolve mutable selectors to an exact SHA BEFORE provisioning.
    let resolved: ResolvedCheckout;
    try {
      resolved = parseResolvedCheckout(
        await this.options.ports.resolver.resolve({ repositoryId, selector, nowMs: startedAtMs }),
      );
    } catch (cause) {
      await this.markFailed(record, fence, 'REF_CHANGED', 'ref resolution failed');
      throw cause;
    }
    const expected = expectedShaOf(selector);
    if (expected !== undefined && expected !== resolved.resolvedSha) {
      await this.markFailed(record, fence, 'REF_CHANGED', 'selector moved during resolution');
      throw makeError('REF_CHANGED', { details: { requestedRef: describeSelector(selector) } });
    }
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.checkoutResolved,
      { type: 'checkout', id: workspaceId },
      {
        workspaceId,
        requestedRefKind: selector.kind,
        requestedRef: describeSelector(selector),
        resolvedSha: resolved.resolvedSha,
      },
    );

    record = await this.transition(
      record,
      fence,
      'begin-provisioning',
      { capabilitiesVerified: true },
      {
        resolvedSha: resolved.resolvedSha,
        capabilitySnapshotId: decision.allowed
          ? (decision.capabilitySnapshotId as CapabilitySnapshotId)
          : undefined,
        providerVersion: decision.allowed ? decision.providerVersion : undefined,
      },
    );

    const plan = buildSafeCheckoutPlan({
      repositoryId,
      remoteFingerprint: resolved.remoteFingerprint,
      sha: resolved.resolvedSha,
      execution: this.options.checkoutExecution,
    });
    assertNoHostCheckout(plan);

    const createKey = workspaceCreationKey(runId, record.generation);
    assertWorkspaceKeyShape(createKey);
    this.info('sandbox.workspace.provisioning', {
      event: 'sandbox.workspace.provisioning',
      workflowRunId: runId,
      provider: 'trueforge',
    });
    const created = await this.providerCreate(record, fence, {
      idempotencyKey: createKey,
      limitProfileId: record.limitProfileId,
      capabilitySnapshotId: decision.allowed
        ? (decision.capabilitySnapshotId as CapabilitySnapshotId)
        : ('' as CapabilitySnapshotId),
      generation: record.generation,
      leaseToken: fence.leaseToken,
      leaseExpiresAtMs: fence.leaseExpiresAtMs,
      checkout: plan,
    });
    if (created.snapshot.status !== 'ready') {
      // Ambiguous/transient provider state is never assumed: quarantine.
      await this.transition(
        record,
        fence,
        'quarantine',
        { providerAmbiguity: true },
        {
          providerWorkspaceId: created.providerWorkspaceId,
          failureCode: 'WORKSPACE_QUARANTINED',
          failureDetailRedacted: `provider status ${created.snapshot.status}`,
        },
      );
      await this.emitEvent(
        SANDBOX_EVENT_TYPES.workspaceQuarantined,
        { type: 'workspace', id: workspaceId },
        { workspaceId, runId, reason: `provider status ${created.snapshot.status}` },
      );
      throw makeError('WORKSPACE_QUARANTINED', {
        details: { reason: `provider status ${created.snapshot.status}` },
      });
    }
    const firstObservation = observationOf(created.snapshot);
    record = await this.transition(
      record,
      fence,
      'provision-complete',
      { providerWorkspaceCreated: true },
      { providerWorkspaceId: created.providerWorkspaceId },
    );
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.workspaceCreated,
      { type: 'workspace', id: workspaceId },
      {
        workspaceId,
        runId,
        providerWorkspaceId: created.providerWorkspaceId,
        providerVersion: decision.allowed ? decision.providerVersion : '',
        capabilitySnapshotId: decision.allowed ? (decision.capabilitySnapshotId as string) : '',
      },
    );

    record = await this.transition(
      record,
      fence,
      'checkout-complete',
      { safeCheckoutApplied: firstObservation !== undefined },
      { providerWorkspaceId: created.providerWorkspaceId },
    );

    const outcome = verifyCheckout({ resolved, observation: firstObservation });
    if (!outcome.ok) {
      await this.transition(
        record,
        fence,
        'verify-fail',
        { verificationFailed: true },
        {
          verifiedHeadSha: firstObservation.observedHeadSha,
          failureCode: 'CHECKOUT_MISMATCH',
          failureDetailRedacted: `mismatch kind: ${outcome.mismatchKind}`,
        },
      );
      await this.emitEvent(
        SANDBOX_EVENT_TYPES.checkoutVerificationFailed,
        { type: 'checkout', id: workspaceId },
        {
          workspaceId,
          expectedSha: outcome.expectedSha,
          observedSha: outcome.observedSha,
          mismatchKind: outcome.mismatchKind,
        },
      );
      await this.emitEvent(
        SANDBOX_EVENT_TYPES.workspaceQuarantined,
        { type: 'workspace', id: workspaceId },
        { workspaceId, runId, reason: `checkout ${outcome.mismatchKind}` },
      );
      throw makeError('CHECKOUT_MISMATCH', {
        details: {
          expectedSha: outcome.expectedSha,
          observedSha: outcome.observedSha,
          mismatchKind: outcome.mismatchKind,
        },
      });
    }

    const attestation = buildAttestation({
      id: sandboxIdSchemas.checkoutAttestationId.parse(randomUUID()),
      workspaceId,
      resolved,
      observation: firstObservation,
      nowMs: startedAtMs,
    });
    try {
      await this.options.ports.verifier.attest(attestation);
    } catch (cause) {
      // A failed attestation persistence must never strand the workspace in
      // VERIFYING with a real provider resource present. Move it to a durable
      // FAILED (cleanup-required) state and re-throw so the caller sees the
      // failure; replay can resume cleanup/reconciliation instead of returning
      // VERIFYING indefinitely.
      this.error('sandbox.checkout.attest.failed', cause);
      await this.transition(
        record,
        fence,
        'fail',
        { failureKnown: true },
        {
          verifiedHeadSha: firstObservation.observedHeadSha,
          providerWorkspaceId: created.providerWorkspaceId,
          failureCode: 'CHECKOUT_ATTESTATION_FAILED',
          failureDetailRedacted: 'attestation persistence failed after verification',
        },
      );
      await this.emitEvent(
        SANDBOX_EVENT_TYPES.workspaceFailed,
        { type: 'workspace', id: workspaceId },
        {
          workspaceId,
          runId,
          failureCode: 'CHECKOUT_ATTESTATION_FAILED',
          failureDetailRedacted: 'attestation persistence failed after verification',
        },
      );
      throw cause;
    }
    record = await this.transition(
      record,
      fence,
      'verify-ok',
      {
        headMatchesResolvedSha: true,
        remoteIdentityVerified: true,
        // Only the success path reaches here (the failure path re-throws above),
        // so attestation persistence is complete by construction.
        attestationComplete: true,
      },
      {
        verifiedHeadSha: firstObservation.observedHeadSha,
        providerWorkspaceId: created.providerWorkspaceId,
        readyAtMs: startedAtMs,
      },
    );
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.checkoutCompleted,
      { type: 'checkout', id: workspaceId },
      {
        workspaceId,
        resolvedSha: resolved.resolvedSha,
        observedHeadSha: firstObservation.observedHeadSha,
        remoteFingerprint: resolved.remoteFingerprint,
        treeHash: firstObservation.treeHash,
      },
    );
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.workspaceReady,
      { type: 'workspace', id: workspaceId },
      {
        workspaceId,
        runId,
        resolvedSha: resolved.resolvedSha,
        verifiedHeadSha: firstObservation.observedHeadSha,
        capabilitySnapshotId: decision.allowed ? decision.capabilitySnapshotId : '',
      },
    );
    this.info('sandbox.workspace.ready', {
      workflowRunId: runId,
      status: 'ready',
      durationMs: this.now() - startedAtMs,
    });
    return toRef(record);
  }

  async inspect(workspaceId: WorkspaceId): Promise<WorkspaceStatusView> {
    const record = await this.options.ports.store.load(workspaceId);
    return toStatusView(record);
  }

  async renewLease(workspaceId: WorkspaceId, fence: WorkspaceFence): Promise<WorkspaceFence> {
    const record = await this.options.ports.store.load(workspaceId);
    this.assertCurrent(record, fence);
    const newToken = newLeaseToken();
    const expiresAt = this.now() + this.options.leaseTtlMs;
    const result = await this.options.ports.store.renewLease({
      workspaceId,
      expectedLeaseToken: fence.leaseToken,
      newLeaseToken: newToken,
      leaseExpiresAtMs: expiresAt,
      rowVersion: record.rowVersion,
    });
    if (!result.applied) {
      throw makeError('WORKSPACE_FENCE_REJECTED', {
        details: { reason: 'lease renewal lost a CAS race' },
      });
    }
    return {
      workspaceId,
      runId: record.runId,
      generation: record.generation,
      leaseToken: newToken,
      leaseExpiresAtMs: expiresAt,
    };
  }

  async requestDestroy(
    workspaceId: WorkspaceId,
    reason: DestroyReason,
    fence: WorkspaceFence,
  ): Promise<DestroyOutcome> {
    if (!(DESTROY_REASONS as readonly string[]).includes(reason)) {
      throw makeError('VALIDATION_FAILED', {
        details: [{ path: 'reason', constraint: 'unknown destroy reason' }],
      });
    }
    let record = await this.options.ports.store.load(workspaceId);
    if (record.status === 'DESTROYED') return 'destroyed';
    this.assertCurrent(record, fence);

    if (record.status !== 'DESTROYING') {
      record = await this.transition(
        record,
        fence,
        'begin-destroy',
        {},
        { destroyedAtMs: this.now() },
      );
    }
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.workspaceDestroyRequested,
      { type: 'workspace', id: workspaceId },
      {
        workspaceId,
        runId: record.runId,
        generation: record.generation,
        reason,
      },
    );

    const providerWorkspaceId = record.providerWorkspaceId;
    if (providerWorkspaceId === undefined) {
      // Never provisioned: destruction is provable by constraint, not by guess.
      await this.transition(
        record,
        fence,
        'destroy-confirmed',
        { providerProvesDestroyed: true },
        { destroyedAtMs: this.now() },
      );
      return 'destroyed';
    }

    const destroyKey = workspaceDestroyKey(workspaceId, record.generation);
    assertWorkspaceKeyShape(destroyKey);
    const result = await this.providerDestroy(record, fence, {
      providerWorkspaceId,
      idempotencyKey: destroyKey,
      generation: record.generation,
      leaseToken: fence.leaseToken,
      leaseExpiresAtMs: fence.leaseExpiresAtMs,
    });
    if (result.destroyed === true) {
      await this.transition(
        record,
        fence,
        'destroy-confirmed',
        { providerProvesDestroyed: true },
        { destroyedAtMs: this.now() },
      );
      return 'destroyed';
    }
    // Uncertain destruction: quarantine, never claim cleaned (C041 §18).
    record = await this.transition(
      record,
      fence,
      'destroy-uncertain',
      { providerProvesDestroyed: false, cleanupAttemptsExhausted: true },
      {
        failureCode: 'WORKSPACE_QUARANTINED',
        failureDetailRedacted: 'provider could not prove destruction',
      },
    );
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.workspaceQuarantined,
      { type: 'workspace', id: workspaceId },
      { workspaceId, runId: record.runId, reason: 'destruction unproven' },
    );
    return 'quarantined';
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private assertBoundaryIds(input: CreateWorkspaceInput): void {
    const bad: Array<{ path: string; constraint: string }> = [];
    if (!isWellFormedRecordId(input.runId))
      bad.push({ path: 'runId', constraint: 'expected UUID v1-v8 or ULID' });
    if (!isWellFormedRecordId(input.repositoryId))
      bad.push({ path: 'repositoryId', constraint: 'expected UUID v1-v8 or ULID' });
    if (input.sessionId !== undefined && !isWellFormedRecordId(input.sessionId)) {
      bad.push({ path: 'sessionId', constraint: 'expected UUID v1-v8 or ULID' });
    }
    if (bad.length > 0) {
      throw makeError('VALIDATION_FAILED', { details: bad });
    }
  }

  private assertCurrent(record: WorkspaceRecord, fence: WorkspaceFence): void {
    assertFenceCurrent(
      {
        workspaceId: record.workspaceId,
        runId: record.runId,
        generation: record.generation,
        leaseToken: record.leaseToken ?? '',
        leaseExpiresAtMs: record.leaseExpiresAtMs ?? 0,
      },
      fence,
      this.now(),
    );
  }

  private async transition(
    record: WorkspaceRecord,
    fence: WorkspaceFence,
    trigger: WorkspaceTrigger,
    guards: WorkspaceTransitionGuards,
    patch: WorkspaceTransitionPatch,
  ): Promise<WorkspaceRecord> {
    this.assertCurrent(record, fence);
    const to = transitionWorkspace(record.status, trigger, { ...guards, fenceValid: true });
    const result = await this.options.ports.store.tryTransition({
      workspaceId: record.workspaceId,
      expectedRowVersion: record.rowVersion,
      expectedStatus: record.status,
      to,
      trigger,
      patch,
    });
    if (!result.applied) {
      throw versionConflict(record.rowVersion, result.record.rowVersion);
    }
    return result.record;
  }

  private async markFailed(
    record: WorkspaceRecord,
    fence: WorkspaceFence,
    failureCode: string,
    detail: string,
  ): Promise<void> {
    try {
      const failed = await this.transition(
        record,
        fence,
        'fail',
        { failureKnown: true },
        { failureCode, failureDetailRedacted: detail },
      );
      await this.emitEvent(
        SANDBOX_EVENT_TYPES.workspaceFailed,
        { type: 'workspace', id: record.workspaceId },
        {
          workspaceId: record.workspaceId,
          runId: record.runId,
          failureCode,
          failureDetailRedacted: detail,
        },
      );
      this.info('sandbox.workspace.failed', {
        workflowRunId: record.runId,
        status: failed.status,
      });
    } catch (cause) {
      // Failure bookkeeping must never mask the original failure.
      this.error('sandbox.workspace.failed.bookkeeping', cause);
    }
  }

  private async emitEvent(
    type: SandboxEventType,
    aggregate: { type: 'workspace' | 'checkout'; id: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope = makeSandboxEvent({
      type,
      aggregate,
      occurredAt: new Date(this.now()).toISOString(),
      actor: { kind: 'system', id: 'sandbox' },
      payload,
    });
    try {
      await this.options.ports.events.emit(envelope);
    } catch (cause) {
      // Event publication is best-effort after the durable CAS transition has
      // already committed. A sink/outbox failure must never abort orchestration
      // mid-lifecycle (that would strand the workspace in a partially
      // progressed state that create() then returns instead of resuming). Log
      // and continue; durable reconciliation of delivery is the outbox's job.
      this.error('sandbox.event.publish.failed', { type, error: cause });
    }
  }

  /**
   * C041 §19/§25 — run provider.create under the current fence and recheck
   * ownership after the long-running call. A rejection/timeout after the
   * request may have reached the provider is an ambiguous side effect: it is
   * never represented as a known failure — the reservation is quarantined
   * (cleanup-required) and reconciled on replay, never left in PROVISIONING.
   */
  private async providerCreate(
    record: WorkspaceRecord,
    fence: WorkspaceFence,
    input: {
      readonly idempotencyKey: string;
      readonly limitProfileId: LimitProfileId;
      readonly capabilitySnapshotId: CapabilitySnapshotId;
      readonly generation: number;
      readonly leaseToken: string;
      readonly leaseExpiresAtMs: number;
      readonly checkout: SafeCheckoutPlan;
    },
  ): Promise<ProviderWorkspaceCreateResult> {
    this.assertCurrent(record, fence);
    let result: ProviderWorkspaceCreateResult;
    try {
      result = await this.options.ports.provider.create(input);
    } catch (cause) {
      // The create may or may not have reached the provider. Do not assume a
      // known failure: move to QUARANTINED so deterministic replay reconciles
      // provider state instead of returning a stuck PROVISIONING reservation.
      await this.markAmbiguous(
        record,
        fence,
        'provider create outcome ambiguous (rejection/timeout)',
      );
      throw cause;
    }
    // Recheck ownership after the long-running call before accepting the
    // outcome: if the lease expired or was superseded meanwhile, a stale
    // worker must not advance the lifecycle off the provider's side effect.
    this.assertCurrent(record, fence);
    return result;
  }

  /**
   * C041 §19/§25 — run provider.destroy under the current fence and recheck
   * ownership after the long-running call before accepting the outcome.
   */
  private async providerDestroy(
    record: WorkspaceRecord,
    fence: WorkspaceFence,
    input: {
      readonly providerWorkspaceId: ProviderWorkspaceId;
      readonly idempotencyKey: string;
      readonly generation: number;
      readonly leaseToken: string;
      readonly leaseExpiresAtMs: number;
    },
  ): Promise<ProviderDestroyResult> {
    this.assertCurrent(record, fence);
    const result = await this.options.ports.provider.destroy(input);
    this.assertCurrent(record, fence);
    return result;
  }

  /** Quarantine a workspace whose provider outcome is ambiguous (cleanup-required). */
  private async markAmbiguous(
    record: WorkspaceRecord,
    fence: WorkspaceFence,
    detail: string,
  ): Promise<WorkspaceRecord> {
    const quarantined = await this.transition(
      record,
      fence,
      'quarantine',
      { providerAmbiguity: true },
      {
        failureCode: 'WORKSPACE_QUARANTINED',
        failureDetailRedacted: detail,
      },
    );
    await this.emitEvent(
      SANDBOX_EVENT_TYPES.workspaceQuarantined,
      { type: 'workspace', id: record.workspaceId },
      { workspaceId: record.workspaceId, runId: record.runId, reason: detail },
    );
    return quarantined;
  }

  private info(event: string, fields: Record<string, unknown>): void {
    this.logger?.info(event, redactValue(fields) as Parameters<LoggerPort['info']>[1]);
  }

  private error(event: string, error: unknown): void {
    this.logger?.error(event, error);
  }
}

function fenceOf(record: WorkspaceRecord): WorkspaceFence {
  return {
    workspaceId: record.workspaceId,
    runId: record.runId,
    generation: record.generation,
    leaseToken: record.leaseToken ?? '',
    leaseExpiresAtMs: record.leaseExpiresAtMs ?? 0,
  };
}

/**
 * A request replay for an already-reserved run is only idempotent when every
 * binding field matches the original. Selector comparison is canonical-shape
 * (both stored/parsed through `parseCheckoutSelector`), so equal requests
 * replay while diverging requests fail closed with a named field.
 */
function bindingMismatch(
  existing: WorkspaceRecord,
  input: CreateWorkspaceInput,
): string | undefined {
  if (existing.repositoryId !== input.repositoryId) return 'repositoryId';
  if (existing.limitProfileId !== input.limitProfileId) return 'limitProfileId';
  if ((existing.sessionId ?? null) !== (input.sessionId ?? null)) return 'sessionId';
  if (JSON.stringify(existing.selector) !== JSON.stringify(input.selector)) return 'selector';
  return undefined;
}

function toRef(record: WorkspaceRecord): WorkspaceRef {
  return {
    workspaceId: record.workspaceId,
    runId: record.runId,
    sessionId: record.sessionId,
    repositoryId: record.repositoryId,
    resolvedSha: record.resolvedSha,
    generation: record.generation,
    capabilitySnapshotId: record.capabilitySnapshotId,
    status: record.status,
    createdAtMs: record.createdAtMs,
  };
}

function toStatusView(record: WorkspaceRecord): WorkspaceStatusView {
  return {
    workspaceId: record.workspaceId,
    status: record.status,
    providerWorkspaceId: record.providerWorkspaceId,
    resolvedSha: record.resolvedSha,
    verifiedHeadSha: record.verifiedHeadSha,
    providerVersion: record.providerVersion,
    failureCode: record.failureCode,
    leaseExpiresAtMs: record.leaseExpiresAtMs,
    readyAtMs: record.readyAtMs,
    cleanupRequired: workspaceCleanupRequired(record.status),
  };
}

function observationOf(snapshot: {
  readonly observedHeadSha?: string | undefined;
  readonly observedRemoteFingerprint?: string | undefined;
  readonly treeHash?: string | undefined;
}): CheckoutObservation {
  return {
    observedHeadSha: snapshot.observedHeadSha ?? '',
    observedRemoteFingerprint: snapshot.observedRemoteFingerprint ?? '',
    treeHash: snapshot.treeHash,
  };
}

export { isLeaseExpired };
