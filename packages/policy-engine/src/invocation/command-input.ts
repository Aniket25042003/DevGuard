/**
 * Per-command input validation for manual workflow launches.
 */
import { z } from 'zod';
import { validationFailed } from '@devguard/errors';
import type { WorkflowIdV1 } from './registry.js';

const reviewRemediationInputSchema = z
  .object({
    pullRequestNumber: z.number().int().positive().max(10_000_000),
  })
  .strict();

const diagnoseFailureInputSchema = z
  .object({
    pullRequestNumber: z.number().int().positive().max(10_000_000),
    checkRunId: z.string().min(1).max(128).optional(),
  })
  .strict();

const implementIssueInputSchema = z
  .object({
    issueNumber: z.number().int().positive().max(10_000_000),
  })
  .strict();

const securityAuditInputSchema = z
  .object({
    ref: z.string().min(1).max(256).optional(),
    scopes: z.array(z.string().min(1).max(64)).max(16).optional(),
  })
  .strict();

const securityPatchInputSchema = z
  .object({
    findingIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

const EMPTY_OBJECT_SCHEMA = z.object({}).strict();

export function validateManualCommandInput(workflowId: WorkflowIdV1, input: unknown): unknown {
  try {
    switch (workflowId) {
      case 'review_remediation':
        return reviewRemediationInputSchema.parse(input);
      case 'diagnose_failure':
        return diagnoseFailureInputSchema.parse(input);
      case 'implement_issue':
        return implementIssueInputSchema.parse(input);
      case 'security_audit':
        return securityAuditInputSchema.parse(input ?? {});
      case 'security_patch':
        return securityPatchInputSchema.parse(input);
      case 'dependency_upgrade':
      case 'repository_health_check':
      case 'manual_refactor':
        return EMPTY_OBJECT_SCHEMA.parse(input ?? {});
      default:
        throw validationFailed([{ path: 'commandId', constraint: 'unsupported command input' }]);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw validationFailed(
        error.issues.map((issue) => ({
          path: ['input', ...issue.path.map(String)].join('.'),
          constraint: issue.message,
        })),
      );
    }
    throw error;
  }
}
