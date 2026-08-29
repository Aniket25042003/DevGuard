/**
 * CP008 / C060 — OutboxPublisher: durable outbox → queue fan-out.
 *
 * Reads unpublished `outbox_events` rows in global-id order, maps each to the
 * matching typed job envelope (workflow.queued → workflow.execute,
 * webhook.accepted → webhook.process), enqueues it, then marks it published.
 * Publication is idempotent: if the enqueue reports a duplicate the run is
 * already queued, so marking published advances the cursor without double work.
 */
import { buildEnvelope, type JobTypeV1, type QueueName } from './envelope.js';
import type { QueuePortShape } from './runtime.js';

/** Application-side port over the durable outbox ledger. */
export interface OutboxScanPort {
  listUnpublished(
    afterId: bigint,
    limit: number,
  ): Promise<
    Array<{
      readonly id: bigint;
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly correlation: Record<string, unknown>;
    }>
  >;
  markPublished(id: bigint): Promise<void>;
  lastPublishedId(): Promise<bigint>;
}

export interface OutboxMapping {
  readonly matchingEventTypes: readonly string[];
  readonly jobType: JobTypeV1;
  readonly queue: QueueName;
}

const DEFAULT_MAPPINGS: readonly OutboxMapping[] = [
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

export interface OutboxPublisherDeps {
  readonly outbox: OutboxScanPort;
  readonly queue: QueuePortShape;
  readonly mappings?: readonly OutboxMapping[] | undefined;
  readonly now?: () => number;
  readonly correlationBase?: () => string;
}

export class OutboxPublisher {
  private readonly mappings: readonly OutboxMapping[];
  private readonly now: () => number;
  private readonly correlationBase: () => string;

  constructor(private readonly deps: OutboxPublisherDeps) {
    this.mappings = deps.mappings ?? DEFAULT_MAPPINGS;
    this.now = deps.now ?? (() => Date.now());
    this.correlationBase = deps.correlationBase ?? (() => 'outbox');
  }

  /** One publication pass (a bounded number of rows). Returns rows published. */
  async publishOnce(limit = 256): Promise<number> {
    const cursor = await this.deps.outbox.lastPublishedId();
    const rows = await this.deps.outbox.listUnpublished(cursor, limit);
    let published = 0;
    for (const row of rows) {
      const mapping = this.mappings.find((m) => m.matchingEventTypes.includes(row.eventType));
      if (mapping === undefined) {
        // Unknown outbox event types are skipped — never crash a lease over them.
        await this.deps.outbox.markPublished(row.id);
        published += 1;
        continue;
      }
      const runId = String(
        row.correlation['runId'] ?? row.payload['runId'] ?? row.correlation['workflowRunId'] ?? '',
      );
      const deliveryId = String(
        row.correlation['deliveryId'] ?? row.correlation['deliveryId'] ?? '',
      );
      const repositoryId = String(
        row.correlation['repositoryId'] ?? row.payload['repositoryId'] ?? '',
      );
      const uniqueKey = this.buildUniqueKey(row, mapping, runId, deliveryId);
      const envelope = buildEnvelope({
        jobType: mapping.jobType,
        schemaVersion: 1,
        queue: mapping.queue,
        uniqueKey,
        payload: this.buildPayload(mapping.jobType, row, runId, deliveryId),
        correlationId: `${this.correlationBase()}:${runId || deliveryId || row.id}`,
        workflowRunId: runId === '' ? undefined : runId,
        repositoryId: repositoryId === '' ? undefined : repositoryId,
        cancellationGeneration: 0,
        now: this.now,
      });
      const enqueued = await this.deps.queue.enqueue(envelope);
      // Idempotency: a duplicate means it's already queued — still advance.
      await this.deps.outbox.markPublished(row.id);
      published += 1;
      void enqueued;
    }
    return published;
  }

  private buildUniqueKey(
    row: { readonly id: bigint; readonly eventType: string },
    mapping: OutboxMapping,
    runId: string,
    deliveryId: string,
  ): string {
    const anchor = runId || deliveryId;
    return `outbox:${mapping.jobType}:${anchor === '' ? row.id.toString() : anchor}`;
  }

  private buildPayload(
    jobType: JobTypeV1,
    row: {
      readonly payload: Record<string, unknown>;
      readonly correlation: Record<string, unknown>;
    },
    runId: string,
    deliveryId: string,
  ): Record<string, unknown> {
    if (jobType === 'workflow.execute') {
      return { runId, stepId: 'start', stepAttempt: 0 };
    }
    return {
      deliveryId,
      repositoryId: String(row.correlation['repositoryId'] ?? row.payload['repositoryId'] ?? ''),
      payloadRef: String(row.correlation['payloadRef'] ?? row.payload['payloadRef'] ?? ''),
      event: String(row.payload['event'] ?? row.correlation['payloadRef'] ?? ''),
      ...(typeof row.payload['issueCommentPayload'] === 'string'
        ? { issueCommentPayload: row.payload['issueCommentPayload'] }
        : {}),
    };
  }
}
