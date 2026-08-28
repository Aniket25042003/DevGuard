/**
 * C028 §8 — canonical workflow/trigger/manual-command registries with
 * versioned aliases. Aliases map to exactly ONE canonical ID; ambiguous or
 * unknown references are rejected, never guessed (fail closed).
 */
import { z } from 'zod';

export const WORKFLOW_IDS_V1 = [
  'implement_issue',
  'diagnose_failure',
  'security_audit',
  'security_patch',
  'dependency_upgrade',
  'review_remediation',
  'repository_health_check',
  'manual_refactor',
] as const;

export type WorkflowIdV1 = (typeof WORKFLOW_IDS_V1)[number];

export const TRIGGER_IDS_V1 = [
  'issues.opened',
  'issues.labeled',
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
  'pull_request_review.submitted',
  'pull_request_review_comment.created',
  'check_run.completed',
  'push.default_branch',
] as const;

export type TriggerIdV1 = (typeof TRIGGER_IDS_V1)[number];

/** C028 §8 base surface aliases (PRD §5.1). Validation-step names are NOT aliases. */
const BASE_SURFACE_ALIASES: Readonly<Record<string, WorkflowIdV1>> = Object.freeze({
  fix_tests: 'diagnose_failure',
  diagnose_bug: 'diagnose_failure',
  security_scan: 'security_audit',
  dependency_update: 'dependency_upgrade',
  refactor: 'manual_refactor',
});

/**
 * CP001 §8 — merged alias table used by EVERY client surface (CLI flags, web
 * buttons, GitHub `@devguard` verbs). Merges the C028 base aliases with the
 * CP001 surface verbs. Bijective by construction: one alias maps to exactly
 * ONE canonical workflow ID. Case is significant — `Review` is rejected,
 * never case-folded. `status` / `help` are GitHub *meta* verbs and are NOT
 * aliases (CP019 handles them without SubmitCommand).
 */
export const COMMAND_ALIASES_V1: Readonly<Record<string, WorkflowIdV1>> = Object.freeze({
  ...BASE_SURFACE_ALIASES,
  review: 'review_remediation',
  fix: 'diagnose_failure',
  audit: 'security_audit',
  patch: 'security_patch',
  implement: 'implement_issue',
});

/** Names that look like workflows but are validation steps (C023/C028 note). */
const NON_WORKFLOW_NAMES = new Set([
  'run_tests',
  'static_analysis',
  'integration_tests',
  'dependency_check',
]);

export type WorkflowIdResult =
  | {
      readonly outcome: 'RESOLVED';
      readonly workflowId: WorkflowIdV1;
      readonly viaAlias?: string | undefined;
    }
  | { readonly outcome: 'UNKNOWN'; readonly input: string }
  | { readonly outcome: 'NOT_A_WORKFLOW'; readonly input: string; readonly hint: string };

export function normalizeWorkflowId(input: string): WorkflowIdResult {
  const trimmed = input.trim();
  if (!trimmed) return { outcome: 'UNKNOWN', input };
  // Exact canonical IDs first.
  if ((WORKFLOW_IDS_V1 as readonly string[]).includes(trimmed)) {
    return { outcome: 'RESOLVED', workflowId: trimmed as WorkflowIdV1 };
  }
  if (NON_WORKFLOW_NAMES.has(trimmed)) {
    return {
      outcome: 'NOT_A_WORKFLOW',
      input,
      hint: `'${trimmed}' is a validation step/obligation name, not a standalone workflow`,
    };
  }
  // Case-sensitive alias lookup only — no case folding, no fuzzy matching.
  const alias = COMMAND_ALIASES_V1[trimmed];
  if (alias) return { outcome: 'RESOLVED', workflowId: alias, viaAlias: trimmed };
  return { outcome: 'UNKNOWN', input };
}

/**
 * CP001 §10/§18 — typed "unknown command" failure (`COMMAND_UNKNOWN`). Thrown
 * by `normalizeCommandId` when a client supplies a verb that is not a
 * canonical command and not a registered alias. Fail closed: the caller can
 * never fall back to a guessed workflow.
 */
