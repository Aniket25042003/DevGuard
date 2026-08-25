/**
 * C004 — Versioned event envelope and registry.
 *
 * Invariants:
 * - Every event carries a globally unique id, schema version, aggregate scope,
 *   optional monotonic sequence, correlation, and actor. Order is NEVER
 *   inferred from timestamps when a sequence exists.
 * - The registry maps exact `type@version` to one payload schema. Unknown
 * *types or versions fail closed (quarantine upstream), never default-allow.
 * - Payload schemas are forward-compatible within schemaVersion 1: unknown
 *   keys are stripped on read. Breaking changes require schemaVersion 2.
 */
import { z } from 'zod';
import { correlation } from './context.js';
import type { CorrelationShape, ActorRefShape } from './context.js';
import { boundedText, schemas, sequence, timestampIso } from './primitives.js';
import { StepStatus, WorkflowStatus } from './workflows.js';
import { actorRef } from './context.js';

export const EVENT_SCHEMA_VERSION = 1 as const;

export interface EventAggregateShape {
  readonly type: string;
  readonly id: string;
}

export const eventEnvelopeBase = z.object({
  id: schemas.eventId,
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  aggregate: z
    .object({
      type: z.string().min(1).max(64),
      id: z.string().min(1).max(128),
    })
    .strict(),
  sequence: sequence.optional(),
  occurredAt: timestampIso,
  correlation: correlation,
  actor: actorRef,
});

/** Registry entry: exact payload schema for one event type at v1. */
export interface RegisteredEvent {
  readonly family:
    | 'configuration'
    | 'authorization'
    | 'repository'
    | 'workflow'
    | 'session'
    | 'action'
    | 'policy'
    | 'approval'
    | 'validation'
    | 'artifact'
    | 'webhook'
    | 'outbox'
    | 'audit';
  readonly description: string;
  readonly payload: z.ZodType<unknown>;
}

const registry = new Map<string, RegisteredEvent>();

/** Register an event type; duplicate registration with different schema fails. */
export function registerEvent(type: string, entry: RegisteredEvent): void {
  const existing = registry.get(type);
  if (existing && existing.payload !== entry.payload) {
    throw new TypeError(`Event type '${type}' is already registered.`);
  }
  registry.set(type, entry);
}

export function getRegisteredEvent(type: string): RegisteredEvent | undefined {
  return registry.get(type);
}

export function listRegisteredEventTypes(): readonly string[] {
  return [...registry.keys()].sort();
}

// ---------------------------------------------------------------------------
// Foundation registrations (payloads kept intentionally small and additive).
// ---------------------------------------------------------------------------

registerEvent('configuration.validated', {
  family: 'configuration',
  description: 'A process validated its startup configuration.',
  payload: z
    .object({
      processKind: z.enum(['api', 'worker', 'web']),
      environment: z.enum(['development', 'test', 'production']),
      configHash: z.string().max(128),
    })
    .strip(),
});

registerEvent('feature_flag.changed', {
  family: 'configuration',
  description: 'A feature flag evaluation changed relative to code default.',
  payload: z
    .object({
      key: z.string().min(1).max(128),
      value: z.boolean(),
    })
    .strip(),
});

registerEvent('authorization.allowed', {
  family: 'authorization',
  description: 'Repository-scoped authorization succeeded.',
  payload: z
    .object({
      repositoryId: schemas.repositoryId,
      permission: z.string().min(1).max(64),
      userId: schemas.userId.optional(),
    })
    .strip(),
});

registerEvent('authorization.denied', {
  family: 'authorization',
  description: 'Repository-scoped authorization denied.',
  payload: z
    .object({
      repositoryId: schemas.repositoryId,
      permission: z.string().min(1).max(64),
      reasonCode: z.string().min(1).max(64),
      userId: schemas.userId.optional(),
    })
    .strip(),
});

registerEvent('repository.connected', {
  family: 'repository',
  description: 'A repository was connected to an installation.',
  payload: z
    .object({
      fullName: z.string().min(3).max(201),
      status: z.enum(['pending', 'active', 'degraded', 'disconnected']),
    })
    .strip(),
});

registerEvent('repository.disconnected', {
  family: 'repository',
  description: 'A repository was disconnected from its installation.',
  payload: z
    .object({
      reasonCode: z.string().min(1).max(64).optional(),
    })
    .strip(),
});

registerEvent('workflow.queued', {
  family: 'workflow',
  description: 'A workflow run was accepted and queued durably.',
  payload: z
    .object({
      repositoryId: schemas.repositoryId,
      trigger: z.enum(['manual', 'webhook', 'api']),
      requestedBy: z.string().max(128).optional(),
    })
    .strip(),
});

registerEvent('workflow.state.changed', {
  family: 'workflow',
  description: 'Workflow run status transitioned.',
  payload: z
    .object({
      from: WorkflowStatus,
      to: WorkflowStatus,
      reasonCode: z.string().max(64).optional(),
    })
    .strip(),
});

registerEvent('step.state.changed', {
  family: 'workflow',
  description: 'Workflow step status transitioned.',
  payload: z
    .object({
      from: StepStatus,
      to: StepStatus,
      attempt: z.number().int().nonnegative().optional(),
    })
    .strip(),
});

registerEvent('action.proposed', {
  family: 'action',
  description: 'An agent or user proposed an operation; awaiting governance.',
  payload: z
    .object({
      actionType: z.string().min(1).max(64),
      riskClass: z.enum([
        'read',
        'reversible_write',
        'sensitive_write',
        'destructive',
        'external_side_effect',
      ]),
      toolName: z.string().max(128).optional(),
    })
    .strip(),
});

