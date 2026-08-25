/**
 * C004 — Approval contracts.
 *
 * DevGuard is the durable approval system of record. A TrueForge checkpoint is
 * correlated pause/resume state, never authorization evidence. Approvals bind
 * an exact operation fingerprint; any relevant change stales the approval.
 */
import { z } from 'zod';
import { externalRef } from './context.js';
import { boundedText, schemas, timestampIso } from './primitives.js';
import { ActionType, RiskClass as RiskClassSchema } from './policy.js';

export const ApprovalStatus = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'stale',
  'executing',
  'executed',
  'failed',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const APPROVAL_TERMINAL_STATUSES = [
  'rejected',
  'expired',
  'stale',
  'executed',
  'failed',
] as const;
export type ApprovalTerminalStatus = (typeof APPROVAL_TERMINAL_STATUSES)[number];

const shaPattern = /^[0-9a-f]{40}$/;

/** Exact-target binding inputs (IF-3). The digest is computed by C031. */
export interface ApprovalFingerprintInputShape {
  readonly installationRef: string;
  readonly repositoryFullName: string;
  readonly actionType: z.infer<typeof ActionType>;
  readonly riskClass: z.infer<typeof RiskClassSchema>;
  readonly pullRequestNumber?: number | undefined;
  readonly branchName?: string | undefined;
  readonly baseSha?: string | undefined;
  readonly headSha?: string | undefined;
  readonly policyVersionRef: string;
  /** Digest of the required-validation snapshot at approval time. */
  readonly validationSnapshotDigest: string;
}

export const approvalFingerprintInput: z.ZodType<ApprovalFingerprintInputShape> = z
  .object({
    installationRef: z.string().min(1).max(128),
    repositoryFullName: z.string().max(201),
    actionType: ActionType,
    riskClass: RiskClassSchema,
    pullRequestNumber: z.number().int().positive().optional(),
    branchName: z.string().max(256).optional(),
    baseSha: z.string().regex(shaPattern).optional(),
    headSha: z.string().regex(shaPattern).optional(),
    policyVersionRef: z.string().min(1).max(128),
    validationSnapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export interface ApprovalRequestShape {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly status: z.infer<typeof ApprovalStatus>;
  readonly fingerprintHex: string;
  readonly target: z.infer<typeof approvalFingerprintInput>;
  readonly rationaleSummary: string;
  /** Correlated TrueForge checkpoint/tool-call reference (pause/resume only). */
  readonly checkpointRef?:
    | {
        readonly sessionId: string;
        readonly toolCallId: string;
        readonly turnId?: string | undefined;
      }
    | undefined;
  readonly requestedByKind: 'agent' | 'system';
  readonly resolvedByUserId?: string | undefined;
  readonly resolutionComment?: string | undefined;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const approvalRequest: z.ZodType<ApprovalRequestShape> = z
  .object({
    id: schemas.approvalId,
    runId: schemas.workflowRunId.optional(),
    actionId: schemas.actionId.optional(),
    status: ApprovalStatus,
    fingerprintHex: z.string().regex(/^[0-9a-f]{64}$/),
    target: approvalFingerprintInput,
    rationaleSummary: boundedText(2_000),
    checkpointRef: z
      .object({
        sessionId: schemas.agentSessionRefId,
        toolCallId: z.string().min(1).max(256),
        turnId: schemas.turnRefId.optional(),
      })
      .strict()
      .optional(),
    requestedByKind: z.enum(['agent', 'system']),
    resolvedByUserId: schemas.userId.optional(),
    resolutionComment: boundedText(2_000).optional(),
    expiresAt: timestampIso,
    createdAt: timestampIso,
    updatedAt: timestampIso,
  })
  .strip();

export { externalRef };
