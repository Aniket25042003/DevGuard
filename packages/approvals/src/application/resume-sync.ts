/**
 * C035 §2/§5/§8 — approval↔checkpoint synchronization coordinator.
 *
 * DevGuard owns the decision; TrueForge merely PAUSES. This coordinator
 * translates durable approval states into runtime intents, dispatches C034
 * before resuming any privileged side effect, and reconciles after crashes.
 * Every intent is idempotent by operation key; duplicate or out-of-order
 * messages converge to COMPLETED without side effects (§4).
 */
import type { ApprovalStatus } from '../domain/approval-fsm.js';

export const RESUME_INTENT_KINDS = [
  'CONTINUE_APPROVED',
  'CLOSE_REJECTED',
  'CLOSE_STALE',
  'CLOSE_EXPIRED',
  'CLOSE_CANCELLED',
  'REPORT_EXECUTION_RESULT',
] as const;

export type ResumeIntentKind = (typeof RESUME_INTENT_KINDS)[number];

export const RESUME_INTENT_STATES = [
  'PENDING',
  'CLAIMED',
  'EXECUTING_ACTION',
  'RUNTIME_RESUMING',
  'RECONCILING',
  'COMPLETED',
  'FAILED',
  'HUMAN_INTERVENTION',
] as const;

export type ResumeIntentState = (typeof RESUME_INTENT_STATES)[number];

export interface RuntimeLink {
  readonly linkId: string;
  readonly approvalId: string;
  readonly provider: 'trueforge';
  /** Provider checkpoint token digest/reference — never a bearer of authority. */
  readonly checkpointTokenDigest: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly observedSequence: number;
  readonly syncState: ResumeIntentState;
}

/** Terminal approval status → closure intent mapping is total and explicit. */
export function intentForStatus(status: ApprovalStatus): ResumeIntentKind | undefined {
  switch (status) {
    case 'APPROVED':
      return 'CONTINUE_APPROVED';
    case 'REJECTED':
      return 'CLOSE_REJECTED';
    case 'STALE':
      return 'CLOSE_STALE';
    case 'EXPIRED':
      return 'CLOSE_EXPIRED';
    case 'CANCELLED':
      return 'CLOSE_CANCELLED';
    case 'EXECUTED':
    case 'EXECUTION_FAILED':
      return 'REPORT_EXECUTION_RESULT';
    default:
      return undefined; // PENDING/EXECUTING decide nothing here yet
  }
}

export interface ResumeDispatchPort {
  loadLink(approvalId: string): Promise<RuntimeLink | undefined>;
  createOrGetIntent(input: {
    approvalId: string;
    kind: ResumeIntentKind;
    generation: number;
    operationKey: string;
  }): Promise<{ intentId: string; alreadyExisted: boolean }>;
  transitionIntent(input: {
    intentId: string;
    from: ResumeIntentState;
    to: ResumeIntentState;
  }): Promise<{ applied: boolean }>;
  /** Delivers CONTINUE to TrueForge via AgentRuntime-equivalent port. */
  resumeCheckpoint(input: {
    sessionId: string;
    turnId: string;
    checkpointTokenDigest: string;
    executionEvidenceDigest?: string | undefined;
  }): Promise<{ resumed: boolean; detail?: string }>;
  deliverClosure(input: {
    sessionId: string;
    turnId: string;
    reasonCode: ResumeIntentKind;
  }): Promise<void>;
}

export class ApprovalResumeCoordinator {
  constructor(private readonly dispatch: ResumeDispatchPort) {}

  /**
   * React to a durable approval state change. Idempotent: replays return the
   * existing intent. CONTINUE_APPROVED intentionally does NOT execute the
   * action itself — it signals runtime continuation AFTER C034 verified/executed
   * the privileged effect (dispatch happens through the execution service).
   */
  async onApprovalStateChanged(input: {
    approvalId: string;
    status: ApprovalStatus;
    version: number;
    operationKey: string;
    cancellationGeneration: number;
    executionEvidenceDigest?: string | undefined;
  }): Promise<{ intentId: string; kind: ResumeIntentKind; state: ResumeIntentState }> {
    const link = await this.dispatch.loadLink(input.approvalId);
    if (!link) {
      // No runtime link (approval created outside a paused session): nothing
      // to synchronize; intents only exist for checkpoint-correlated work.
      throw new Error(`no runtime link for approval '${input.approvalId}'`);
    }
    const kind = intentForStatus(input.status);
    if (!kind) {
      // PENDING / EXECUTING carry no terminal translation yet.
      throw new Error(`status '${input.status}' does not map to a resume intent`);
    }

    const intent = await this.dispatch.createOrGetIntent({
      approvalId: input.approvalId,
      kind,
      generation: Math.max(input.cancellationGeneration, link.observedSequence),
      operationKey: input.operationKey,
    });

    await this.dispatch.transitionIntent({
      intentId: intent.intentId,
      from: 'PENDING',
      to: 'CLAIMED',
    });

    if (kind === 'CONTINUE_APPROVED') {
      // Execution evidence must exist BEFORE resuming the model turn: the
      // privileged effect was executed/verified by C034 out-of-band.
      if (!input.executionEvidenceDigest) {
        await this.dispatch.transitionIntent({
          intentId: intent.intentId,
          from: 'CLAIMED',
          to: 'HUMAN_INTERVENTION',
        });
        throw new Error('cannot CONTINUE_APPROVED without durable execution evidence');
      }
      await this.dispatch.transitionIntent({
        intentId: intent.intentId,
        from: 'CLAIMED',
        to: 'EXECUTING_ACTION',
      });
      await this.dispatch.transitionIntent({
        intentId: intent.intentId,
        from: 'EXECUTING_ACTION',
        to: 'RUNTIME_RESUMING',
      });
      const resume = await this.dispatch.resumeCheckpoint({
        sessionId: link.sessionId,
        turnId: link.turnId,
        checkpointTokenDigest: link.checkpointTokenDigest,
        ...(input.executionEvidenceDigest
          ? { executionEvidenceDigest: input.executionEvidenceDigest }
          : {}),
      });
      if (!resume.resumed) {
        await this.dispatch.transitionIntent({
          intentId: intent.intentId,
          from: 'RUNTIME_RESUMING',
          to: 'RECONCILING',
        });
        return { intentId: intent.intentId, kind, state: 'RECONCILING' };
      }
      await this.dispatch.transitionIntent({
        intentId: intent.intentId,
        from: 'RUNTIME_RESUMING',
        to: 'COMPLETED',
      });
      return { intentId: intent.intentId, kind, state: 'COMPLETED' };
    }

    // Closure intents: safe duplicates — runtime may already be closed.
    await this.dispatch.deliverClosure({
      sessionId: link.sessionId,
      turnId: link.turnId,
      reasonCode: kind,
    });
    await this.dispatch.transitionIntent({
      intentId: intent.intentId,
      from: 'CLAIMED',
      to: 'COMPLETED',
    });
    return { intentId: intent.intentId, kind, state: 'COMPLETED' };
  }
}
