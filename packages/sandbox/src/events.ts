/**
 * C041/C042 — sandbox event catalog and envelope builder.
 *
 * The shared event registry (C004 contracts/src/events.ts) has a fixed
 * family union that predates the sandbox domain, and packages may not edit
 * contracts, so sandbox event types are declared HERE with their payload
 * schemas and validated through the canonical C004 envelope (eventEnvelopeBase)
 * before leaving this package. The composition root maps these envelopes to
 * the outbox/queue; consumers fail closed on unknown types.
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
import { outputSequence, sandboxIdSchemas } from './ids.js';

export const SANDBOX_EVENT_TYPES = {
  workspaceRequested: 'sandbox.workspace.requested',
  workspaceCreated: 'sandbox.workspace.created',
  workspaceReady: 'sandbox.workspace.ready',
  workspaceFailed: 'sandbox.workspace.failed',
  workspaceQuarantined: 'sandbox.workspace.quarantined',
  workspaceDestroyRequested: 'sandbox.workspace.destroy_requested',
  checkoutResolved: 'checkout.resolved',
  checkoutCompleted: 'checkout.completed',
  checkoutVerificationFailed: 'checkout.verification_failed',
  commandProposed: 'sandbox.command.proposed',
  commandQueued: 'sandbox.command.queued',
  commandStarted: 'sandbox.command.started',
  commandOutput: 'sandbox.command.output',
  commandCompleted: 'sandbox.command.completed',
  commandFailed: 'sandbox.command.failed',
  commandTimedOut: 'sandbox.command.timed_out',
  commandCancelled: 'sandbox.command.cancelled',
  commandBlocked: 'sandbox.command.blocked',
  commandReconciling: 'sandbox.command.reconciling',
} as const;

export type SandboxEventType = (typeof SANDBOX_EVENT_TYPES)[keyof typeof SANDBOX_EVENT_TYPES];

export interface SandboxEventCatalogEntry {
  readonly description: string;
  readonly payload: z.ZodType<unknown>;
}

const hexSha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);

const payloads: Record<SandboxEventType, z.ZodType<unknown>> = {
  [SANDBOX_EVENT_TYPES.workspaceRequested]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      runId: z.string().min(1).max(128),
      requestedRefKind: z.enum(['commit', 'branch', 'tag', 'pull_request_head']),
      requestedRef: z.string().min(1).max(256),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.workspaceCreated]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      runId: z.string().min(1).max(128),
      providerWorkspaceId: sandboxIdSchemas.providerWorkspaceId,
      providerVersion: z.string().min(1).max(128),
      capabilitySnapshotId: sandboxIdSchemas.capabilitySnapshotId,
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.workspaceReady]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      runId: z.string().min(1).max(128),
      resolvedSha: hexSha,
      verifiedHeadSha: hexSha,
      capabilitySnapshotId: sandboxIdSchemas.capabilitySnapshotId,
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.workspaceFailed]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      runId: z.string().min(1).max(128),
      failureCode: z.string().min(1).max(64),
      failureDetailRedacted: z.string().max(400),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.workspaceQuarantined]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      runId: z.string().min(1).max(128),
      reason: z.string().min(1).max(200),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.workspaceDestroyRequested]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      runId: z.string().min(1).max(128),
      generation: z.number().int().nonnegative(),
      reason: z.string().min(1).max(64),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.checkoutResolved]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      requestedRefKind: z.enum(['commit', 'branch', 'tag', 'pull_request_head']),
      requestedRef: z.string().min(1).max(256),
      resolvedSha: hexSha,
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.checkoutCompleted]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      resolvedSha: hexSha,
      observedHeadSha: hexSha,
      remoteFingerprint: z.string().min(1).max(128),
      treeHash: z.string().max(128).optional(),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.checkoutVerificationFailed]: z
    .object({
      workspaceId: sandboxIdSchemas.workspaceId,
      expectedSha: hexSha,
      observedSha: z.string().max(128),
      mismatchKind: z.string().min(1).max(64),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandProposed]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      workspaceId: sandboxIdSchemas.workspaceId,
      decisionId: z.string().min(1).max(128),
      commandClass: z.enum(['read', 'build', 'test', 'scan', 'install', 'network', 'destructive']),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandQueued]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      attempt: z.number().int().nonnegative(),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandStarted]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      providerCommandId: sandboxIdSchemas.providerCommandId,
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandOutput]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      stream: z.enum(['stdout', 'stderr']),
      sequence: outputSequence,
      bytesAfterRedaction: z.number().int().nonnegative(),
      originalByteCount: z.number().int().nonnegative(),
      checksum: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandCompleted]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      status: z.enum(['succeeded', 'failed', 'timed_out', 'cancelled', 'blocked', 'unknown']),
      exitCode: z.number().int().nullable(),
      signal: z.string().max(32).nullable(),
      durationMs: z.number().int().nonnegative(),
      terminationReason: z.string().min(1).max(64),
      truncatedStdout: z.boolean(),
      truncatedStderr: z.boolean(),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandFailed]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      errorCode: z.string().min(1).max(64),
      attempt: z.number().int().nonnegative(),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandTimedOut]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      durationMs: z.number().int().nonnegative(),
      terminationReason: z.string().min(1).max(64),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandCancelled]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      terminationReason: z.string().min(1).max(64),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandBlocked]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      reasonCode: z.string().min(1).max(64),
    })
    .strict(),
  [SANDBOX_EVENT_TYPES.commandReconciling]: z
    .object({
      commandId: sandboxIdSchemas.commandId,
      providerStatus: z.string().max(64),
    })
    .strict(),
};

export const SANDBOX_EVENT_CATALOG: Readonly<Record<SandboxEventType, SandboxEventCatalogEntry>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(payloads).map(([type, payload]) => [
        type,
        { description: `Sandbox domain event '${type}'.`, payload },
      ]),
    ) as Record<SandboxEventType, SandboxEventCatalogEntry>,
  );

/**
 * C041/C042 — register every sandbox event in the canonical C004 registry.
 *
 * Making envelopes with `makeSandboxEvent` is not enough: canonical
 * outbox/queue consumers classify envelopes with `parseEvent`, which looks up
 * the shared `@devguard/contracts` registry and fails closed (`unknown_type`)
 * on anything unregistered. Registering here (module load, before any
 * construction/parsing) makes every emitted sandbox event valid under the
 * same registry consumers use — the explicitly supported registration
 * mechanism C004 exports. Family groupings reflect the C004 taxonomy that
 * predates the sandbox domain; no contract file is edited.
 */
