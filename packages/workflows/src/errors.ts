/**
 * C045 §11/§18 — workflow error codes (C003 extensions).
 *
 * Registered through @devguard/errors' global registry at package load.
 * Re-registering identical descriptors is a no-op; conflicting redefinition
 * throws — codes are never repurposed (C003 §1). All codes below reuse the
 * permitted HTTP status set and retry taxonomy.
 */
import { registerError } from '@devguard/errors';
import { z } from 'zod';

const shaPattern = /^[0-9a-f]{64}$/;
const idPattern = z.string().min(1).max(64);
const versionPattern = z.string().min(1).max(64);

/** Fixed, user-safe detail payloads every workflow code may carry. */
const detail = {
  /** Known-but-unregistered workflow or version reference. */
  workflowRef: z
    .object({
      workflowId: idPattern,
      version: versionPattern.optional(),
    })
    .strict(),
  /** Conflicting identity re-registration (same id+version, different digest). */
  immutable: z
    .object({
      workflowId: idPattern,
      version: versionPattern,
      expectedDigest: z.string().regex(shaPattern).optional(),
      actualDigest: z.string().regex(shaPattern).optional(),
    })
    .strict(),
  /** Input validation field errors (safe path + constraint only). */
  inputIssues: z
    .array(z.object({ path: z.string().min(1), constraint: z.string().min(1) }))
    .max(100),
  /** Capability verification failure. */
  capability: z
    .object({
      capabilityId: z.string().min(1).max(128),
      reason: z.string().min(1).max(256).optional(),
    })
    .strict(),
  /** Startup/build validation issues for one definition. */
  definitionIssues: z
    .array(
      z
        .object({
          workflowId: idPattern.optional(),
          version: versionPattern.optional(),
          path: z.string().min(1),
          constraint: z.string().min(1),
        })
        .strict(),
    )
    .max(200),
  /** Fail-closed unknown cross-reference inside a definition. */
  crossReference: z
    .object({
      workflowId: idPattern,
      version: versionPattern,
      refKind: z.enum(['action', 'validator', 'tool', 'schema', 'capability', 'skill', 'workflow']),
      refId: z.string().min(1).max(128),
      refVersion: z.string().min(1).max(64).optional(),
    })
    .strict(),
  /** Skill asset digest mismatch (security-relevant). */
  skillDigest: z
    .object({
      skillId: z.string().min(1).max(128),
      version: versionPattern,
      expectedDigest: z.string().regex(shaPattern),
      actualDigest: z.string().regex(shaPattern),
    })
    .strict(),
} as const;

/** Stable workflow error codes owned by C045. */
export const WORKFLOW_ERROR_CODES = [
  {
    code: 'WORKFLOW_UNKNOWN',
    category: 'application',
    httpStatus: 404,
    retryClass: 'no_retry',
    safeMessage: 'The requested workflow definition is not known to this deployment.',
    detailSchema: detail.workflowRef,
  },
  {
    code: 'WORKFLOW_VERSION_RETIRED',
    category: 'domain',
    httpStatus: 410,
    retryClass: 'no_retry',
    safeMessage: 'This workflow version is retired and cannot be selected for new runs.',
    detailSchema: detail.workflowRef,
  },
  {
    code: 'WORKFLOW_VERSION_IMMUTABLE',
    category: 'concurrency',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'A registered workflow version is immutable; conflicting replacement is rejected.',
    detailSchema: detail.immutable,
  },
  {
    code: 'WORKFLOW_INPUT_INVALID',
    category: 'validation',
    httpStatus: 422,
    retryClass: 'no_retry',
    safeMessage: 'The workflow input failed validation against its declared input schema.',
    detailSchema: detail.inputIssues,
  },
  {
    code: 'WORKFLOW_CAPABILITY_UNSUPPORTED',
    category: 'integration',
    httpStatus: 503,
    retryClass: 'reconcile_then_retry',
    safeMessage: 'A required provider capability is not verified; retry after capability refresh.',
    detailSchema: detail.capability,
  },
  {
    code: 'WORKFLOW_DEFINITION_INVALID',
    category: 'configuration',
    httpStatus: 500,
    retryClass: 'no_retry',
    safeMessage: 'A workflow definition failed validation and cannot be activated.',
    detailSchema: detail.definitionIssues,
  },
  {
    code: 'WORKFLOW_CROSS_REFERENCE_UNKNOWN',
    category: 'configuration',
    httpStatus: 500,
    retryClass: 'no_retry',
    safeMessage: 'A workflow definition references an unknown registry entry and fails closed.',
    detailSchema: detail.crossReference,
  },
  {
    code: 'WORKFLOW_SKILL_DIGEST_MISMATCH',
    category: 'security',
    httpStatus: 409,
    retryClass: 'no_retry',
    safeMessage: 'A skill asset digest does not match its content; registration is blocked.',
    detailSchema: detail.skillDigest,
  },
  {
    code: 'WORKFLOW_RUNTIME_VERSION_UNAVAILABLE',
    category: 'application',
    httpStatus: 501,
    retryClass: 'human_intervention',
    safeMessage: 'The run snapshot references a workflow version unavailable in this deployment.',
    detailSchema: detail.workflowRef,
  },
] as const;

for (const descriptor of WORKFLOW_ERROR_CODES) {
  registerError(descriptor);
}
