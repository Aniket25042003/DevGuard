/**
 * C045 §8 — versioned workflow definition schema (workflow-definition/v1).
 *
 * A definition is a STATIC, immutable build asset: it declares typed
 * input/output schema refs, ordered step templates with finite budgets and
 * failure behavior, an allowed-action CEILING (maximum capability, never an
 * authorization decision — C030 evaluates policy at execution), required
 * validators with evidence freshness, limits, artifact criteria, declarative
 * completion/failure predicates, skill refs, tool refs, required provider
 * capabilities, and a compatibility range. No prompt bodies, no mutable
 * policy, no repository/user content ever lives here (C045 §17).
 *
 * Boundary rules: `.strict()` everywhere; omitted SET-like fields normalize
 * to empty arrays (no-rule-does-not-mean-anything); unknown enum members
 * fail closed; limits stay bounded so every step has a finite budget.
 */
import { z } from 'zod';
import { ActionType, ValidatorKind, WorkflowKind } from '@devguard/contracts';
import { semverRangeSchema, semverSchema, type Semver, type SemverRange } from './semver.js';

export type WorkflowType = z.infer<typeof WorkflowKind>;

/** Maximum capability ceiling: canonical action types only (C004 policy). */
export const actionTypeSchema = ActionType;
export type ActionTypeMember = z.infer<typeof actionTypeSchema>;

/** Canonical validator identifiers (C004 evidence). */
export const validatorKindSchema = ValidatorKind;
export type ValidatorKindMember = z.infer<typeof validatorKindSchema>;

export const sha256DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected 64-hex sha256 digest');

export type Sha256Digest = z.infer<typeof sha256DigestSchema>;

const boundedId = z.string().min(1).max(64);

/** Versioned reference into the schema catalog (C045 §12). */
export const schemaRefSchema = z
  .object({
    id: boundedId,
    version: semverSchema,
  })
  .strict();
export type SchemaRef = z.infer<typeof schemaRefSchema>;

/** Required validator with an evidence freshness window (PRD §45). */
export const validatorRequirementSchema = z
  .object({
    kind: validatorKindSchema,
    version: semverSchema.optional(),
    freshnessSeconds: z.number().int().min(60).max(604_800), // 1min..7d
  })
  .strict();
export type ValidatorRequirement = z.infer<typeof validatorRequirementSchema>;

export const validatorRefSchema = z.object({
  kind: validatorKindSchema,
  version: semverSchema.optional(),
});
export type ValidatorRef = z.infer<typeof validatorRefSchema>;

/**
 * Step template: ordered, uniquely named, and REQUIRED to declare a finite
 * retry budget, a timeout and an explicit failure behavior (C045 §12).
 */
export const stepTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'step id must be snake_case, 2..64 chars'),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
    attempts: z
      .object({
        max: z.number().int().min(1).max(10),
        backoffMs: z.number().int().min(0).max(3_600_000).optional(),
      })
      .strict(),
    timeoutMs: z.number().int().min(1_000).max(86_400_000), // 1s..1d, finite
    onFailure: z.enum(['abort', 'next', 'skip']),
    requiresValidators: z.array(validatorRefSchema).max(16).optional(),
    requiresArtifacts: z
      .array(z.string().regex(/^[a-z][a-z0-9_\-.]{1,63}$/))
      .max(16)
      .optional(),
  })
  .strict();
export type StepTemplate = z.infer<typeof stepTemplateSchema>;

/** Bounded resource limits — every limit has a finite ceiling. */
export const workflowLimitsSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(64).optional(),
    totalTimeoutMs: z.number().int().min(1_000).max(604_800_000).optional(), // up to 7d
    maxConcurrentSteps: z.number().int().min(1).max(8).optional(),
    maxArtifacts: z.number().int().min(0).max(256).optional(),
    maxOutputBytes: z.number().int().min(1_024).max(67_108_864).optional(), // up to 64MiB
    maxTotalRetries: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type WorkflowLimits = z.infer<typeof workflowLimitsSchema>;

/** Completion condition kinds (declarative; C048 aggregates evidence). */
export const completionConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all_steps_succeeded') }).strict(),
  z
    .object({
      kind: z.literal('validators_passed'),
      validators: z.array(validatorRefSchema).max(32),
    })
    .strict(),
  z.object({ kind: z.literal('pull_request_open') }).strict(),
]);
export type CompletionCondition = z.infer<typeof completionConditionSchema>;

/**
 * Completion criteria. WF-10: model "done" is never sufficient — structured
 * evidence is a HARD requirement, so `evidence.required` is the literal
 * `true` at schema level and the definition validator enforces it again.
 */
export const completionCriteriaSchema = z
  .object({
    requiredValidators: z.array(validatorRefSchema).max(32),
    evidence: z
      .object({
        required: z.literal(true),
        artifactKinds: z.array(z.string().regex(/^[a-z][a-z0-9_\-.]{1,63}$/)).max(32),
      })
      .strict(),
    conditions: z.array(completionConditionSchema).max(16).optional(),
  })
  .strict();
export type CompletionCriteria = z.infer<typeof completionCriteriaSchema>;

/** Declarative failure predicates — deterministic, never policy strings. */
export const failureConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('validation_failed'),
      validators: z.array(validatorRefSchema).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal('step_failed'),
      steps: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,63}$/)).max(32),
    })
    .strict(),
  z.object({ kind: z.literal('approval_rejected') }).strict(),
  z.object({ kind: z.literal('timeout_exceeded') }).strict(),
  z
    .object({
      kind: z.literal('budget_exceeded'),
      limit: z.enum(['output_bytes', 'artifacts', 'total_time_ms']),
    })
    .strict(),
]);
export type FailureCondition = z.infer<typeof failureConditionSchema>;

