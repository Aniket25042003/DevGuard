/**
 * C016 §8/§10 — instruction trust hierarchy contracts.
 *
 * Repository/task content guides implementation but can NEVER authorize actions
 * or override DevGuard safety, policy, or workflow constraints (C016 §2/§4).
 * The tier order here is closed and authoritative; lower tiers may narrow
 * style/scope only when they do not conflict with a higher tier. Assemble
 * produces an immutable `InstructionSnapshot` bound to exact policy/workflow/ref
 * versions; output separates authoritative constraints from advisory
 * instructions from untrusted task data — never a single flattened authority-
 * free string.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const INSTRUCTION_SCHEMA_VERSION = 1 as const;

/**
 * Closed, ordered precedence: index 0 has the most authority. Repository files
 * and task text are untrusted; only `global_safety`, `repository_policy`, and
 * `workflow_rule` are authoritative tiers, and they are required to assemble.
 */
export const INSTRUCTION_TIERS = [
  'global_safety',
  'repository_policy',
  'workflow_rule',
  'repository_instruction',
  'task_request',
  'content_data',
] as const;
export type InstructionTier = (typeof INSTRUCTION_TIERS)[number];

export const AUTHORITATIVE_TIERS: readonly InstructionTier[] = [
  'global_safety',
  'repository_policy',
  'workflow_rule',
];
export const ADVISORY_TIERS: readonly InstructionTier[] = [
  'repository_instruction',
  'task_request',
];
export const UNTRUSTED_TIERS: readonly InstructionTier[] = ['content_data'];

const TIER_INDEX: Readonly<Record<InstructionTier, number>> = {
  global_safety: 0,
  repository_policy: 1,
  workflow_rule: 2,
  repository_instruction: 3,
  task_request: 4,
  content_data: 5,
};

export function tierPrecedes(high: InstructionTier, low: InstructionTier): boolean {
  return TIER_INDEX[high] < TIER_INDEX[low];
}

/** Directive categories recognized by the classifier (C016 §12/§22). */
export const DIRECTIVE_CATEGORIES = [
  'style',
  'scope',
  'authority_grant',
  'safety',
  'secret',
  'tool',
  'approval',
  'network',
  'sandbox',
  'validation',
  'action_risk',
  'global',
  'unknown',
] as const;
export type DirectiveCategory = (typeof DIRECTIVE_CATEGORIES)[number];

