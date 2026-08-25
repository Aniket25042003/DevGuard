/**
 * C004 — Safe public projections.
 *
 * Browser-facing DTOs are `.strict()` (unknown keys fail closed), carry no
 * secret refs, internal evidence, object-store keys, or raw model traces.
 * These are the ONLY shapes the web package consumes for these entities.
 */
import { z } from 'zod';
import { WorkflowStatus } from './workflows.js';
import { ApprovalStatus } from './approvals.js';

export const publicWorkflowRunSummary = z
  .object({
    id: z.string().min(1).max(128),
    workflowKind: z.string().min(1).max(64),
    status: WorkflowStatus,
    repositoryId: z.string().min(1).max(128),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type PublicWorkflowRunSummary = z.infer<typeof publicWorkflowRunSummary>;

export const publicApprovalView = z
  .object({
    id: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    status: ApprovalStatus,
    repositoryFullName: z.string().min(3).max(201),
    actionType: z.string().min(1).max(64),
    riskClass: z.enum([
      'read',
      'reversible_write',
      'sensitive_write',
      'destructive',
      'external_side_effect',
    ]),
    rationaleSummary: z.string().max(2_000),
    expiresAt: z.string(),
  })
  .strict();
export type PublicApprovalView = z.infer<typeof publicApprovalView>;