export const failureCriteriaSchema = z
  .object({
    conditions: z.array(failureConditionSchema).max(16),
  })
  .strict();
export type FailureCriteria = z.infer<typeof failureCriteriaSchema>;

/** Skill bundle ref: an id+version into the versioned skill asset catalog. */
export const skillRefSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/),
    version: semverSchema,
  })
  .strict();
export type SkillRef = z.infer<typeof skillRefSchema>;

/** Tool ref: an id+registry version into the tool registry (C024 owns it). */
export const toolRefSchema = z
  .object({
    id: z.string().min(1).max(128),
    registryVersion: z.string().min(1).max(64),
  })
  .strict();
export type ToolRef = z.infer<typeof toolRefSchema>;

/** Required provider capability (C036 verifies; C045 only declares). */
export const capabilityRefSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: semverSchema.optional(),
  })
  .strict();
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;

/**
 * Authored definition (build asset). `status` and `digest` are registry
 * state, NOT part of the source shape: the same source always canonicalizes
 * to the same digest.
 */
export const workflowDefinitionSourceSchema = z
  .object({
    schemaVersion: z.literal('workflow-definition/v1'),
    id: WorkflowKind,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    version: semverSchema,
    inputSchema: schemaRefSchema,
    outputSchema: schemaRefSchema,
    // Omitted sets normalize to empty arrays (fail-closed meaning: none).
    allowedActions: z.array(actionTypeSchema).max(32).default([]),
    validators: z.array(validatorRequirementSchema).max(32).default([]),
    tools: z.array(toolRefSchema).max(32).default([]),
    skills: z.array(skillRefSchema).min(1).max(32),
    capabilities: z.array(capabilityRefSchema).max(16).default([]),
    steps: z.array(stepTemplateSchema).min(1).max(64),
    limits: workflowLimitsSchema.optional(),
    completion: completionCriteriaSchema,
    failure: failureCriteriaSchema,
    /** Definition versions this version can resume/replace (C046 reload). */
    compatibility: z.array(semverRangeSchema).max(16).default([]),
  })
  .strict();
export type WorkflowDefinitionSource = z.infer<typeof workflowDefinitionSourceSchema>;

/**
 * Authored/loaded definition BEFORE parsing: version-bearing fields are the
 * canonical string form (major.minor.patch[-prerelease][+build]). The
 * registry and validator accept this input shape and normalize to
 * `WorkflowDefinitionSource` on parse.
 */
export type WorkflowDefinitionSourceInput = z.input<typeof workflowDefinitionSourceSchema>;

/** Registry entry lifecycle (C045 §9). */
export const definitionEntryStatusSchema = z.enum([
  'discovered',
  'validating',
  'active',
  'deprecated',
  'retired',
  'invalid',
  'blocked_capability',
]);
export type DefinitionEntryStatus = z.infer<typeof definitionEntryStatusSchema>;

/** Public status projection (no internal lifecycle states). */
export const publicEntryStatusSchema = z.enum(['active', 'deprecated', 'retired', 'blocked']);
export type PublicEntryStatus = z.infer<typeof publicEntryStatusSchema>;

/**
 * Normalized, sealed definition as stored in the registry generation:
 * source content + digest + registry-assigned status. `digest` covers the
 * canonical source (excluding status/digest) so it is reproducible across
 * restarts and equals the digest of the identical source in any build.
 */
export const workflowDefinitionSchema: z.ZodType<WorkflowDefinitionShape> = z
  .object({
    schemaVersion: z.literal('workflow-definition/v1'),
    id: WorkflowKind,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    version: semverSchema,
    inputSchema: schemaRefSchema,
    outputSchema: schemaRefSchema,
    allowedActions: z.array(actionTypeSchema).max(32),
    validators: z.array(validatorRequirementSchema).max(32),
    tools: z.array(toolRefSchema).max(32),
    skills: z.array(skillRefSchema).min(1).max(32),
    capabilities: z.array(capabilityRefSchema).max(16),
    steps: z.array(stepTemplateSchema).min(1).max(64),
    limits: workflowLimitsSchema.optional(),
    completion: completionCriteriaSchema,
    failure: failureCriteriaSchema,
    compatibility: z.array(semverRangeSchema).max(16),
    status: definitionEntryStatusSchema,
    digest: sha256DigestSchema,
  })
  .strict();

export interface WorkflowDefinitionShape {
  readonly schemaVersion: 'workflow-definition/v1';
  readonly id: WorkflowType;
  readonly name: string;
  readonly description: string;
  readonly version: Semver;
  readonly inputSchema: SchemaRef;
  readonly outputSchema: SchemaRef;
  readonly allowedActions: readonly ActionTypeMember[];
  readonly validators: readonly ValidatorRequirement[];
  readonly tools: readonly ToolRef[];
  readonly skills: readonly SkillRef[];
  readonly capabilities: readonly CapabilityRef[];
  readonly steps: readonly StepTemplate[];
  readonly limits?: WorkflowLimits | undefined;
  readonly completion: CompletionCriteria;
  readonly failure: FailureCriteria;
  readonly compatibility: readonly SemverRange[];
  readonly status: DefinitionEntryStatus;
  readonly digest: Sha256Digest;
}
