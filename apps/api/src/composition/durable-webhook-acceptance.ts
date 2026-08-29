/**
 * CP011/CP019 — durable GitHub webhook acceptance: ledger row + outbox fan-out.
 * Stores only the payload hash in Postgres; passes a bounded excerpt to the worker
 * job via outbox correlation for `issue_comment` created events.
 */
import { createHash } from 'node:crypto';
import {
  createUnitOfWork,
  OutboxWriter,
  PostgresWebhookDeliveryStore,
  type DevGuardPool,
} from '@devguard/db';
import { parseIssueCommentWebhook } from '@devguard/workflows';
import type { WebhookAcceptancePort } from '../routes/github.routes.js';

const MAX_JOB_PAYLOAD_BYTES = 32_768;

export class DurableWebhookAcceptance implements WebhookAcceptancePort {
  constructor(
    private readonly pool: DevGuardPool,
    private readonly resolveRepositoryId?: (
      githubRepositoryId: string,
    ) => Promise<string | undefined>,
  ) {}

  async accept(input: {
    deliveryId: string;
    event: string;
    payloadJson: string;
    headers: { signature: string };
  }): Promise<{ accepted: boolean; replay?: boolean }> {
    void input.headers;
    const hash = createHash('sha256').update(input.payloadJson).digest('hex');
    const store = new PostgresWebhookDeliveryStore(this.pool);
    const inserted = await store.insert({
      githubDeliveryId: input.deliveryId,
      githubEvent: input.event,
      rawPayloadHash: hash,
      payloadRef: input.event,
    });
    if (inserted.replay) {
      return { accepted: true, replay: true };
    }

    let repositoryId: string | undefined;
    let issueCommentPayload: string | undefined;
    try {
      const parsed = JSON.parse(input.payloadJson) as unknown;
      const issueComment = parseIssueCommentWebhook(parsed);
      if (issueComment !== undefined && this.resolveRepositoryId !== undefined) {
        repositoryId = await this.resolveRepositoryId(String(issueComment.repository.id));
      }
      if (issueComment !== undefined) {
        const excerpt = JSON.stringify(issueComment);
        if (Buffer.byteLength(excerpt, 'utf8') <= MAX_JOB_PAYLOAD_BYTES) {
          issueCommentPayload = excerpt;
        }
      }
    } catch {
      // Non-JSON payloads still enqueue a generic webhook.process job.
    }

    await createUnitOfWork(this.pool).transaction(async (tx) => {
      await new OutboxWriter().append(
        {
          eventType: 'webhook.accepted',
          schemaVersion: 1,
          payload: {
            deliveryId: input.deliveryId,
            event: input.event,
            ...(repositoryId !== undefined ? { repositoryId } : {}),
            ...(issueCommentPayload !== undefined ? { issueCommentPayload } : {}),
          },
          correlation: {
            deliveryId: input.deliveryId,
            payloadRef: input.event,
            ...(repositoryId !== undefined ? { repositoryId } : {}),
          },
          aggregateType: 'github_webhook_delivery',
          aggregateId: input.deliveryId,
        },
        tx,
      );
    });

    return { accepted: true, replay: false };
  }
}
