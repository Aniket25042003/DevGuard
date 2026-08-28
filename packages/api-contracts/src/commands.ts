/**
 * CP001 — Shared command contract for the three client surfaces
 * (Web, CLI, GitHub `@devguard` comments).
 *
 * Freezes the ONLY vocabulary clients may use: canonical command IDs, human
 * aliases, origin surfaces, and the transport DTOs exchanged with /api/v1.
 *
 * Layering (CP001 §6): *domain* resolution of aliases → canonical workflow IDs
 * lives in `@devguard/policy-engine` (`COMMAND_ALIASES_V1` / `normalizeCommandId`).
 * This module defines the *transport* shapes and the canonical-command enum
 * those DTOs carry, plus the status vocabulary reused from `@devguard/contracts`
 * (single source for the frozen workflow-status enum).
 *
 * After this contract freezes, Web, CLI and GitHub parsers must NOT invent new
 * verbs. Alias resolution is pure and fail-closed: unknown / mixed-case verbs
 * never resolve to a workflow.
 *
 * Invariants:
 * - `.strict()` on every boundary object — extra properties are rejected.
 * - One alias maps to exactly one canonical command (enforced in policy-engine).
 * - `originSurface` is server-authoritative on the wire: HTTP/CLI clients must
 *   NOT present `github_comment`/`github_event` (server returns `ORIGIN_FORGED`,
 *   CP006); `.strict()` in the schema is the minimum boundary guard.
 */
import { z } from 'zod';
import { schemas, timestampIso, WorkflowStatus } from '@devguard/contracts';

/** CP001 §19/§21 — registry version used in list ETags and dedupe bindings. */
export const COMMAND_CONTRACT_VERSION = 'command-contract.v1';

// ---------------------------------------------------------------------------
// Origin surfaces (CP001 §8; locked decision: the server sets origin)
// ---------------------------------------------------------------------------

export const ORIGIN_SURFACES_V1 = [
  'web',
  'cli',
  'github_comment',
  'github_event',
  'schedule',
] as const;
export type OriginSurface = (typeof ORIGIN_SURFACES_V1)[number];
export const originSurfaceSchema = z.enum(ORIGIN_SURFACES_V1);

// ---------------------------------------------------------------------------
// Canonical command IDs (CP001 §8)
// ---------------------------------------------------------------------------

export const COMMAND_IDS_V1 = [
  'implement_issue',
  'diagnose_failure',
  'security_audit',
  'security_patch',
  'review_remediation',
  'dependency_upgrade', // extension — advertise only if feature-enabled
  'repository_health_check', // extension
  'manual_refactor', // extension
] as const;
export type CanonicalCommandId = (typeof COMMAND_IDS_V1)[number];
export const canonicalCommandIdSchema = z.enum(COMMAND_IDS_V1);

/**
 * CP001 §25 — MVP advertised commands. The three extension workflows are
 * marked `mvp: false` and must not be advertised unless feature flags allow.
 */
export const MVP_COMMAND_IDS_V1 = [
  'implement_issue',
  'diagnose_failure',
  'security_audit',
  'security_patch',
  'review_remediation',
] as const satisfies readonly CanonicalCommandId[];

export const commandMvpFlags: Readonly<Record<CanonicalCommandId, { readonly mvp: boolean }>> =
  Object.freeze({
    implement_issue: Object.freeze({ mvp: true }),
    diagnose_failure: Object.freeze({ mvp: true }),
    security_audit: Object.freeze({ mvp: true }),
    security_patch: Object.freeze({ mvp: true }),
    review_remediation: Object.freeze({ mvp: true }),
    dependency_upgrade: Object.freeze({ mvp: false }),
    repository_health_check: Object.freeze({ mvp: false }),
    manual_refactor: Object.freeze({ mvp: false }),
  });

/**
 * CP001 §8 / gap G25 — trigger types a run may carry. `schedule` is included
 * (the domain `TriggerKind` in `@devguard/contracts` is `manual|webhook|api`
 * and gains `schedule` in CP016; transport keeps the four-value vocabulary).
 */
export const TRIGGER_TYPES_V1 = ['manual', 'webhook', 'api', 'schedule'] as const;
export type TriggerTypeV1 = (typeof TRIGGER_TYPES_V1)[number];
export const triggerTypeSchema = z.enum(TRIGGER_TYPES_V1);

// ---------------------------------------------------------------------------
// Transport DTOs (CP001 §8; field names follow C067/C069 where possible)
// ---------------------------------------------------------------------------

/**
 * CP001 §8 — GitHub scoping carried by a comment/webhook-initiated command.
 * Present only for `github_comment` / `github_event` requests and set by the
 * server, never trusted from the client.
 */
