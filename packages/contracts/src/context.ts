/**
 * C004 — Actor, correlation, provenance, and data classification.
 *
 * Every privileged record answers WHO, WHERE (correlation), and WHERE FROM
 * (provenance) explicitly. Webhook actors are event metadata, never
 * authenticated DevGuard users; the kind discriminator keeps that honest.
 */
import { z } from 'zod';
import { schemas, timestampIso } from './primitives.js';

export const ActorKind = z.enum(['user', 'github_app', 'agent', 'system', 'webhook_actor']);
export type ActorKind = z.infer<typeof ActorKind>;

export interface ActorRefShape {
  readonly kind: z.infer<typeof ActorKind>;
  readonly id?: string | undefined;
  /** Display login/name for evidence views; never used as authorization. */
  readonly displayName?: string | undefined;
}

export const actorRef: z.ZodType<ActorRefShape> = z
  .object({
    kind: ActorKind,
    id: z.string().max(128).optional(),
    displayName: z.string().max(256).optional(),
  })
  .strip();

/** Correlation identifiers linking records across request/run/session/action scopes. */
export interface CorrelationShape {
  readonly requestId?: string | undefined;
  readonly runId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly causeEventId?: string | undefined;
  readonly deliveryId?: string | undefined;
}

export const correlation: z.ZodType<CorrelationShape> = z
  .object({
    requestId: schemas.operationKey.optional(),
    runId: schemas.workflowRunId.optional(),
    sessionId: schemas.agentSessionRefId.optional(),
    actionId: schemas.actionId.optional(),
    causeEventId: schemas.eventId.optional(),
    deliveryId: schemas.deliveryId.optional(),
  })
  .strip();

/**
 * Provenance of externally captured data. Provider references stay normalized
 * (`ExternalRef`), never raw SDK payloads.
 */
export const ProvenanceSource = z.enum(['github', 'trueforge', 'devguard', 'scanner']);
export type ProvenanceSource = z.infer<typeof ProvenanceSource>;

export interface ExternalRefShape {
  readonly provider: 'github';
  readonly type:
    | 'repository'
    | 'issue'
    | 'pull_request'
    | 'branch'
    | 'commit'
    | 'check_run'
    | 'review'
    | 'review_comment'
    | 'issue_comment';
  /** Provider-native opaque identifier as string (numeric GitHub ids stringified). */
  readonly id: string;
  readonly node_id?: string | undefined;
  readonly url?: string | undefined;
}

/** Concrete (non-annotated) schema so other modules can reuse `.shape`. */
export const externalRefSchema = z
  .object({
    provider: z.literal('github'),
    type: z.enum([
      'repository',
      'issue',
      'pull_request',
      'branch',
      'commit',
      'check_run',
      'review',
      'review_comment',
      'issue_comment',
    ]),
    id: z.string().min(1).max(128),
    node_id: z.string().max(256).optional(),
    url: z.string().url().max(512).optional(),
  })
  .strict();

export const externalRef: z.ZodType<ExternalRefShape> = externalRefSchema;

export interface ProvenanceShape {
  readonly source: ProvenanceSource;
  readonly externalRef?: ExternalRefShape | undefined;
  readonly capturedAt: z.infer<typeof timestampIso>;
}

export const provenance: z.ZodType<ProvenanceShape> = z
  .object({
    source: ProvenanceSource,
    externalRef: externalRef.optional(),
    capturedAt: timestampIso,
  })
  .strip();

/** Data classification carried by artifacts, events, and projections. */
export const DataClassification = z.enum(['public', 'internal', 'restricted']);
export type DataClassification = z.infer<typeof DataClassification>;

// Re-exported so context consumers can validate ids without deep imports.
export { schemas };
