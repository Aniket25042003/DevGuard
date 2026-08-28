/**
 * C045 §10/§23.7 — workflow registry events.
 *
 * C045 owns five event types (registered here at package load through the
 * shared C004 registry — identical re-registration is a no-op):
 *   workflow.definition.registered|blocked|deprecated
 *   workflow.registry.ready|failed
 * Payloads carry identity + digests/reasons ONLY — never skill text, policy
 * or source content (C045 §21). The `EventSinkPort` decouples emission from
 * transport (outbox/queue are C057/C064 concerns).
 */
import { makeEvent, registerEvent, type EventEnvelopeShape } from '@devguard/contracts';
import { z } from 'zod';
import { listErrorDescriptors } from '@devguard/errors';
import { digestJson } from './canonical.js';

void listErrorDescriptors; // registry integrity is asserted by consumers/tests

const shaPattern = /^[0-9a-f]{64}$/;

const definitionIdentity = z
  .object({
    workflowId: z.string().min(1).max(64),
    version: z.string().min(5).max(64),
  })
  .strict();

registerEvent('workflow.definition.registered', {
  family: 'workflow',
  description: 'A workflow definition version was validated and activated.',
  payload: definitionIdentity.extend({ digest: z.string().regex(shaPattern) }).strict(),
});

registerEvent('workflow.definition.blocked', {
  family: 'workflow',
  description: 'A workflow definition version was blocked (invalid or capability-unsupported).',
  payload: definitionIdentity
    .extend({ reasons: z.array(z.string().min(1).max(200)).max(16) })
    .strict(),
});

registerEvent('workflow.definition.deprecated', {
  family: 'workflow',
  description: 'A workflow definition version transitioned to deprecated (or retired).',
  payload: definitionIdentity.extend({ to: z.enum(['deprecated', 'retired']) }).strict(),
});

registerEvent('workflow.registry.ready', {
  family: 'workflow',
  description: 'The workflow definition registry generation is active.',
  payload: z
    .object({
      generation: z.number().int().nonnegative(),
      definitionCount: z.number().int().nonnegative(),
      activeCount: z.number().int().nonnegative(),
      blockedCount: z.number().int().nonnegative(),
    })
    .strict(),
});

registerEvent('workflow.registry.failed', {
  family: 'workflow',
  description: 'Registry startup failed its mandatory-definition policy.',
  payload: z
    .object({
      reasons: z.array(z.string().min(1).max(300)).max(64),
    })
    .strict(),
});

/** Default registry generation digest for the failed event (content-free). */
export const REGISTRY_FAILED_DIGEST: string = digestJson({ failed: true });

export type WorkflowEventType =
  | 'workflow.definition.registered'
  | 'workflow.definition.blocked'
  | 'workflow.definition.deprecated'
  | 'workflow.registry.ready'
  | 'workflow.registry.failed';

/** Injectable event emission boundary (outbox adapter supplied by apps). */
export interface EventSinkPort {
  (event: EventEnvelopeShape): void;
}

/** Build + emit a registered workflow event through the optional sink. */
export function emitWorkflowEvent(
  sink: EventSinkPort | undefined,
  type: WorkflowEventType,
  payload: Record<string, unknown>,
  extra?: { readonly workflowId?: string; readonly version?: string; readonly now?: Date },
): void {
  if (sink === undefined) return;
  const workflowId = extra?.workflowId ?? 'registry';
  const version = extra?.version ?? 'generation';
  sink(
    makeEvent({
      type,
      aggregate: { type: 'workflow_definition', id: `${workflowId}@${version}` },
      occurredAt: (extra?.now ?? new Date()).toISOString(),
      actor: { kind: 'system' },
      payload,
    }),
  );
}