export class CommandUnknownError extends Error {
  readonly code = 'COMMAND_UNKNOWN' as const;
  constructor(
    readonly rawInput: string,
    readonly hint?: string,
  ) {
    super(hint ? `Unknown command '${rawInput}': ${hint}` : `Unknown command '${rawInput}'`);
    this.name = 'CommandUnknownError';
  }
}

/**
 * CP001 §10 — resolve a client-supplied command reference to its canonical
 * workflow ID, or throw `CommandUnknownError`. Accepts exact canonical IDs and
 * every `COMMAND_ALIASES_V1` alias. Unknown / non-workflow names (`run_tests`)
 * and mixed-case inputs fail closed (`COMMAND_UNKNOWN`).
 */
export function normalizeCommandId(input: string): WorkflowIdV1 {
  const result = normalizeWorkflowId(input);
  if (result.outcome === 'RESOLVED') return result.workflowId;
  if (result.outcome === 'NOT_A_WORKFLOW') throw new CommandUnknownError(input, result.hint);
  throw new CommandUnknownError(input);
}

/** Registry version participates in dedupe keys and snapshot bindings. */
export const INVOCATION_REGISTRY_VERSION = 'invocation-registry@1';

// ---------------------------------------------------------------------------
// Trigger rules and manual commands (policy-configurable surface)
// ---------------------------------------------------------------------------

export const triggerFilter = z
  .object({
    /** Event matches if it carries ANY of these labels. */
    labelsAny: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** Branch/ref filters (exact, canonical form). */
    branchesAny: z.array(z.string().min(1).max(256)).max(16).optional(),
    /** Check-conclusion filter for check_run.completed rules. */
    conclusionsAny: z
      .array(z.enum(['success', 'failure', 'cancelled', 'timed_out']))
      .max(4)
      .optional(),
    /** Pull-request origin filter. */
    prOrigin: z.enum(['fork', 'same_repository']).optional(),
  })
  .strict();

export type TriggerFilter = z.output<typeof triggerFilter>;

export interface TriggerRule {
  readonly ruleId: string;
  readonly eventTrigger: TriggerIdV1;
  readonly workflowId: WorkflowIdV1;
  readonly filter?: TriggerFilter | undefined;
  readonly enabled: boolean;
  readonly maxFanOut: number;
  readonly cooldownSeconds: number;
}

export interface ManualCommandDefinition {
  readonly workflowId: WorkflowIdV1;
  /** Versioned input-schema identifier exposed to C069/C080. */
  readonly inputSchemaId: string;
  readonly available: boolean;
  /** Manual invocations per hour per repository+actor. */
  readonly rateLimitPerHour: number;
}

/** Initial manual command catalog — availability may be feature-flagged off. */
export const MANUAL_COMMANDS_V1: readonly ManualCommandDefinition[] = Object.freeze([
  {
    workflowId: 'implement_issue',
    inputSchemaId: 'input.implement-issue@1',
    available: true,
    rateLimitPerHour: 10,
  },
  {
    workflowId: 'diagnose_failure',
    inputSchemaId: 'input.diagnose-failure@1',
    available: true,
    rateLimitPerHour: 20,
  },
  {
    workflowId: 'security_audit',
    inputSchemaId: 'input.security-audit@1',
    available: true,
    rateLimitPerHour: 6,
  },
  {
    workflowId: 'security_patch',
    inputSchemaId: 'input.security-patch@1',
    available: true,
    rateLimitPerHour: 6,
  },
  {
    workflowId: 'dependency_upgrade',
    inputSchemaId: 'input.dependency-upgrade@1',
    available: true,
    rateLimitPerHour: 4,
  },
  {
    workflowId: 'review_remediation',
    inputSchemaId: 'input.review-remediation@1',
    available: true,
    rateLimitPerHour: 12,
  },
  {
    workflowId: 'repository_health_check',
    inputSchemaId: 'input.repository-health@1',
    available: true,
    rateLimitPerHour: 4,
  },
  {
    workflowId: 'manual_refactor',
    inputSchemaId: 'input.manual-refactor@1',
    available: true,
    rateLimitPerHour: 4,
  },
]);
