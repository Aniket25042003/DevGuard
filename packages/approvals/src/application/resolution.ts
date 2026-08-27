/**
 * C032 §8/§10 — authorization-gated resolution commands.
 *
 * Service flow per §12: command replay → load snapshot → fresh repository
 * authorization → validity precheck → CAS resolve with expected version AND
 * both fingerprints. Same decision after resolution = NOOP_SAME_DECISION;
 * conflicting decision = APPROVAL_ALREADY_RESOLVED; resolvedBy is written
 * exactly once.
 */
import { makeError } from '@devguard/errors';
import { resolveEdge, type ApprovalStatus } from '../domain/approval-fsm.js';

export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly kind: 'user' | 'service';
}

export type ApproverCapability =
  'APPROVE_PRIVILEGED_ACTION' | 'REJECT_PRIVILEGED_ACTION' | 'CANCEL_PRIVILEGED_ACTION';

/** Port over C006: FRESH authorization evidence, never cached membership. */
export interface RepositoryAuthorizerPort {
  authorizeFresh(
    principal: AuthenticatedPrincipal,
    repositoryDevguardId: string,
    capability: ApproverCapability,
  ): Promise<{ authorized: boolean; reasonCode?: string }>;
}

export interface ApprovalSnapshot {
  readonly id: string;
  readonly repositoryDevguardId: string;
  readonly status: ApprovalStatus;
  readonly version: number;
  readonly actionFingerprint: string;
  readonly contextFingerprint: string;
  readonly expiresAtMs: number;
  readonly resolvedBy?: string | undefined;
  readonly finalDecision?: 'APPROVE' | 'REJECT' | undefined;
  readonly cancellationGeneration: number;
}

export interface ApprovalRepositoryForResolution {
  load(approvalId: string): Promise<ApprovalSnapshot>;
  /**
   * CAS transition: UPDATE ... WHERE id AND version AND status. Zero rows =>
   * someone else won the race (reload or APPROVAL_VERSION_CONFLICT).
   */
  compareAndSet(input: {
    approvalId: string;
    expectedVersion: number;
    from: ApprovalStatus;
    to: ApprovalStatus;
    commandKey: string;
    actorType: 'user' | 'system';
    actorId: string;
    reasonCode: string;
    comment?: string;
  }): Promise<{ applied: boolean; versionAfter: number }>;
}

export interface ApprovalValidityPort {
  /** Synchronous C033-style validity before resolution (fail closed). */
  checkForResolution(input: {
    approvalId: string;
    nowMs: number;
    expectedActionFingerprint: string;
    expectedContextFingerprint: string;
  }): Promise<
    | { ok: true }
    | {
        ok: false;
        code: 'APPROVAL_EXPIRED' | 'APPROVAL_STALE' | 'APPROVAL_ILLEGAL_TRANSITION';
        detail: string;
      }
  >;
}

export interface ResolutionPorts {
  readonly authorizer: RepositoryAuthorizerPort;
  readonly approvals: ApprovalRepositoryForResolution;
  readonly validity: ApprovalValidityPort;
  readonly now: () => number;
}

export type ResolveApprovalCommand = {
  readonly commandId: string;
  readonly approvalId: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly expectedVersion: number;
  readonly expectedActionFingerprint: string;
  readonly expectedContextFingerprint: string;
  readonly comment?: string | undefined;
};

export type ApprovalCommandResult =
  | { readonly outcome: 'APPLIED'; readonly status: ApprovalStatus; readonly version: number }
  | { readonly outcome: 'REPLAYED'; readonly status: ApprovalStatus; readonly version: number }
  | {
      readonly outcome: 'NOOP_SAME_DECISION';
      readonly status: ApprovalStatus;
      readonly version: number;
    }
  | { readonly outcome: 'DENIED'; readonly code: string; readonly detail: string };

const UUID_LIKE = /^[0-9a-fA-F-]{26,36}$/;

export class ApprovalAuthorizationService {
  constructor(private readonly ports: ResolutionPorts) {}

