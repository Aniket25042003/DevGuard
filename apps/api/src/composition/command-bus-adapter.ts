/**
 * CP006 — durable command-persistence adapter for the API composition root.
 *
 * Implements the `@devguard/workflows` `CommandBusPersistencePort` on Postgres.
 * The run row and the outbox event are written inside ONE unit of work, so a
 * queued run is never observable without its publishable intent, and a crash
 * can never leave one without the other (C008 outbox; steering invariant 10).
 * Replaying an idempotency key that already produced a run returns the EXISTING
 * run and appends no duplicate outbox event.
 */
import { createUnitOfWork, OutboxWriter, WorkflowRunStore, type DevGuardPool } from '@devguard/db';
import { idempotencyKeyConflict } from '@devguard/errors';
import type { CommandBusPersistencePort, CreateQueuedRunInput } from '@devguard/workflows';

type RunStoreLike = ConstructorParameters<typeof WorkflowRunStore>[0];

/** Fingerprint of the request recorded on a NEW run for exact-replay checks. */
function requestFingerprintOf(input: CreateQueuedRunInput): string {
  return input.requestFingerprint;
}

function storedFingerprintOf(triggerReferenceJson: string): string | undefined {
  try {
    const parsed = JSON.parse(triggerReferenceJson) as { requestFingerprint?: unknown };
    return typeof parsed.requestFingerprint === 'string' ? parsed.requestFingerprint : undefined;
  } catch {
    return undefined;
  }
}

export class PostgresCommandBusPersistencePort implements CommandBusPersistencePort {
  constructor(private readonly pool: DevGuardPool) {}

  async createQueuedRun(
    input: CreateQueuedRunInput,
  ): Promise<
    | { readonly outcome: 'created'; readonly runId: string }
    | { readonly outcome: 'replayed'; readonly runId: string }
  > {
    return createUnitOfWork(this.pool).transaction(async (tx) => {
      const runStore = new WorkflowRunStore(tx as unknown as RunStoreLike);
      let created: { readonly runId: string } | undefined;
      try {
        const record = await runStore.create({
          id: input.runId,
          repositoryId: input.repositoryId,
          workflowType: input.workflowType,
          // trigger_type accepts manual|webhook|api; schedule is rejected at the bus.
          triggerType: input.triggerType,
          originSurface: input.originSurface ?? 'web',
          // origin_surface is not a column until CP016; carry it + the request
          // fingerprint on the trigger reference so an idempotent replay can be
          // proven identical.
          triggerReferenceJson: JSON.stringify({
            originSurface: input.originSurface,
            commandId: input.workflowType,
            requestFingerprint: requestFingerprintOf(input),
            ...(input.definitionVersion !== undefined
              ? { definitionVersion: input.definitionVersion }
              : {}),
          }),
          idempotencyKeyHash: input.idempotencyKeyHash,
          ...(input.definitionVersion !== undefined
            ? { definitionVersion: input.definitionVersion }
            : {}),
          ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        });
        created = { runId: record.id };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('IDEMPOTENCY_REPLAY')) {
          const existing = await runStore.findByIdempotencyKeyHash(input.idempotencyKeyHash);
          if (existing !== undefined && existing !== null) {
            // A replayed key is honored ONLY for an exact replay; reusing the
            // key for a DIFFERENT request is a conflict, not a silent dedupe.
            if (
              storedFingerprintOf(existing.triggerReferenceJson) === requestFingerprintOf(input)
            ) {
              return { outcome: 'replayed', runId: existing.id } as const;
            }
            throw idempotencyKeyConflict(
              new Error('idempotency_key_reused_with_different_request'),
            );
          }
        }
        throw error;
      }

      // Only a genuinely-new run enqueues a job; a replay is silent.
      await new OutboxWriter().append(
        {
          // canonical C004 workflow.queued payload (repositoryId + trigger).
          eventType: 'workflow.queued',
          schemaVersion: 1,
          payload: input.eventPayload,
          correlation: {
            runId: created.runId,
            repositoryId: input.repositoryId,
            commandId: input.workflowType,
            originSurface: input.originSurface,
            ...(input.definitionVersion !== undefined
              ? { definitionVersion: input.definitionVersion }
              : {}),
          },
          aggregateType: 'workflow_run',
          aggregateId: created.runId,
        },
        tx,
      );
      return { outcome: 'created', runId: created.runId } as const;
    });
  }
}