registerEvent('policy.decision.recorded', {
  family: 'policy',
  description: 'A deterministic policy decision was persisted before execution.',
  payload: z
    .object({
      effect: z.enum(['ALLOW', 'REQUIRE_APPROVAL', 'DENY']),
      reasonCode: z.string().min(1).max(128),
      policyVersionRef: z.string().max(128).optional(),
    })
    .strip(),
});

for (const suffix of [
  'required',
  'requested',
  'approved',
  'rejected',
  'expired',
  'stale',
] as const) {
  const extra =
    suffix === 'expired' || suffix === 'stale'
      ? { reasonCode: z.string().min(1).max(64) }
      : { resolvedByUserId: schemas.userId.optional() };
  registerEvent(`approval.${suffix}`, {
    family: 'approval',
    description: `Approval lifecycle: ${suffix}.`,
    payload: z.object(extra).strip(),
  });
}

registerEvent('artifact.created', {
  family: 'artifact',
  description: 'Checksummed artifact metadata recorded.',
  payload: z
    .object({
      classification: z.enum(['public', 'internal', 'restricted']),
      checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
      contentType: z.string().max(128),
    })
    .strip(),
});

registerEvent('validation.completed', {
  family: 'validation',
  description: 'A validator finished against an exact commit state.',
  payload: z
    .object({
      validator: z.string().min(1).max(64),
      commitSha: z.string().regex(/^[0-9a-f]{40}$/),
      status: z.enum(['passed', 'failed', 'skipped', 'blocked']),
    })
    .strip(),
});

for (const suffix of ['accepted', 'routed', 'rejected'] as const) {
  registerEvent(`webhook.${suffix}`, {
    family: 'webhook',
    description: `Webhook ingress outcome: ${suffix}.`,
    payload: z
      .object({
        deliveryExternalId: z.string().max(128).optional(),
        eventFamily: z.string().max(64).optional(),
        reasonCode: z.string().max(64).optional(),
      })
      .strip(),
  });
}

registerEvent('outbox.recorded', {
  family: 'outbox',
  description: 'Publishable intent committed atomically with a domain transition.',
  payload: z
    .object({
      eventType: z.string().min(1).max(128),
      destination: z.enum(['queue', 'stream']),
    })
    .strip(),
});

// ---------------------------------------------------------------------------
// Envelope construction and parsing
// ---------------------------------------------------------------------------

export interface EventEnvelopeShape<P = unknown> extends Omit<
  z.infer<typeof eventEnvelopeBase>,
  'correlation' | 'actor'
> {
  readonly type: string;
  readonly aggregate: EventAggregateShape;
  readonly correlation: CorrelationShape;
  readonly actor: ActorRefShape;
  readonly payload: P;
}

export const unsupportedEventSymbol = Symbol('unsupported-event');

export type ParsedEvent =
  | { readonly ok: true; readonly type: string; readonly value: EventEnvelopeShape }
  | {
      readonly ok: false;
      readonly reason: 'unknown_type' | 'unknown_version' | 'invalid_envelope' | 'invalid_payload';
      readonly issues?: readonly z.core.$ZodIssue[] | undefined;
    };

/**
 * Parse and validate an untrusted envelope against the registry.
 * Unknown types/versions fail closed with a quarantine reason — no defaults.
 */
export function parseEvent(input: unknown): ParsedEvent {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  const candidate = input as Record<string, unknown>;
  const baseResult = eventEnvelopeBase.safeParse(candidate);
  if (!baseResult.success) {
    return { ok: false, reason: 'invalid_envelope', issues: baseResult.error.issues };
  }
  const type = typeof candidate['type'] === 'string' ? candidate['type'] : '';
  if (!type || !/^[\w.]{3,128}$/.test(type)) {
    return { ok: false, reason: 'unknown_type' };
  }
  const registered = getRegisteredEvent(type);
  if (!registered) {
    return { ok: false, reason: 'unknown_type' };
  }
  const payloadResult = registered.payload.safeParse(candidate['payload']);
  if (!payloadResult.success) {
    return { ok: false, reason: 'invalid_payload', issues: payloadResult.error.issues };
  }
  return {
    ok: true,
    type,
    value: {
      ...baseResult.data,
      type,
      payload: payloadResult.data,
    },
  };
}

export interface MakeEventInput {
  readonly type: string;
  readonly aggregate: EventAggregateShape;
  readonly occurredAt: string;
  readonly correlation?: CorrelationShape | undefined;
  readonly actor: ActorRefShape;
  readonly sequence?: number | undefined;
  readonly payload: unknown;
}

/** Build a validatable envelope; throws when the type is unregistered. */
export function makeEvent(input: MakeEventInput): EventEnvelopeShape {
  const registered = getRegisteredEvent(input.type);
  if (!registered) {
    throw new TypeError(`Cannot build unregistered event '${input.type}'.`);
  }
  const payload = registered.payload.parse(input.payload);
  return {
    id: schemas.eventId.parse(crypto.randomUUID()),
    schemaVersion: EVENT_SCHEMA_VERSION,
    type: input.type,
    aggregate: input.aggregate,
    sequence: input.sequence,
    occurredAt: timestampIso.parse(input.occurredAt),
    correlation: input.correlation ?? {},
    actor: actorRef.parse(input.actor),
    payload,
  };
}

export { boundedText };
