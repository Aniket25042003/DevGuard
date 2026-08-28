/**
 * C021 §8/§10 — Pull Request / Review / Check contracts.
 *
 * Runtime evidence is generic GitHub evidence; Qodo has no runtime adapter and
 * is never fabricated. PR state enums are unknown-safe (GitHub stays
 * authoritative). Merge requires exact approval/head/base/validation evidence
 * (C031–C035) and is verified afterward; stale/blocked never executes.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const PR_SCHEMA_VERSION = 1 as const;

export const PR_STATES = [
  'open_draft',
  'open_ready',
  'closed_unmerged',
  'merged',
  'unknown',
] as const;
export type PrState = (typeof PR_STATES)[number];

export const REVIEW_EVIDENCE_KINDS = [
  'review',
  'review_comment',
  'conversation_comment',
  'check_run',
  'check_suite',
  'commit_status',
] as const;
export type ReviewEvidenceKind = (typeof REVIEW_EVIDENCE_KINDS)[number];

export const evidenceConclusionSchema = z.enum([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'action_required',
  'timed_out',
  'stale',
  'unknown',
]);

export const prRefSchema = z
  .object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
    number: z.number().int().positive().max(10_000_000),
  })
  .strict();
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

export const gitRepoRefSchema = z
  .object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) })
  .strict();
export interface GitRepoRef {
  readonly owner: string;
  readonly repo: string;
}

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const boundedText = (max: number) => z.string().max(max);

export const pullRequestSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    ref: prRefSchema,
    number: z.number().int().positive().max(10_000_000),
    title: boundedText(200),
    body: boundedText(256_000),
    state: z.enum(PR_STATES),
    draft: z.boolean(),
    baseRef: z.string().min(1).max(256),
    headRef: z.string().min(1).max(256),
    baseSha: sha40,
    headSha: sha40,
    authorLogin: z.string().min(1).max(100),
    mergeable: z.enum(['mergeable', 'conflicting', 'unknown']).default('unknown'),
    mergedAtIso: z.string().min(1).max(40).optional(),
    mergedByLogin: z.string().min(1).max(100).optional(),
    updatedAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface PullRequest {
  readonly providerId: string;
  readonly ref: PrRef;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: PrState;
  readonly draft: boolean;
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly authorLogin: string;
  readonly mergeable: 'mergeable' | 'conflicting' | 'unknown';
  readonly mergedAtIso?: string | undefined;
  readonly mergedByLogin?: string | undefined;
  readonly updatedAtIso: string;
}

export const reviewEvidenceSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    kind: z.enum(REVIEW_EVIDENCE_KINDS),
    authorLogin: z.string().max(100).optional(),
    sourceLabel: z.enum(['human', 'github_visible_app', 'unknown']).default('unknown'),
    state: z.string().max(32),
    conclusion: evidenceConclusionSchema.optional(),
    bodyReference: z.string().max(400).optional(),
    path: z.string().max(1024).optional(),
    line: z.number().int().positive().optional(),
    commitSha: z.string().max(64).optional(),
    submittedAtIso: z.string().min(1).max(40).optional(),
    dismissed: z.boolean().default(false),
  })
  .strict();
export interface ReviewEvidence {
  readonly providerId: string;
  readonly kind: ReviewEvidenceKind;
  readonly authorLogin?: string | undefined;
  readonly sourceLabel: 'human' | 'github_visible_app' | 'unknown';
  readonly state: string;
  readonly conclusion?: string | undefined;
  readonly bodyReference?: string | undefined;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  readonly commitSha?: string | undefined;
  readonly submittedAtIso?: string | undefined;
  readonly dismissed: boolean;
}

export const pullRequestFingerprintSchema = z
  .object({
    prNumber: z.number().int().positive(),
    baseSha: sha40,
    headSha: sha40,
    state: z.enum(PR_STATES),
    draft: z.boolean(),
    mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
    requiredEvidenceDigests: z.array(z.string().max(64)).max(64),
    policyVersionId: z.string().max(64),
    capturedAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface PullRequestFingerprint {
  readonly prNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly state: PrState;
  readonly draft: boolean;
  readonly mergeable: 'mergeable' | 'conflicting' | 'unknown';
  readonly requiredEvidenceDigests: readonly string[];
  readonly policyVersionId: string;
  readonly capturedAtIso: string;
}

// ---- mutation inputs --------------------------------------------------------
export const createPullRequestSchema = z
  .object({
    repository: gitRepoRefSchema,
    ownedHeadBranch: z.string().min(1).max(256),
    headSha: sha40,
    baseBranch: z.string().min(1).max(256),
    baseSha: sha40,
    title: boundedText(200),
    body: boundedText(256_000),
    draft: z.boolean(),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface CreatePullRequest {
  readonly repository: GitRepoRef;
  readonly ownedHeadBranch: string;
  readonly headSha: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const updatePullRequestSchema = z
  .object({
    repository: gitRepoRefSchema,
    prNumber: z.number().int().positive(),
    expectedHeadSha: sha40,
    expectedBaseSha: sha40,
    patch: z
      .object({
        title: boundedText(200).optional(),
        body: boundedText(256_000).optional(),
        draft: z.boolean().optional(),
      })
      .strict(),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface UpdatePullRequest {
  readonly repository: GitRepoRef;
  readonly prNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
  readonly patch: {
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly draft?: boolean | undefined;
  };
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const postCommentSchema = z
  .object({
    repository: gitRepoRefSchema,
    prNumber: z.number().int().positive(),
    body: boundedText(64_000),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface PostPullRequestComment {
  readonly repository: GitRepoRef;
  readonly prNumber: number;
  readonly body: string;
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const requestReviewSchema = z
  .object({
    repository: gitRepoRefSchema,
    prNumber: z.number().int().positive(),
    reviewers: z.array(z.string().min(1).max(100)).max(20),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface RequestReview {
  readonly repository: GitRepoRef;
  readonly prNumber: number;
  readonly reviewers: readonly string[];
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const mergePullRequestSchema = z
  .object({
    repository: gitRepoRefSchema,
    prNumber: z.number().int().positive(),
    expectedHeadSha: sha40,
    expectedBaseSha: sha40,
    approvedFingerprint: pullRequestFingerprintSchema,
    approvalId: idSchemas.approvalId,
    actionId: z.string().min(1).max(128),
    validationDigest: z.string().max(64),
    method: z.enum(['merge', 'squash']),
    commitTitle: boundedText(200).optional(),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface MergePullRequest {
  readonly repository: GitRepoRef;
  readonly prNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
  readonly approvedFingerprint: PullRequestFingerprint;
  readonly approvalId: string;
  readonly actionId: string;
  readonly validationDigest: string;
  readonly method: 'merge' | 'squash';
  readonly commitTitle?: string | undefined;
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const prContractsSchema = {
  createPullRequestSchema,
  updatePullRequestSchema,
  postCommentSchema,
  requestReviewSchema,
  mergePullRequestSchema,
  pullRequestSchema,
  reviewEvidenceSchema,
  pullRequestFingerprintSchema,
  prRefSchema,
  gitRepoRefSchema,
};
