/**
 * C020 §8/§10 — GitHub branches/commits mutation contracts.
 *
 * Branches/commits/operations are exact-state-bound: mutations carry expected
 * before-state SHA and branch ownership; every write has a durable operation
 * key and a canonical input fingerprint; a `MutationResult` distinguishes
 * applied / replayed / conflict / outcome_unknown and NEVER maps an uncertain
 * provider outcome to a blind failure (C020 §12/§18). All objects are bounded.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const GIT_MUTATION_SCHEMA_VERSION = 1 as const;

export const BRANCH_PREFIX = 'agent/' as const;

export const MUTATION_STATUSES = [
  'authorized',
  'executing',
  'applied',
  'outcome_unknown',
  'conflicted',
  'failed',
  'reconciling',
  'not_applied',
  'manual_review',
] as const;
export type MutationStatus = (typeof MUTATION_STATUSES)[number];

export const MUTATION_TERMINAL_STATUSES: readonly MutationStatus[] = [
  'applied',
  'conflicted',
  'failed',
  'manual_review',
];

export type BrandedBranchName = Brand<'BranchName'>;
export type BrandedCommitSha = Brand<'CommitSha'>;
export type BrandedTreeSha = Brand<'TreeSha'>;
export type BrandedMutationOperationId = Brand<'GitMutationOperationId'>;

type Brand<K extends string> = string & { readonly __brand: K };

const sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const branchName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'unsafe branch name characters');

export const gitRepoRefSchema = z
  .object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) })
  .strict();
export interface GitRepoRef {
  readonly owner: string;
  readonly repo: string;
}

export const gitBranchSchema = z
  .object({
    name: branchName.transform((v) => v as BrandedBranchName),
    ref: z.string().min(1).max(300),
    headSha: sha40.transform((v) => v as BrandedCommitSha),
    protected: z.boolean(),
    repositoryId: z.string().min(1).max(128),
  })
  .strict();
export interface GitBranch {
  readonly name: BrandedBranchName;
  readonly ref: string;
  readonly headSha: BrandedCommitSha;
  readonly protected: boolean;
  readonly repositoryId: string;
}

export const commitIdentitySchema = z
  .object({
    name: z.string().min(1).max(100),
    email: z.string().min(3).max(200),
    dateIso: z.string().min(1).max(40),
  })
  .strict();
export interface VerifiedCommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly dateIso: string;
}

export const gitCommitSchema = z
  .object({
    sha: sha40.transform((v) => v as BrandedCommitSha),
    parents: z.array(sha40),
    treeSha: sha40.transform((v) => v as BrandedTreeSha),
    author: commitIdentitySchema,
    committer: commitIdentitySchema,
    message: z.string().min(1).max(10_000),
    verification: z.string().min(1).max(64),
    createdAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface GitCommit {
  readonly sha: BrandedCommitSha;
  readonly parents: readonly string[];
  readonly treeSha: BrandedTreeSha;
  readonly author: VerifiedCommitIdentity;
  readonly committer: VerifiedCommitIdentity;
  readonly message: string;
  readonly verification: string;
  readonly createdAtIso: string;
}

export const treeEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !p.startsWith('/') && !p.includes('..')),
    mode: z.enum(['100644', '100755', '040000', '120000']),
    type: z.enum(['blob', 'tree']),
    sha: sha40,
  })
  .strict();
export const commitTreeSpecSchema = z
  .object({ entries: z.array(treeEntrySchema).max(10_000) })
  .strict();
export interface CommitTreeSpec {
  readonly entries: readonly {
    readonly path: string;
    readonly mode: '100644' | '100755' | '040000' | '120000';
    readonly type: 'blob' | 'tree';
    readonly sha: string;
  }[];
}

export const createBranchInputSchema = z
  .object({
    repository: gitRepoRefSchema,
    branch: branchName,
    baseSha: sha40,
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface CreateBranchInput {
  readonly repository: GitRepoRef;
  readonly branch: string;
  readonly baseSha: string;
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const createCommitInputSchema = z
  .object({
    repository: gitRepoRefSchema,
    branch: branchName,
    expectedHeadSha: sha40,
    parentSha: sha40,
    tree: commitTreeSpecSchema,
    message: z.string().min(1).max(10_000),
    author: commitIdentitySchema.optional(),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface CreateCommitInput {
  readonly repository: GitRepoRef;
  readonly branch: string;
  readonly expectedHeadSha: string;
  readonly parentSha: string;
  readonly tree: CommitTreeSpec;
  readonly message: string;
  readonly author?: VerifiedCommitIdentity | undefined;
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const advanceBranchInputSchema = z
  .object({
    repository: gitRepoRefSchema,
    branch: branchName,
    expectedOldSha: sha40,
    newSha: sha40,
    // Force is structurally impossible in the MVP contract.
    force: z.literal(false),
    workflowRunId: idSchemas.workflowRunId,
    operationKey: idSchemas.operationKey,
  })
  .strict();
export interface AdvanceBranchInput {
  readonly repository: GitRepoRef;
  readonly branch: string;
  readonly expectedOldSha: string;
  readonly newSha: string;
  readonly force: false;
  readonly workflowRunId: string;
  readonly operationKey: string;
}

export const reconcileInputSchema = z.object({ operationId: z.string().min(1).max(128) }).strict();

export interface GitMutationOperation {
  readonly id: string;
  readonly kind: 'create_branch' | 'create_commit' | 'advance_branch';
  readonly actionId: string;
  readonly repository: GitRepoRef;
  readonly branch: string;
  readonly workflowRunId: string;
  readonly operationKey: string;
  readonly inputDigest: string;
  readonly expectedBeforeSha: string;
  readonly intendedAfterSha?: string | undefined;
  readonly state: MutationStatus;
  readonly attempts: number;
  readonly providerRefs: readonly string[];
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export type MutationResult<T> =
  | { readonly status: 'applied'; readonly value: T; readonly detail?: string | undefined }
  | { readonly status: 'replayed'; readonly value: T; readonly detail?: string | undefined }
  | { readonly status: 'conflict'; readonly detail: string }
  | { readonly status: 'outcome_unknown'; readonly detail: string };

export const writeContracts = {
  createBranchInputSchema,
  createCommitInputSchema,
  advanceBranchInputSchema,
  gitRepoRefSchema,
  gitBranchSchema,
  gitCommitSchema,
  commitTreeSpecSchema,
  reconcileInputSchema,
};
