/**
 * C036 — agent (runtime contract adapter) event catalog and envelope builder.
 *
 * The shared event registry (C004 contracts/src/events.ts) has a fixed family
 * union that predates the agent domain, so agent event types are declared HERE
 * with their payload schemas and validated through the canonical C004 envelope
 * before leaving this package. Composition root maps these to the outbox/queue;
 * consumers fail closed on unknown types.
 */
import {
  actorRef,
  correlation,
  eventEnvelopeBase,
  EVENT_SCHEMA_VERSION,
  idSchemas,
  registerEvent,
  timestampIso,
  type ActorRefShape,
  type CorrelationShape,
  type EventAggregateShape,
  type EventEnvelopeShape,
  type RegisteredEvent,
} from '@devguard/contracts';
import { z } from 'zod';
import { agentIdSchemas } from './ids.js';
import { COMPATIBILITY_STATUSES } from './compatibility.js';

export const AGENT_EVENT_TYPES = {
  capabilitiesVerified: 'agent.capabilities_verified.v1',
  contractIncompatible: 'agent.contract_incompatible.v1',
  unavailable: 'agent.unavailable.v1',
  contractDrift: 'agent.contract_drift.v1',
  verificationFailed: 'agent.verification_failed.v1',
} as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[keyof typeof AGENT_EVENT_TYPES];

const hexSha = z.string().regex(/^[0-9a-f]{64}$/);

const payloads: Record<AgentEventType, z.ZodType<unknown>> = {
  [AGENT_EVENT_TYPES.capabilitiesVerified]: z
    .object({
      snapshotId: agentIdSchemas.contractSnapshotId,
      verificationRunId: agentIdSchemas.verificationRunId,
      provider: z.string().min(1).max(64),
      serverVersion: z.string().min(1).max(128),
      status: z.enum(COMPATIBILITY_STATUSES),
      verifiedCapabilities: z.array(z.string().min(1).max(64)),
      checkedAt: timestampIso,
    })
    .strict(),
  [AGENT_EVENT_TYPES.contractIncompatible]: z
    .object({
      snapshotId: agentIdSchemas.contractSnapshotId,
      provider: z.string().min(1).max(64),
      serverVersion: z.string().min(1).max(128),
      missingMandatory: z.array(z.string().min(1).max(64)).default([]),
      fatalPresent: z.array(z.string().min(1).max(64)).default([]),
    })
    .strict(),
  [AGENT_EVENT_TYPES.unavailable]: z
    .object({
      provider: z.string().min(1).max(64),
      endpointIdentity: z.string().min(1).max(256),
      reason: z.string().max(200).optional(),
    })
    .strict(),
  [AGENT_EVENT_TYPES.contractDrift]: z
    .object({
      snapshotId: agentIdSchemas.contractSnapshotId,
      expectedDigest: hexSha,
      observedDigest: hexSha,
      reason: z.string().max(200),
    })
    .strict(),
  [AGENT_EVENT_TYPES.verificationFailed]: z
    .object({
      provider: z.string().min(1).max(64),
      endpointIdentity: z.string().min(1).max(256),
      errorCode: z.string().min(1).max(64),
      detailSanitized: z.string().max(400),
    })
    .strict(),
};

export const AGENT_EVENT_CATALOG: Readonly<
  Record<AgentEventType, { readonly description: string; readonly payload: z.ZodType<unknown> }>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(payloads).map(([type, payload]) => [
      type,
      { description: `Agent contract adapter event '${type}'.`, payload },
    ]),
  ) as Record<AgentEventType, { description: string; payload: z.ZodType<unknown> }>,
);

/**
 * C036 — register every agent event in the canonical C004 registry.
 *
 * Building agents with `makeAgentEvent` is not enough: canonical outbox/queue
 * consumers classify envelopes with `parseEvent`, which looks up the shared
 * `@devguard/contracts` registry and fails closed (`unknown_type`) on anything
 * unregistered. Registering here (module load, before any construction or
 * parsing) makes every emitted agent event valid under the registry consumers
 * actually use. Family groupings reflect the C004 taxonomy that predates the
 * agent domain; no contract file is edited.
 */
const AGENT_EVENT_FAMILY: Readonly<Record<AgentEventType, RegisteredEvent['family']>> =
  Object.freeze({
    [AGENT_EVENT_TYPES.capabilitiesVerified]: 'workflow',
    [AGENT_EVENT_TYPES.contractIncompatible]: 'workflow',
    [AGENT_EVENT_TYPES.unavailable]: 'workflow',
    [AGENT_EVENT_TYPES.contractDrift]: 'workflow',
    [AGENT_EVENT_TYPES.verificationFailed]: 'workflow',
  });

export function registerAgentEvents(): void {
  for (const type of Object.values(AGENT_EVENT_TYPES) as readonly AgentEventType[]) {
    const entry = AGENT_EVENT_CATALOG[type];
    if (entry === undefined) {
      throw new TypeError(`Agent event type '${type}' has no catalog schema.`);
    }
    registerEvent(type, {
      family: AGENT_EVENT_FAMILY[type],
      description: entry.description,
      payload: entry.payload,
    });
  }
}

void registerAgentEvents();

export interface MakeAgentEventInput {
  readonly type: AgentEventType;
  readonly aggregate: EventAggregateShape;
  readonly occurredAt: string;
  readonly correlation?: CorrelationShape | undefined;
  readonly actor: ActorRefShape;
  readonly sequence?: number | undefined;
  readonly payload: unknown;
}

/**
 * Build a canonical C004 event envelope for a registered agent event. Unknown
 * types and payloads that fail their strict schema throw — events are only
 * emitted when they validate end-to-end.
 */
export function makeAgentEvent(input: MakeAgentEventInput): EventEnvelopeShape {
  const entry = AGENT_EVENT_CATALOG[input.type];
  if (!entry) throw new TypeError(`Unknown agent event type '${input.type}'.`);
  const payload = entry.payload.parse(input.payload) as Record<string, unknown>;
  const base = {
    id: idSchemas.eventId.parse(crypto.randomUUID()),
    schemaVersion: EVENT_SCHEMA_VERSION,
    aggregate: input.aggregate,
    sequence: input.sequence,
    occurredAt: timestampIso.parse(input.occurredAt),
    correlation: correlation.parse(input.correlation ?? {}),
    actor: actorRef.parse(input.actor),
  };
  const checked = eventEnvelopeBase.parse(base);
  return { ...checked, type: input.type, payload } as EventEnvelopeShape;
}
