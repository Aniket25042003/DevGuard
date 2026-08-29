/**
 * CP006 — worker copy of the Postgres command bus persistence adapter.
 * Mirrors apps/api/src/composition/command-bus-adapter.ts without an apps/* import.
 */
import { createUnitOfWork, OutboxWriter, WorkflowRunStore, type DevGuardPool } from '@devguard/db';
import { idempotencyKeyConflict } from '@devguard/errors';
import type { CommandBusPersistencePort, CreateQueuedRunInput } from '@devguard/workflows';

type RunStoreLike = ConstructorParameters<typeof WorkflowRunStore>[0];

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

export class WorkerCommandBusPersistencePort implements CommandBusPersistencePort {
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
      const definitionVersionInt = toDefinitionVersionInt(input.definitionVersion);
      try {
        const record = await runStore.create({
          id: input.runId,
          repositoryId: input.repositoryId,
          workflowType: input.workflowType,
          triggerType: input.triggerType,
          triggerReferenceJson: JSON.stringify({
            originSurface: input.originSurface,
            commandId: input.workflowType,
            requestFingerprint: requestFingerprintOf(input),
            ...(input.definitionVersion !== undefined
              ? { definitionVersion: input.definitionVersion }
              : {}),
          }),
          idempotencyKeyHash: input.idempotencyKeyHash,
          ...(definitionVersionInt !== undefined
            ? { definitionVersion: definitionVersionInt }
            : {}),
          ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
        });
        created = { runId: record.id };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('IDEMPOTENCY_REPLAY')) {
          const existing = await runStore.findByIdempotencyKeyHash(input.idempotencyKeyHash);
          if (existing !== undefined && existing !== null) {
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

      await new OutboxWriter().append(
        {
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

function toDefinitionVersionInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const major = raw.split('.')[0];
  const parsed = Number.parseInt(major ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}
