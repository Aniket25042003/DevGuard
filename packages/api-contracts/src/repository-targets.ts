/**
 * Repository-scoped launch targets (PRs, issues, refs, findings) for the
 * workflow launcher surfaces.
 */
import { z } from 'zod';

export const pullRequestSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(512),
    state: z.enum(['open', 'closed']),
    authorLogin: z.string().min(1).max(128),
    updatedAt: z.string().min(1).max(64),
    htmlUrl: z.string().url(),
    headRef: z.string().min(1).max(256),
    baseRef: z.string().min(1).max(256),
    draft: z.boolean(),
  })
  .strict();
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const issueSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(512),
    state: z.enum(['open', 'closed']),
    authorLogin: z.string().min(1).max(128),
    updatedAt: z.string().min(1).max(64),
    htmlUrl: z.string().url(),
    labels: z.array(z.string().min(1).max(128)),
  })
  .strict();
export type IssueSummary = z.infer<typeof issueSummarySchema>;

export const gitRefSummarySchema = z
  .object({
    name: z.string().min(1).max(256),
    commitSha: z.string().min(7).max(64),
    isDefault: z.boolean(),
    protected: z.boolean(),
  })
  .strict();
export type GitRefSummary = z.infer<typeof gitRefSummarySchema>;

export const repositoryFindingSummarySchema = z
  .object({
    id: z.string().uuid(),
    severity: z.string().min(1).max(32),
    status: z.string().min(1).max(32),
    title: z.string().min(1).max(512),
    rule: z.string().max(128).optional(),
    filePath: z.string().max(1024).optional(),
    autoFixable: z.boolean(),
  })
  .strict();
export type RepositoryFindingSummary = z.infer<typeof repositoryFindingSummarySchema>;

export const repositoryTargetListQuerySchema = z
  .object({
    state: z.enum(['open', 'closed', 'all']).optional(),
    q: z.string().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(256).optional(),
  })
  .strict();
export type RepositoryTargetListQuery = z.infer<typeof repositoryTargetListQuerySchema>;

export const repositoryFindingListQuerySchema = z
  .object({
    status: z.enum(['open', 'confirmed', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type RepositoryFindingListQuery = z.infer<typeof repositoryFindingListQuerySchema>;
