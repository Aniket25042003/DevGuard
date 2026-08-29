/**
 * C008/C060 — worker handler: claim durable outbox rows and fan out to typed jobs.
 */
import type { OutboxRecord, OutboxRepository } from '@devguard/db';
import { buildEnvelope } from '@devguard/queue';
import type { JobEnvelope, JobHandler, JobRegistry, JobTypeV1, QueueName, QueueTransport } from '@devguard/queue';

const DEFAULT_MAPPINGS: ReadonlyArray<{
  readonly matchingEventTypes: readonly string[];
  readonly jobType: JobTypeV1;
  readonly queue: QueueName;
}> = [
  {
    matchingEventTypes: ['workflow.queued'],
    jobType: 'workflow.execute',
    queue: 'workflow-execution',
  },
  {
    matchingEventTypes: ['webhook.accepted'],
    jobType: 'webhook.process',
    queue: 'webhook-processing',
  },
];

export interface OutboxPublishDeps {
  readonly outbox: OutboxRepository;
  readonly queue: QueueTransport;
  readonly workerId: string;
  readonly leaseMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly now?: (() => number) | undefined;
}

function buildPayload(
  jobType: JobTypeV1,
  row: OutboxRecord,
  runId: string,
  deliveryId: string,
): Record<string, unknown> {
  const payload = row.payload as Record<string, unknown>;
  const correlation = row.correlation as Record<string, unknown>;
  if (jobType === 'workflow.execute') {
    return { runId, stepId: 'start', stepAttempt: 0 };
  }
  return {
    deliveryId,
    repositoryId: String(correlation['repositoryId'] ?? payload['repositoryId'] ?? ''),
    payloadRef: String(correlation['payloadRef'] ?? payload['payloadRef'] ?? ''),
    event: String(payload['event'] ?? correlation['payloadRef'] ?? ''),
    ...(typeof payload['issueCommentPayload'] === 'string'
      ? { issueCommentPayload: payload['issueCommentPayload'] }
      : {}),
  };
}

function toEnvelope(
  row: OutboxRecord,
  mapping: { jobType: JobTypeV1; queue: QueueName },
  now: () => number,
): JobEnvelope {
  const payload = row.payload as Record<string, unknown>;
  const correlation = row.correlation as Record<string, unknown>;
  const runId = String(
    correlation['runId'] ?? payload['runId'] ?? correlation['workflowRunId'] ?? '',
  );
  const deliveryId = String(correlation['deliveryId'] ?? '');
  const repositoryId = String(correlation['repositoryId'] ?? payload['repositoryId'] ?? '');
  const anchor = runId || deliveryId || row.id;
  const uniqueKey = `outbox:${mapping.jobType}:${anchor}`;
  return buildEnvelope({
    jobType: mapping.jobType,
    schemaVersion: 1,
    queue: mapping.queue,
    uniqueKey,
    payload: buildPayload(mapping.jobType, row, runId, deliveryId),
    correlationId: `outbox:${anchor}`,
    workflowRunId: runId === '' ? undefined : runId,
    repositoryId: repositoryId === '' ? undefined : repositoryId,
    cancellationGeneration: 0,
    now,
  });
}

export function registerOutboxPublish(registry: JobRegistry, deps: OutboxPublishDeps): void {
  const leaseMs = deps.leaseMs ?? 30_000;
  const batchSize = deps.batchSize ?? 64;
  const now = deps.now ?? (() => Date.now());

  const handler: JobHandler = async () => {
    const claimed = await deps.outbox.claim(batchSize, leaseMs, deps.workerId);
    let published = 0;
    for (const row of claimed) {
      const mapping = DEFAULT_MAPPINGS.find((m) => m.matchingEventTypes.includes(row.eventType));
      try {
        if (mapping === undefined) {
          await deps.outbox.markPublished(row.id, row.rowVersion);
          published += 1;
          continue;
        }
        const envelope = toEnvelope(row, mapping, now);
        await deps.queue.enqueue(envelope, 0);
        await deps.outbox.markPublished(row.id, row.rowVersion);
        published += 1;
      } catch (error) {
        const nextAt = new Date(now() + 5_000).toISOString();
        const code =
          error instanceof Error ? error.message.slice(0, 128) : 'outbox_publish_failed';
        await deps.outbox.reschedule(row.id, row.rowVersion, nextAt, code);
      }
    }
    return { outcome: 'SUCCEEDED', detail: `published_${published}` };
  };

  registry.register('outbox.publish', 1, handler);
}