/** Rejection reason codes (C016 §8/§18); safe to log/expose. */
export const REJECTION_REASON_CODES = [
  'AUTHORITY_GRANT',
  'SAFETY_OVERRIDE',
  'SECRET_EXFILTRATION',
  'TOOL_AVAILABILITY',
  'APPROVAL_OVERRIDE',
  'NETWORK_ALLOW',
  'SANDBOX_OVERRIDE',
  'VALIDATION_BYPASS',
  'ACTION_RISK_OVERRIDE',
  'GLOBAL_CONSTRAINT_OVERRIDE',
  'AMBIGUOUS_SAFETY',
  'MISSING_TRUSTED_TIER',
  'CONTENT_MALFORMED',
  'CONTENT_OVERLIMIT',
  'ENCODING_ESCAPE',
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

/** Assembly statuses (C016 §9); terminal: resolved/rejected/superseded. */
export const INSTRUCTION_SNAPSHOT_STATUSES = [
  'collecting',
  'validating',
  'resolved',
  'rejected',
  'superseded',
] as const;
export type InstructionSnapshotStatus = (typeof INSTRUCTION_SNAPSHOT_STATUSES)[number];

export const INSTRUCTION_TRUST_LABELS = ['authoritative', 'advisory', 'untrusted'] as const;
export type InstructionTrustLabel = (typeof INSTRUCTION_TRUST_LABELS)[number];

export interface InstructionSource {
  readonly id: string;
  readonly tier: InstructionTier;
  readonly origin: string;
  readonly immutableRef: string;
  readonly path?: string | undefined;
  readonly lineRange?: { readonly start: number; readonly end: number } | undefined;
  readonly contentHash: string;
  readonly sizeBytes?: number | undefined;
  readonly loadedAtIso: string;
  readonly parserWarnings: readonly string[];
}

export interface InstructionSegment {
  readonly sourceId: string;
  readonly tier: InstructionTier;
  readonly category: DirectiveCategory;
  /** Bounded, escaped text fragment (never raw, never executed). */
  readonly text: string;
  readonly applicablePaths?: readonly string[] | undefined;
}

export interface RejectedDirective {
  readonly sourceId: string;
  readonly tier: InstructionTier;
  readonly reasonCode: RejectionReasonCode;
  readonly snippetHash: string;
  readonly detail: string;
}

export interface InstructionConflict {
  readonly higherTier: InstructionTier;
  readonly lowerTier: InstructionTier;
  readonly reasonCode: RejectionReasonCode;
  readonly detail: string;
}

export interface InstructionSnapshot {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowRunId: string;
  readonly headSha: string;
  readonly workflowDefinitionVersion: string;
  readonly policyVersionId: string;
  readonly taskRequestRef: string;
  readonly schemaVersion: 1;
  readonly status: InstructionSnapshotStatus;
  readonly createdAtIso: string;
  readonly segments: readonly InstructionSegment[];
  readonly rejectedDirectives: readonly RejectedDirective[];
  readonly conflicts: readonly InstructionConflict[];
  readonly truncation: { readonly truncated: boolean; readonly reason?: string | undefined };
  readonly digest: string;
  readonly operationKey: string;
}

export interface AssembleInstructionSnapshot {
  readonly repositoryId: string;
  readonly workflowRunId: string;
  readonly headSha: string;
  readonly workflowDefinitionVersion: string;
  readonly policyVersionId: string;
  readonly taskRequestRef: string;
  readonly operationKey: string;
}

export interface ResolveInstructionsForPath {
  readonly snapshotId: string;
  readonly path: string;
}

export interface ResolvedInstructionSet {
  readonly snapshotId: string;
  /** Lower tier, path-applicable, non-rejected segments (advisory only). */
  readonly advisoryInstructions: readonly InstructionSegment[];
  /** Higher tier text that always applies regardless of path (authoritative). */
  readonly authoritativeConstraints: readonly InstructionSegment[];
  /** Raw/untrusted task data kept structurally separate (never delivery authority). */
  readonly untrustedTaskData: readonly InstructionSegment[];
}

export interface ValidateInstructionCandidate {
  readonly text: string;
  /** The tier the candidate originates from (for precedence diagnostics). */
  readonly tier: InstructionTier;
  readonly snapshotId?: string | undefined;
}

export interface InstructionValidation {
  readonly category: DirectiveCategory;
  readonly accepted: boolean;
  readonly reasonCode?: RejectionReasonCode | undefined;
}

// ---- boundary schemas (zod v4 strict) --------------------------------------
export const instructionTierSchema = z.enum(INSTRUCTION_TIERS);
export const directiveCategorySchema = z.enum(DIRECTIVE_CATEGORIES);

export const assembleInstructionSnapshotSchema = z
  .object({
    repositoryId: idSchemas.repositoryId,
    workflowRunId: idSchemas.workflowRunId,
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    workflowDefinitionVersion: z.string().min(1).max(128),
    policyVersionId: idSchemas.policyVersionId,
    taskRequestRef: z.string().min(1).max(256),
    operationKey: idSchemas.operationKey,
  })
  .strict();

export const resolveInstructionsForPathSchema = z
  .object({
    snapshotId: z.string().min(1).max(128),
    path: z.string().min(1).max(1024),
  })
  .strict();

export const validateInstructionCandidateSchema = z
  .object({
    text: z.string().min(1).max(8000),
    tier: instructionTierSchema,
    snapshotId: z.string().min(1).max(128).optional(),
  })
  .strict();

export type AssembleInstructionSnapshotInput = z.output<typeof assembleInstructionSnapshotSchema>;
export type ResolveInstructionsForPathInput = z.output<typeof resolveInstructionsForPathSchema>;
export type ValidateInstructionCandidateInput = z.output<typeof validateInstructionCandidateSchema>;
