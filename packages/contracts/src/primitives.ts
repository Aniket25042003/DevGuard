/**
 * C004 — Branded primitives.
 *
 * Opaque branded identifiers prevent accidental interchange (a WorkflowRunId
 * is not an ApprovalId), while remaining plain strings on the wire. Timestamps
 * are ISO-8601 UTC strings. Schema versions are explicit integers.
 */
import { z } from 'zod';

export declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type InstallationId = Brand<string, 'InstallationId'>;
export type RepositoryId = Brand<string, 'RepositoryId'>;
export type PolicyVersionId = Brand<string, 'PolicyVersionId'>;
export type PolicyDecisionId = Brand<string, 'PolicyDecisionId'>;
export type WorkflowDefinitionId = Brand<string, 'WorkflowDefinitionId'>;
export type WorkflowRunId = Brand<string, 'WorkflowRunId'>;
export type WorkflowStepId = Brand<string, 'WorkflowStepId'>;
export type AgentSessionRefId = Brand<string, 'AgentSessionRefId'>;
export type TurnRefId = Brand<string, 'TurnRefId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type ValidationResultId = Brand<string, 'ValidationResultId'>;
export type SecurityFindingId = Brand<string, 'SecurityFindingId'>;
export type EventId = Brand<string, 'EventId'>;
export type DeliveryId = Brand<string, 'DeliveryId'>;
export type AuditRecordId = Brand<string, 'AuditRecordId'>;
export type OperationKey = Brand<string, 'OperationKey'>;

/** Canonical ID shape: lowercase UUID. Generation prefers UUIDv7 for sortability; ordering authority stays with explicit sequences. */
const ID_SCHEMA = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9a-f][0-9a-f-]{35}$|^[A-Za-z0-9]{26}$/, 'expected UUID or ULID shape');

function brandedSchema<B extends string>(): z.ZodType<Brand<string, B>> {
  return ID_SCHEMA.transform((value) => value as Brand<string, B>);
}

export const schemas = {
  userId: brandedSchema<'UserId'>(),
  installationId: brandedSchema<'InstallationId'>(),
  repositoryId: brandedSchema<'RepositoryId'>(),
  policyVersionId: brandedSchema<'PolicyVersionId'>(),
  policyDecisionId: brandedSchema<'PolicyDecisionId'>(),
  workflowDefinitionId: brandedSchema<'WorkflowDefinitionId'>(),
  workflowRunId: brandedSchema<'WorkflowRunId'>(),
  workflowStepId: brandedSchema<'WorkflowStepId'>(),
  agentSessionRefId: brandedSchema<'AgentSessionRefId'>(),
  turnRefId: brandedSchema<'TurnRefId'>(),
  actionId: brandedSchema<'ActionId'>(),
  approvalId: brandedSchema<'ApprovalId'>(),
  artifactId: brandedSchema<'ArtifactId'>(),
  validationResultId: brandedSchema<'ValidationResultId'>(),
  securityFindingId: brandedSchema<'SecurityFindingId'>(),
  eventId: brandedSchema<'EventId'>(),
  deliveryId: brandedSchema<'DeliveryId'>(),
  auditRecordId: brandedSchema<'AuditRecordId'>(),
  operationKey: brandedSchema<'OperationKey'>(),
} as const;

/** ISO-8601 UTC timestamp string. */
export type TimestampIso = Brand<string, 'TimestampIso'>;
export const timestampIso: z.ZodType<TimestampIso> = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)) && /T|Z|\+|-/.test(value),
    'expected ISO-8601 timestamp',
  )
  .transform((value) => value as TimestampIso);

/** Monotonic per-aggregate sequence for ordered streams (never a timestamp). */
export const sequence = z.number().int().nonnegative();

/** Optimistic concurrency token carried by persisted aggregates. */
export type RowVersion = Brand<number, 'RowVersion'>;
export const rowVersion: z.ZodType<RowVersion> = z
  .number()
  .int()
  .nonnegative()
  .transform((value) => value as RowVersion);

/**
 * Exhaustive switch helper: passing a never-checked member fails to compile.
 * Usage: `return exhaustiveMatch(status, { queued: () => …, … })`.
 */
export function exhaustiveMatch<T extends string, R>(
  value: NoInfer<T>,
  handlers: { readonly [K in T]: (value: Extract<T, K>) => R },
): R {
  return handlers[value](value as Extract<T, keyof typeof handlers>);
}

/** Bound for free-text fields so payloads stay bounded at boundaries. */
export const boundedText = (maxLength: number) => z.string().max(maxLength);