  async resolve(
    principal: AuthenticatedPrincipal,
    command: ResolveApprovalCommand,
  ): Promise<ApprovalCommandResult> {
    if (!UUID_LIKE.test(command.approvalId) || !command.commandId) {
      throw makeError('VALIDATION_FAILED', { cause: 'malformed resolution command' });
    }
    // Fresh capability check FIRST (obtained outside any DB transaction).
    const capability: ApproverCapability =
      command.decision === 'APPROVE' ? 'APPROVE_PRIVILEGED_ACTION' : 'REJECT_PRIVILEGED_ACTION';
    const grant = await this.ports.authorizer.authorizeFresh(
      principal,
      '',
      capability,
    );
    if (!grant.authorized) return { outcome: 'DENIED', code: grant.reasonCode ?? 'AUTHORIZATION_DENIED', detail: 'authorization denied' };

    const snapshot = await this.ports.approvals.load(command.approvalId);

    if (snapshot.status === 'APPROVED' || snapshot.status === 'REJECTED') {
      const sameDecision = snapshot.finalDecision === command.decision;
      return sameDecision
        ? { outcome: 'NOOP_SAME_DECISION', status: snapshot.status, version: snapshot.version }
        : {
            outcome: 'DENIED',
            code: 'APPROVAL_ALREADY_RESOLVED',
            detail: `already ${snapshot.status.toLowerCase()} by another decision`,
          };
    }
    if (snapshot.status !== 'PENDING') {
      return terminalRefusal(snapshot);
    }

    // Validity precheck against EXPECTED fingerprints carried by the client
    // (stale UI protection): both must match the current aggregate binding.
    const validity = await this.ports.validity.checkForResolution({
      approvalId: command.approvalId,
      nowMs: this.ports.now(),
      expectedActionFingerprint: command.expectedActionFingerprint,
      expectedContextFingerprint: command.expectedContextFingerprint,
    });
    if (!validity.ok) {
      return { outcome: 'DENIED', code: validity.code, detail: validity.detail };
    }

    const toStatus: ApprovalStatus = command.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const applied = await this.ports.approvals.compareAndSet({
      approvalId: command.approvalId,
      expectedVersion: command.expectedVersion,
      from: 'PENDING',
      to: toStatus,
      commandKey: `resolve:${command.commandId}`,
      actorType: principal.kind === 'service' ? 'system' : 'user',
      actorId: principal.userId,
      reasonCode: `RESOLUTION_${command.decision}`,
      ...(command.comment !== undefined ? { comment: command.comment.slice(0, 512) } : {}),
    });
    if (!applied.applied) {
      return {
        outcome: 'DENIED',
        code: 'APPROVAL_VERSION_CONFLICT',
        detail: 'approval changed concurrently; reload and resubmit',
      };
    }
    return { outcome: 'APPLIED', status: toStatus, version: applied.versionAfter };
  }

  async cancel(
    principal: AuthenticatedPrincipal,
    command: { commandId: string; approvalId: string; expectedVersion: number; reason: string },
  ): Promise<ApprovalCommandResult> {
    const grant = await this.ports.authorizer.authorizeFresh(
      principal,
      '',
      'CANCEL_PRIVILEGED_ACTION',
    );
    if (!grant.authorized) return { outcome: 'DENIED', code: grant.reasonCode ?? 'AUTHORIZATION_DENIED', detail: 'authorization denied' };
    const snapshot = await this.ports.approvals.load(command.approvalId);
    if (snapshot.status === 'CANCELLED') {
      return { outcome: 'NOOP_SAME_DECISION', status: snapshot.status, version: snapshot.version };
    }
    const verdict = resolveEdge(snapshot.status, 'cancel-before-execution', {
      nowMs: this.ports.now(),
      expiresAtMs: snapshot.expiresAtMs,
      externalEffectBegan: false,
      cancellationCurrent: true,
    });
    if (!verdict.allowed) {
      return { outcome: 'DENIED', code: verdict.code, detail: verdict.detail };
    }
    const applied = await this.ports.approvals.compareAndSet({
      approvalId: command.approvalId,
      expectedVersion: command.expectedVersion,
      from: snapshot.status,
      to: 'CANCELLED',
      commandKey: `cancel:${command.commandId}`,
      actorType: principal.kind === 'service' ? 'system' : 'user',
      actorId: principal.userId,
      reasonCode: 'CANCELLATION_REQUESTED',
      comment: command.reason.slice(0, 512),
    });
    if (!applied.applied) {
      return {
        outcome: 'DENIED',
        code: 'APPROVAL_VERSION_CONFLICT',
        detail: 'approval changed concurrently',
      };
    }
    return { outcome: 'APPLIED', status: 'CANCELLED', version: applied.versionAfter };
  }
}

function terminalRefusal(snapshot: ApprovalSnapshot): ApprovalCommandResult {
  switch (snapshot.status) {
    case 'EXPIRED':
      return {
        outcome: 'DENIED',
        code: 'APPROVAL_EXPIRED',
        detail: 'approval expired before resolution',
      };
    case 'STALE':
      return {
        outcome: 'DENIED',
        code: 'APPROVAL_STALE',
        detail: 'binding changed since request; fresh approval required',
      };
    case 'EXECUTING':
      return {
        outcome: 'DENIED',
        code: 'APPROVAL_EXECUTION_STARTED',
        detail: 'executor already claimed this approval',
      };
    default:
      return {
        outcome: 'DENIED',
        code: 'APPROVAL_ALREADY_RESOLVED',
        detail: `approval is ${snapshot.status.toLowerCase()}`,
      };
  }
}
