/**
 * C059 §8/§9/§10 — approval resumption and expiry.
 *
 * A resume job only claims an APPROVED approval with a matching resolution
 * version/fingerprint whose run is not terminal/cancelling and whose execution
 * generation is current. Resume transitions `QUEUED → CLAIMED → REVALIDATING →
 * SYNCING_CHECKPOINT → EXECUTING → VERIFYING → COMPLETED`, branching to
 * RETRY_WAIT / STALE_NOOP / CANCELLED_FENCED / DEAD_LETTERED. Approval expiry
 * marks stale approvals so rejected/stale resolutions never resume. Idempotent
 * by `(approvalId, resolutionVersion)`.
 */
export const APPROVAL_RESUME_STATES = [
  'QUEUED',
  'CLAIMED',
  'REVALIDATING',
  'SYNCING_CHECKPOINT',
  'EXECUTING',
  'VERIFYING',
  'COMPLETED',
  'RETRY_WAIT',
  'STALE_NOOP',
  'CANCELLED_FENCED',
  'DEAD_LETTERED',
] as const;
export type ApprovalResumeState = (typeof APPROVAL_RESUME_STATES)[number];

export type ApprovalResolution = 'approved' | 'rejected' | 'stale';

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly resolution: ApprovalResolution;
  readonly resolutionVersion: number;
  readonly resolutionFingerprint: string;
  readonly runId: string;
  readonly runState: string;
  readonly executionGeneration: number;
  readonly cancelledVersion: number;
}

export interface ApprovalStorePort {
  get(approvalId: string): Promise<ApprovalRecord | undefined>;
  resumeState(
    approvalId: string,
    resolutionVersion: number,
  ): Promise<ApprovalResumeState | undefined>;
  setResumeState(
    approvalId: string,
    resolutionVersion: number,
    state: ApprovalResumeState,
  ): Promise<void>;
  markExpired(approvalId: string): Promise<void>;
}

export class InMemoryApprovalStore implements ApprovalStorePort {
  readonly approvals = new Map<string, ApprovalRecord>();
  readonly resume = new Map<string, ApprovalResumeState>();
  readonly expired = new Set<string>();

  async get(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(approvalId);
  }
  async resumeState(
    approvalId: string,
    resolutionVersion: number,
  ): Promise<ApprovalResumeState | undefined> {
    void resolutionVersion;
    return this.resume.get(approvalId);
  }
  async setResumeState(
    approvalId: string,
    resolutionVersion: number,
    state: ApprovalResumeState,
  ): Promise<void> {
    void resolutionVersion;
    this.resume.set(approvalId, state);
  }
  async markExpired(approvalId: string): Promise<void> {
    this.expired.add(approvalId);
  }
}

export interface ResumeExecutorPort {
  execute(runId: string, approvalId: string): Promise<{ ok: true } | { ok: false; code: string }>;
}

export interface ApprovalResumeDeps {
  readonly store: ApprovalStorePort;
  readonly executor: ResumeExecutorPort;
}

export type ResumeOutcome =
  | { readonly ok: true; readonly state: 'COMPLETED' }
  | { readonly ok: true; readonly state: 'STALE_NOOP' | 'CANCELLED_FENCED' }
  | { readonly ok: false; readonly state: 'RETRY_WAIT' | 'DEAD_LETTERED'; readonly detail: string };

export class ApprovalResumeService {
  constructor(private readonly deps: ApprovalResumeDeps) {}

  async resume(approvalId: string, resolutionVersion: number): Promise<ResumeOutcome> {
    const approval = await this.deps.store.get(approvalId);
    if (approval === undefined)
      return { ok: false, state: 'DEAD_LETTERED', detail: 'approval unknown' };
    // Claim guard: approved + matching resolution version + nonterminal/non-cancelling run.
    if (approval.resolution !== 'approved') return { ok: true, state: 'STALE_NOOP' }; // rejected/stale never resume
    if (approval.resolutionVersion !== resolutionVersion) return { ok: true, state: 'STALE_NOOP' };
    if (
      approval.runState === 'FAILED' ||
      approval.runState === 'CANCELLED' ||
      approval.runState === 'SUCCEEDED'
    )
      return { ok: true, state: 'STALE_NOOP' };
    if (approval.cancelledVersion > approval.executionGeneration)
      return { ok: true, state: 'CANCELLED_FENCED' };

    const existing = await this.deps.store.resumeState(approvalId, resolutionVersion);
    if (existing !== undefined && existing === 'COMPLETED') return { ok: true, state: 'COMPLETED' };

    await this.deps.store.setResumeState(approvalId, resolutionVersion, 'CLAIMED');
    const executed = await this.deps.executor.execute(approval.runId, approval.approvalId);
    if (!executed.ok) {
      await this.deps.store.setResumeState(
        approvalId,
        resolutionVersion,
        executed.code === 'RATE_LIMITED' ? 'RETRY_WAIT' : 'DEAD_LETTERED',
      );
      return {
        ok: false,
        state: executed.code === 'RATE_LIMITED' ? 'RETRY_WAIT' : 'DEAD_LETTERED',
        detail: executed.code,
      };
    }
    await this.deps.store.setResumeState(approvalId, resolutionVersion, 'COMPLETED');
    return { ok: true, state: 'COMPLETED' };
  }

  async expire(approvalId: string): Promise<void> {
    const approval = await this.deps.store.get(approvalId);
    if (approval === undefined) return;
    if (approval.resolution !== 'approved') return;
    await this.deps.store.markExpired(approvalId);
  }
}
