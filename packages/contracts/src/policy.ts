/**
 * C004 — Policy and action contracts.
 *
 * Canonical action taxonomy: every tool maps to exactly one registered action
 * type; unknown values fail validation (fail closed). Authorization effect has
 * exactly three values — sandbox placement is an OBLIGATION attached to a
 * decision, never a fourth permission effect (PRD review A-05).
 */
import { z } from 'zod';
import { timestampIso } from './primitives.js';
import { ActorKind } from './context.js';

/** Stable action identifiers. New tools register here before they can run. */
export const ActionType = z.enum([
  // Reads
  'repository.read',
  'issue.read',
  'file.read',
  'check.read',
  'review.read',
  'session.stream.read',
  // Reversible writes
  'branch.create',
  'commit.push',
  'pull_request.create',
  'pull_request.update',
  'comment.create',
  // Sensitive writes
  'pull_request.merge',
  'workflow_file.write',
  // Destructive
  'branch.delete',
  'repository.file.delete',
  // External side effects
  'sandbox.command',
  'artifact.store',
  'notification.send',
]);
export type ActionType = z.infer<typeof ActionType>;

export const RiskClass = z.enum([
  'read',
  'reversible_write',
  'sensitive_write',
  'destructive',
  'external_side_effect',
]);
export type RiskClass = z.infer<typeof RiskClass>;

export const AutonomyLevel = z.enum(['assist', 'developer', 'trusted', 'autonomous']);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

/** The only three authorization effects. */
export const PolicyEffect = z.enum(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

export const ExecutionEnvironment = z.enum(['sandbox_required', 'devguard_service']);
export type ExecutionEnvironment = z.infer<typeof ExecutionEnvironment>;

/** Obligations/constraints attached to a decision (PRD POL-07). */
export const Obligation = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('execution_environment'), environment: ExecutionEnvironment })
    .strict(),
  z
    .object({
      kind: z.literal('network_policy'),
      mode: z.enum(['default_deny', 'allowlist']),
      allowlist: z.array(z.string().max(253)).max(64).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('timeout_ms'), value: z.number().int().min(1_000).max(3_600_000) })
    .strict(),
  z
    .object({
      kind: z.literal('resource_ceiling'),
      cpuCores: z.number().int().min(1).max(64).optional(),
      memoryMb: z.number().int().min(128).max(65_536).optional(),
      diskMb: z.number().int().min(64).max(262_144).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('secret_grant'), names: z.array(z.string().max(128)).max(32) })
    .strict(),
]);
export type Obligation = z.infer<typeof Obligation>;

/** Deterministic policy evaluation result persisted BEFORE execution (POL-06). */
export interface PolicyDecisionShape {
  readonly effect: PolicyEffect;
  readonly reasonCode: string;
  readonly obligations: readonly Obligation[];
  /** Approval class demanded when effect is REQUIRE_APPROVAL. */
  readonly approvalType?: 'standard' | 'privileged_merge' | 'destructive' | undefined;
  readonly evaluatedAt: string;
}

export const policyDecisionShape: z.ZodType<PolicyDecisionShape> = z
  .object({
    effect: PolicyEffect,
    reasonCode: z.string().min(1).max(128),
    obligations: z.array(Obligation).max(16),
    approvalType: z.enum(['standard', 'privileged_merge', 'destructive']).optional(),
    evaluatedAt: timestampIso,
  })
  .strip()
  .refine((value) => !(value.effect === 'REQUIRE_APPROVAL') || value.approvalType !== undefined, {
    message: 'REQUIRE_APPROVAL decisions must carry an approvalType',
    path: ['approvalType'],
  });

/** Proposed action awaiting classification/evaluation (the choke-point input). */
export interface ActionProposalShape {
  readonly actionType: ActionType;
  readonly riskClass: RiskClass;
  readonly actorKind: ActorKind;
  readonly targetRef?:
    | {
        readonly repositoryExternalId?: string | undefined;
        readonly branchName?: string | undefined;
        readonly pullRequestNumber?: number | undefined;
        readonly baseSha?: string | undefined;
        readonly headSha?: string | undefined;
      }
    | undefined;
  readonly proposedAt: string;
}

const shaPattern = /^[0-9a-f]{40}$/;

export const actionProposal: z.ZodType<ActionProposalShape> = z
  .object({
    actionType: ActionType,
    riskClass: RiskClass,
    actorKind: ActorKind,
    targetRef: z
      .object({
        repositoryExternalId: z.string().max(128).optional(),
        branchName: z.string().max(256).optional(),
        pullRequestNumber: z.number().int().positive().max(10_000_000).optional(),
        baseSha: z.string().regex(shaPattern).optional(),
        headSha: z.string().regex(shaPattern).optional(),
      })
      .strict()
      .optional(),
    proposedAt: timestampIso,
  })
  .strip();

/** Registry entry binding one tool to one action (C024 owns persistence). */
export interface ToolBindingShape {
  readonly toolName: string;
  readonly provider: 'trueforge_mcp' | 'github_adapter' | 'sandbox';
  readonly actionType: ActionType;
  readonly riskClass: RiskClass;
  readonly enabled: boolean;
}

export const toolBinding: z.ZodType<ToolBindingShape> = z
  .object({
    toolName: z.string().min(1).max(128),
    provider: z.enum(['trueforge_mcp', 'github_adapter', 'sandbox']),
    actionType: ActionType,
    riskClass: RiskClass,
    enabled: z.boolean(),
  })
  .strip();
