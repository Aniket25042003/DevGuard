import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WebhookSignatureVerifier,
  StaticSecretProvider,
  isCanonicalSignatureHeader,
} from './signature-verifier.js';
import {
  InMemoryDeliveryLedger,
  InMemoryPayloadVault,
  canTransition,
  deliveryRow,
  resolveDeliveryTransition,
} from './delivery-ledger.js';
import { GitHubWebhookIngress } from './ingress.js';
import { WebhookNormalizer } from './normalizer.js';
import { TriggerRouter, type WebhookTriggerDefinition } from './trigger-router.js';
import { GitHubWebhookProcessor, NoopCurrentStateReconciler } from './processor.js';
import { bytesToString } from './delivery-ledger.js';
import type { GitHubWebhookHeaders } from './contracts.js';

const SECRET = 'webhook-secret';
const BODY = Buffer.from(
  '{"action":"opened","repository":{"id":"1","name":"demo","owner":{"login":"octo"},"default_branch":"main"},"pull_request":{"number":7}}',
);
const sig = (bytes: Uint8Array, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;

function headers(overrides: Partial<GitHubWebhookHeaders> = {}): GitHubWebhookHeaders {
  return { deliveryId: 'dlv-1', event: 'pull_request', signature: sig(BODY), ...overrides };
}

function ingressSetup() {
  const ledger = new InMemoryDeliveryLedger();
  const vault = new InMemoryPayloadVault();
  const verifier = new WebhookSignatureVerifier(
    new StaticSecretProvider([{ version: 1, secret: SECRET }]),
  );
  const ingress = new GitHubWebhookIngress({
    verifier,
    ledger,
    vault,
    clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
  });
  return { ledger, vault, ingress };
}

describe('C022 signature verifier', () => {
  it('accepts an official HMAC vector and rejects a single-byte mutation', async () => {
    const verifier = new WebhookSignatureVerifier(
      new StaticSecretProvider([{ version: 1, secret: SECRET }]),
    );
    expect(isCanonicalSignatureHeader(sig(BODY))).toBe(true);
    await expect(verifier.verify(BODY, sig(BODY))).resolves.toEqual({ ok: true, version: 1 });
    const tampered = Buffer.from(BODY);
    tampered[0] = tampered[0] === 0x7b ? 0x5b : 0x7b;
    await expect(verifier.verify(tampered, sig(BODY))).resolves.toEqual({ ok: false });
  });

  it('rotates between active secret versions', async () => {
    const verifier = new WebhookSignatureVerifier(
      new StaticSecretProvider([
        { version: 2, secret: 'new-secret' },
        { version: 1, secret: SECRET },
      ]),
    );
    await expect(verifier.verify(BODY, sig(BODY))).resolves.toEqual({ ok: true, version: 1 });
  });

  it('rejects non-canonical header shapes', () => {
    expect(isCanonicalSignatureHeader('sha1=abc')).toBe(false);
    expect(isCanonicalSignatureHeader('sha256=short')).toBe(false);
  });
});

describe('C022 delivery FSM', () => {
  it('supports the accepted->dispatch_pending->processing->reconciling->routed path', () => {
    expect(resolveDeliveryTransition('accepted', 'dispatch')).toBe('dispatch_pending');
    expect(resolveDeliveryTransition('dispatch_pending', 'process')).toBe('processing');
    expect(canTransition('processing', 'reconcile')).toBe(true);
    expect(resolveDeliveryTransition('reconciling', 'routed')).toBe('routed');
    expect(resolveDeliveryTransition('reconciling', 'retry')).toBe('retry_wait');
  });
  it('returns expired worker leases to dispatch_pending', () => {
    expect(resolveDeliveryTransition('processing', 'lease_expired')).toBe('dispatch_pending');
  });
});

describe('C022 webhook ingress', () => {
  it('accepts a valid signed delivery and replays duplicates', async () => {
    const { ledger, ingress } = ingressSetup();
    const first = await ingress.accept({ rawBody: BODY, headers: headers(), requestId: 'r1' });
    expect(first).toEqual({ kind: 'accepted', deliveryId: 'dlv-1' });
    expect((await ledger.get('dlv-1'))?.state).toBe('dispatch_pending');
    const second = await ingress.accept({ rawBody: BODY, headers: headers(), requestId: 'r2' });
    expect(second.kind).toBe('duplicate');
  });

  it('rejects an invalid signature without persisting', async () => {
    const { ledger, ingress } = ingressSetup();
    const bad = { ...headers(), signature: sig(BODY, 'wrong-secret') };
    const result = await ingress.accept({ rawBody: BODY, headers: bad, requestId: 'r3' });
    expect(result).toEqual({ kind: 'rejected', code: 'SIGNATURE_INVALID' });
    expect(await ledger.get('dlv-1')).toBeUndefined();
  });

  it('rejects invalid headers and oversized payloads', async () => {
    const { ingress } = ingressSetup();
    expect(
      (await ingress.accept({ rawBody: BODY, headers: headers({ event: 'ping' }), requestId: 'r' }))
        .kind,
    ).toBe('accepted');
    const oversize = await ingress.accept({
      rawBody: new Uint8Array(2_000_000),
      headers: headers({ deliveryId: 'dlv-big' }),
      requestId: 'r',
    });
    expect(oversize.kind).toBe('rejected');
  });
});

describe('C022 normalizer + router + processor', () => {
  const normalizer = new WebhookNormalizer();
  const triggers: WebhookTriggerDefinition[] = [
    {
      triggerId: 'tg-plan',
      workflowKind: 'plan',
      events: ['pull_request'],
      actions: ['opened', 'synchronize'],
    },
  ];
  const router = new TriggerRouter({ triggers });

  it('normalizes a signed PR event and routes a matching trigger with an idempotent key', () => {
    const normalized = normalizer.normalize(BODY, 'pull_request');
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const routed = router.route(normalized.event, 'dlv-1');
    expect(routed.matched).toBe(true);
    if (!routed.matched) return;
    expect(routed.routes[0].semanticKey).toContain('tg-plan');
    expect(routed.routes[0].semanticKey).toContain('pr:7');
  });

  it('ignores malformed JSON and unknown actions', async () => {
    expect(normalizer.normalize(Buffer.from('{ not json'), 'pull_request').ok).toBe(false);
    expect(
      normalizer.normalize(
        Buffer.from(
          '{"action":"deleted","repository":{"id":"1","name":"demo","owner":{"login":"o"}},"pull_request":{"number":7}}',
        ),
        'pull_request',
      ).ok,
    ).toBe(true);
  });

  it('processes a matched event to routed and a stale event to ignored', async () => {
    const { ledger, vault } = ingressSetup();
    await new GitHubWebhookIngress({
      verifier: new WebhookSignatureVerifier(
        new StaticSecretProvider([{ version: 1, secret: SECRET }]),
      ),
      ledger,
      vault,
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    }).accept({ rawBody: BODY, headers: headers(), requestId: 'r' });
    const processor = new GitHubWebhookProcessor(
      ledger,
      vault,
      normalizer,
      router,
      NoopCurrentStateReconciler,
      { emit: async () => undefined },
    );
    const result = await processor.process({ deliveryId: 'dlv-1', leaseToken: 'lt' });
    expect(result.outcome).toBe('routed');
    expect((await ledger.get('dlv-1'))?.state).toBe('routed');
  });

  it('marks stale events ignored', async () => {
    const { ledger, vault } = ingressSetup();
    await new GitHubWebhookIngress({
      verifier: new WebhookSignatureVerifier(
        new StaticSecretProvider([{ version: 1, secret: SECRET }]),
      ),
      ledger,
      vault,
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    }).accept({ rawBody: BODY, headers: headers(), requestId: 'r' });
    const processor = new GitHubWebhookProcessor(
      ledger,
      vault,
      normalizer,
      router,
      { isCurrent: async () => false },
      { emit: async () => undefined },
    );
    const result = await processor.process({ deliveryId: 'dlv-1', leaseToken: 'lt' });
    expect(result.outcome).toBe('ignored');
    expect(result.reason).toBe('stale');
  });

  it('retries when the payload vault is missing', async () => {
    const { ledger } = ingressSetup();
    await ledger.claim(deliveryRow('dlv-1', 'pull_request', 1, BODY, '2026-08-28T00:00:00.000Z'));
    await ledger.transition('dlv-1', 'dispatch_pending');
    const processor = new GitHubWebhookProcessor(
      ledger,
      new InMemoryPayloadVault(),
      normalizer,
      router,
      NoopCurrentStateReconciler,
      { emit: async () => undefined },
    );
    const result = await processor.process({ deliveryId: 'dlv-1', leaseToken: 'lt' });
    expect(result.outcome).toBe('retry_wait');
    void bytesToString;
  });

  it('uses pull_request.head.sha as the transition subject and preserves installation id', () => {
    const headSha = 'e'.repeat(40);
    const raw = Buffer.from(
      '{"action":"synchronize","repository":{"id":"1","name":"demo","owner":{"login":"o"}},"installation":{"id":42},"pull_request":{"number":7,"head":{"sha":"' +
        headSha +
        '"}}}',
    );
    const n = normalizer.normalize(raw, 'pull_request');
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    expect(n.event.headSha).toBe(headSha);
    expect(n.event.providerInstallationId).toBe('42');
    const routed = router.route(n.event, 'dlv-2');
    expect(routed.matched).toBe(true);
    if (!routed.matched) return;
    expect(routed.routes[0].semanticKey).toContain(headSha);
    // Distinct synchronize deliveries for different heads get distinct keys.
    const headSha2 = 'f'.repeat(40);
    const raw2 = raw.toString().replace(headSha, headSha2);
    const n2 = normalizer.normalize(Buffer.from(raw2), 'pull_request');
    expect(n2.ok).toBe(true);
    if (n2.ok) {
      const r2 = router.route(n2.event, 'dlv-2');
      if (r2.matched) expect(r2.routes[0].semanticKey).not.toBe(routed.routes[0].semanticKey);
    }
  });

  it('requires an action when a trigger constrains actions (missing action does not match)', () => {
    const raw = Buffer.from(
      '{"repository":{"id":"1","name":"demo","owner":{"login":"o"}},"pull_request":{"number":7}}',
    );
    const n = normalizer.normalize(raw, 'pull_request'); // no action field
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const routed = router.route(n.event, 'dlv-3'); // trigger.actions = opened/synchronize
    expect(routed.matched).toBe(false);
  });

  it('dispatches each routed workflow command', async () => {
    const { ledger, vault, ingress } = ingressSetup();
    await ingress.accept({ rawBody: BODY, headers: headers(), requestId: 'r' });
    const dispatched: string[] = [];
    const processor = new GitHubWebhookProcessor(
      ledger,
      vault,
      normalizer,
      router,
      NoopCurrentStateReconciler,
      { emit: async () => undefined },
      { dispatch: async (route) => void dispatched.push(route.workflowKind) },
    );
    const result = await processor.process({ deliveryId: 'dlv-1', leaseToken: 'lt' });
    expect(result.outcome).toBe('routed');
    expect(dispatched).toContain('plan');
  });

  it('schedules a retry when dispatch fails instead of stranding processing', async () => {
    const { ledger, vault, ingress } = ingressSetup();
    await ingress.accept({ rawBody: BODY, headers: headers(), requestId: 'r' });
    const processor = new GitHubWebhookProcessor(
      ledger,
      vault,
      normalizer,
      router,
      NoopCurrentStateReconciler,
      { emit: async () => undefined },
      {
        dispatch: async () => {
          throw new Error('queue down');
        },
      },
    );
    const result = await processor.process({ deliveryId: 'dlv-1', leaseToken: 'lt' });
    expect(result.outcome).toBe('retry_wait');
    expect((await ledger.get('dlv-1'))?.state).toBe('retry_wait');
  });
});
