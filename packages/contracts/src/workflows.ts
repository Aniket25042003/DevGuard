/**
 * C004 — Workflow and agent-session contracts.
 *
 * Legal status sets are frozen here (IF-1); owning components supply transition
 * functions. Statuses are lowercase; approval resolution is approval state, not
 * a workflow status (PRD review A-22).
 */
import { z } from 'zod';
import { externalRefSchema } from './context.js';
import type { ActorKind } from './context.js';
import type { ExternalRefShape } from './context.js';
import { rowVersion, schemas, timestampIso } from './primitives.js';
import type { ValidationResultShape } from './evidence.js';

export const WorkflowStatus = z.enum([
  'queued',
  'running',
  'waiting_for_approval',
  'resuming',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'timed_out',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatus>;

export const WORKFLOW_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'timed_out',
] as const;
export type WorkflowTerminalStatus = (typeof WORKFLOW_TERMINAL_STATUSES)[number];

export const StepStatus = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);
export type StepStatus = z.infer<typeof StepStatus>;

/** Canonical workflow identifiers (A-12). Extensions add their own later. */
export const WorkflowKind = z.enum([
  'implement_issue',
  'diagnose_failure',
  'security_audit',
  'security_patch',
  'review_remediation',
]);
export type WorkflowKind = z.infer<typeof WorkflowKind>;

export const TriggerKind = z.enum(['manual', 'webhook', 'api']);
export type TriggerKind = z.infer<typeof TriggerKind>;

export interface WorkflowRunShape {
  readonly id: string;
  readonly repositoryId: string;
  readonly workflowId: string;
  readonly trigger: TriggerKind;
  readonly requestedBy: {
    readonly kind: z.infer<typeof ActorKind>;
    readonly id?: string | undefined;
  };
  readonly status: WorkflowStatus;
  /** Durable cancellation generation; stale jobs compare before side effects. */
  readonly cancellationGeneration: number;
  readonly sessionRef?:
    | {
        readonly sessionId: string;
        readonly lastSequence: number;
      }
    | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rowVersion: number;
}

const ActorKindSchema = z.enum(['user', 'github_app', 'agent', 'system', 'webhook_actor']);

export const workflowRun: z.ZodType<WorkflowRunShape> = z
  .object({
    id: schemas.workflowRunId,
    repositoryId: schemas.repositoryId,
    workflowId: schemas.workflowDefinitionId,
    trigger: TriggerKind,
    requestedBy: z
      .object({
        kind: ActorKindSchema,
        id: z.string().max(128).optional(),
      })
      .strip(),
    status: WorkflowStatus,
    cancellationGeneration: z.number().int().nonnegative(),
    sessionRef: z
      .object({
        sessionId: schemas.agentSessionRefId,
        lastSequence: z.number().int().nonnegative(),
      })
      .strip()
      .optional(),
    createdAt: timestampIso,
    updatedAt: timestampIso,
    rowVersion: rowVersion,
  })
  .strip();

/** Structured completion evidence — model "done" is never sufficient (WF-10). */
export type WorkflowProductOutcome =
  | 'fixed'
  | 'not_fixed'
  | 'inconclusive'
  | 'superseded'
  | 'blocked';

export interface WorkflowCompletionShape {
  readonly status: 'success' | 'partial' | 'blocked' | 'failed';
  /** Product-specific terminal result preserved by the completion adapter. */
  readonly outcome?: WorkflowProductOutcome | undefined;
  readonly summary: string;
  readonly artifactIds: readonly string[];
  readonly validations: readonly ValidationResultShape[];
  readonly pullRequest?: (ExternalRefShape & { readonly type: 'pull_request' }) | undefined;
  readonly pendingApprovalId?: string | undefined;
}

export const workflowCompletion: z.ZodType<WorkflowCompletionShape> = z
  .object({
    status: z.enum(['success', 'partial', 'blocked', 'failed']),
    outcome: z.enum(['fixed', 'not_fixed', 'inconclusive', 'superseded', 'blocked']).optional(),
    summary: z.string().min(1).max(4_000),
    artifactIds: z.array(schemas.artifactId).max(256),
    validations: z.array(z.lazy(() => validationResult)).max(256),
    // Narrowed discriminator: this field names one specific provider entity.
    pullRequest: externalRefSchema
      .extend({ type: z.literal('pull_request') })
      .strict()
      .optional(),
    pendingApprovalId: schemas.approvalId.optional(),
  })
  .strip();

/** Normalized TrueForge runtime reference (adapter fills after verification). */
export interface AgentSessionRefShape {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly providerSessionId: string;
  readonly currentTurnId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly lastSequence: number;
  readonly runtimeStatus: 'connecting' | 'active' | 'paused' | 'ended' | 'lost';
}

export const agentSessionRef: z.ZodType<AgentSessionRefShape> = z
  .object({
    id: schemas.agentSessionRefId,
    runId: schemas.workflowRunId.optional(),
    providerSessionId: z.string().min(1).max(256),
    currentTurnId: schemas.turnRefId.optional(),
    threadId: z.string().max(256).optional(),
    lastSequence: z.number().int().nonnegative(),
    runtimeStatus: z.enum(['connecting', 'active', 'paused', 'ended', 'lost']),
  })
  .strip();

// Imported late to keep evidence types independent of workflow ordering.
import { validationResult } from './evidence.js';
export type { ValidationResultShape };