const SANDBOX_EVENT_FAMILY: Readonly<Record<SandboxEventType, RegisteredEvent['family']>> =
  Object.freeze({
    [SANDBOX_EVENT_TYPES.workspaceRequested]: 'workflow',
    [SANDBOX_EVENT_TYPES.workspaceCreated]: 'workflow',
    [SANDBOX_EVENT_TYPES.workspaceReady]: 'workflow',
    [SANDBOX_EVENT_TYPES.workspaceFailed]: 'workflow',
    [SANDBOX_EVENT_TYPES.workspaceQuarantined]: 'workflow',
    [SANDBOX_EVENT_TYPES.workspaceDestroyRequested]: 'workflow',
    [SANDBOX_EVENT_TYPES.checkoutResolved]: 'workflow',
    [SANDBOX_EVENT_TYPES.checkoutCompleted]: 'workflow',
    [SANDBOX_EVENT_TYPES.checkoutVerificationFailed]: 'workflow',
    [SANDBOX_EVENT_TYPES.commandProposed]: 'action',
    [SANDBOX_EVENT_TYPES.commandQueued]: 'action',
    [SANDBOX_EVENT_TYPES.commandStarted]: 'action',
    [SANDBOX_EVENT_TYPES.commandOutput]: 'action',
    [SANDBOX_EVENT_TYPES.commandCompleted]: 'action',
    [SANDBOX_EVENT_TYPES.commandFailed]: 'action',
    [SANDBOX_EVENT_TYPES.commandTimedOut]: 'action',
    [SANDBOX_EVENT_TYPES.commandCancelled]: 'action',
    [SANDBOX_EVENT_TYPES.commandBlocked]: 'action',
    [SANDBOX_EVENT_TYPES.commandReconciling]: 'action',
  });

export function registerSandboxEvents(): void {
  for (const type of Object.values(SANDBOX_EVENT_TYPES) as readonly SandboxEventType[]) {
    const entry = SANDBOX_EVENT_CATALOG[type];
    if (entry === undefined) {
      throw new TypeError(`Sandbox event type '${type}' has no catalog schema.`);
    }
    registerEvent(type, {
      family: SANDBOX_EVENT_FAMILY[type],
      description: entry.description,
      payload: entry.payload,
    });
  }
}

void registerSandboxEvents();

export interface MakeSandboxEventInput {
  readonly type: SandboxEventType;
  readonly aggregate: EventAggregateShape;
  readonly occurredAt: string;
  readonly correlation?: CorrelationShape | undefined;
  readonly actor: ActorRefShape;
  readonly sequence?: number | undefined;
  readonly payload: unknown;
}

/**
 * Build a canonical C004 event envelope for a registered sandbox event.
 * Unknown types and payloads that fail their strict schema throw — events are
 * only emitted when they can be validated end-to-end.
 */
export function makeSandboxEvent(input: MakeSandboxEventInput): EventEnvelopeShape {
  const entry = SANDBOX_EVENT_CATALOG[input.type];
  if (!entry) {
    throw new TypeError(`Unknown sandbox event type '${input.type}'.`);
  }
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
