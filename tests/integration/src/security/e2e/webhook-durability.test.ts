import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  WebhookAcceptanceService,
  WebhookSecurityService,
  type AcceptanceOutcome,
  type VerifiedWebhookEnvelope,
  type WebhookDeliveryRecord,
  type WebhookDeliveryStore,
} from '@devguard/security';
import { runScenario, type ScenarioSpec } from './harness.js';

const SECRET = 'whsec-test-0123456789abcdef';
const deliveryId = 'deliv-0001';

const SECRETS = {
  async getVerificationKeys(): Promise<ReadonlyArray<{ version: string; secret: string }>> {
    return [{ version: 'c1', secret: SECRET }];
  },
};

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

/** Transactional in-memory delivery store enforcing unique (provider, deliveryId). */
class InMemoryDeliveryStore implements WebhookDeliveryStore {
  private readonly rows = new Map<string, WebhookDeliveryRecord>();
  async acceptDelivery(record: WebhookDeliveryRecord): Promise<AcceptanceOutcome> {
    const key = `${record.provider}:${record.deliveryId}`;
    const existing = this.rows.get(key);
    if (existing !== undefined) {
      if (existing.payloadDigest === record.payloadDigest) {
        return { outcome: 'duplicate', status: existing.status };
      }
      return { outcome: 'conflict', existingStatus: existing.status };
    }
    this.rows.set(key, { ...record, status: 'PERSISTED' });
    return { outcome: 'accepted_new', status: 'PERSISTED' };
  }
}

const E06_SPEC: ScenarioSpec = {
  id: 'e06_webhook_durability',
  version: '1.0.0',
  tags: ['webhooks', 'durability'],
  description: 'duplicate/out-of-order webhooks create one effective workflow',
};

describe('C097 E06 webhook durability', () => {
  it('delivers the same signed webhook twice as exactly one effective effect', async () => {
    const verifier = new WebhookSecurityService(SECRETS);
    const store = new InMemoryDeliveryStore();
    const acceptance = new WebhookAcceptanceService(store);
    const body = JSON.stringify({ action: 'opened' });
    const header = sign(body);

    let acceptedNew = 0;
    const outcome = await runScenario(
      E06_SPEC,
      async () => {
        const states: string[] = [];
        for (let i = 0; i < 2; i += 1) {
          const envelope = await verifier.verify(Buffer.from(body), {
            'x-hub-signature-256': header,
            'x-github-delivery': deliveryId,
            'x-github-event': 'pull_request',
          });
          const result = await acceptance.accept(envelope, { repositoryExternalId: 'repo-1' });
          states.push(`${result.outcome}:${result.httpStatus}`);
          if (result.outcome === 'accepted_new') acceptedNew += 1;
        }
        return { states, evidence: [body, header, ...states] };
      },
      {
        forbiddenEffects: [
          {
            id: 'one_effective_effect',
            description: 'a duplicate delivery must not create a second run',
            evaluate: () => acceptedNew !== 1,
          },
        ],
        canaries: ['canary-webhook-e06'],
      },
    );
    expect(outcome.evidence.passed).toBe(true);
    expect(outcome.evidence.states).toEqual(['accepted_new:202', 'duplicate:200']);
    expect(acceptedNew).toBe(1);
  });

  it('rejects the same delivery id with a different body as a conflict', async () => {
    const verifier = new WebhookSecurityService(SECRETS);
    const store = new InMemoryDeliveryStore();
    const acceptance = new WebhookAcceptanceService(store);

    const firstBody = JSON.stringify({ action: 'opened' });
    const first = await verifier.verify(Buffer.from(firstBody), {
      'x-hub-signature-256': sign(firstBody),
      'x-github-delivery': deliveryId,
      'x-github-event': 'pull_request',
    });
    await acceptance.accept(first, { repositoryExternalId: 'repo-1' });

    const tamperedBody = JSON.stringify({ action: 'closed' });
    const second = await verifier.verify(Buffer.from(tamperedBody), {
      'x-hub-signature-256': sign(tamperedBody),
      'x-github-delivery': deliveryId,
      'x-github-event': 'pull_request',
    });
    await expect(
      acceptance.accept(second, { repositoryExternalId: 'repo-1' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_DELIVERY_CONFLICT' });
  });

  it('fails closed on a forged/tampered signature', async () => {
    const verifier = new WebhookSecurityService(SECRETS);
    const body = JSON.stringify({ action: 'opened' });
    // Signature computed over DIFFERENT bytes than what is delivered.
    const forgedHeader = sign(JSON.stringify({ action: 'tampered' }));
    await expect(
      verifier.verify(Buffer.from(body), {
        'x-hub-signature-256': forgedHeader,
        'x-github-delivery': deliveryId,
        'x-github-event': 'pull_request',
      }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });
});

// Re-exported for shape clarity in evidence manifests.
export type { VerifiedWebhookEnvelope };