export const commandGithubRefSchema = z
  .object({
    installationId: z.string().min(1).max(128),
    repositoryNodeId: z.string().min(1).max(256).optional(),
    issueOrPrNumber: z.number().int().positive(),
    commentId: z.string().min(1).max(128).optional(),
    htmlUrl: z.string().url().max(2048).optional(),
  })
  .strict();
export type CommandGithubRef = z.infer<typeof commandGithubRefSchema>;

/**
 * CP001 §8 / C069 — request body for `POST .../repositories/{id}/commands`.
 * `commandId` may be a canonical ID or a registered alias string (the server
 * normalizes through `normalizeCommandId`; unknowns fail closed). `input` is
 * discriminated by `commandId` and validated by the owning workflow registry.
 */
export const submitCommandRequestSchema = z
  .object({
    commandId: z.union([canonicalCommandIdSchema, z.string().min(1).max(80)]),
    definitionVersion: z.string().min(1).max(64),
    input: z.unknown(),
    clientReference: z.string().min(1).max(100).optional(),
    originSurface: originSurfaceSchema,
    github: commandGithubRefSchema.optional(),
  })
  .strict();
export type SubmitCommandRequestV1 = z.infer<typeof submitCommandRequestSchema>;

/** CP001 §8 / C069 — durable async acceptance receipt (`202`). */
export const commandReceiptSchema = z
  .object({
    id: schemas.workflowRunId,
    repositoryId: schemas.repositoryId,
    commandId: canonicalCommandIdSchema,
    originSurface: originSurfaceSchema,
    status: z.literal('accepted'),
    workflowRunId: schemas.workflowRunId,
    createdAt: timestampIso,
    links: z
      .object({
        run: z.string().min(1).max(2048),
        self: z.string().min(1).max(2048),
      })
      .strict(),
  })
  .strict();
export type CommandReceiptV1 = z.infer<typeof commandReceiptSchema>;

/**
 * CP001 §8 / C067 §8 — projected workflow run returned by start/list/get.
 * Field names follow C067's `WorkflowRunDto`; `workflowType` carries the
 * canonical command ID and `trigger` carries the four-value trigger type plus
 * the origin surface (CP016 persists `origin_surface`).
 */
export const workflowRunDtoSchema = z
  .object({
    id: schemas.workflowRunId,
    repositoryId: schemas.repositoryId,
    workflowType: canonicalCommandIdSchema,
    definitionVersion: z.string().min(1).max(64),
    status: WorkflowStatus,
    trigger: z
      .object({
        triggerType: triggerTypeSchema,
        originSurface: originSurfaceSchema,
      })
      .strict(),
    requestSummary: z.string().max(4000).optional(),
    policyVersion: z.number().int().nonnegative().optional(),
    sessionId: z.string().min(1).max(128).optional(),
    branchName: z.string().max(256).optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    queuePosition: z.number().int().nonnegative().optional(),
    startedAt: timestampIso.optional(),
    completedAt: timestampIso.optional(),
    failure: z.string().max(2000).optional(),
    createdAt: timestampIso,
    updatedAt: timestampIso,
    version: z.number().int().nonnegative(),
    links: z
      .object({
        self: z.string().min(1).max(2048),
      })
      .strict(),
  })
  .strict();
export type WorkflowRunDtoV1 = z.infer<typeof workflowRunDtoSchema>;

/**
 * CP001 §8 / C067 §11 — list filter for `GET .../repositories/{id}/workflows`
 * and `GET .../runs`. `originSurface` and `triggerType` filter independently;
 * `triggerSource` is the deprecated OpenAPI alias of `originSurface` (C079).
 */
const workflowStatusFilterSchema = z
  .string()
  .max(256)
  .refine(
    (value) => value.split(',').every((status) => WorkflowStatus.options.includes(status as never)),
    'expected comma-separated workflow statuses',
  );

const positiveQueryIntegerSchema = z.preprocess(
  (value) =>
    typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value,
  z.number().int().positive(),
);

export const workflowRunListQuerySchema = z
  .object({
    originSurface: originSurfaceSchema.optional(),
    triggerSource: originSurfaceSchema.optional(),
    triggerType: triggerTypeSchema.optional(),
    status: workflowStatusFilterSchema.optional(),
    workflowType: canonicalCommandIdSchema.optional(),
    pullRequestNumber: positiveQueryIntegerSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (query.originSurface !== undefined && query.triggerSource !== undefined && query.originSurface !== query.triggerSource) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['triggerSource'], message: 'conflicts with originSurface' });
    }
  });
export type WorkflowRunListQueryV1 = z.infer<typeof workflowRunListQuerySchema>;
