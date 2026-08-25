import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FailClosedRateLimiter,
  OriginPolicy,
  RATE_POLICIES,
  WebhookAcceptanceService,
  WebhookSecurityService,
  fetchMetadataSite,
  hierarchicalRateKey,
  verifyCsrf,
} from '@devguard/security';
import type { DistributedRateLimiterPort, WebhookDeliveryStore } from '@devguard/security';

const SECRET_CURRENT = 'webhook-secret-current-value';
const SECRET_PREVIOUS = 'webhook-secret-previous';

function signingHeaders(body: string, secret: string = SECRET_CURRENT): Record<string, string> {
  const signature = createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
  return {
    'x-hub-signature-256': `sha256=${signature}`,
    'x-github-delivery': 'd9e1aa30-6b88-11ee-8c99-0242ac120002',
    'x-github-event': 'pull_request',
  };
}

describe('C094 GitHub webhook HMAC verification', () => {
  const security = new WebhookSecurityService({
    getVerificationKeys: async () => [
      { version: 'v2', secret: SECRET_CURRENT },
      { version: 'v1', secret: SECRET_PREVIOUS },
    ],
  });

  it('verifies a valid signature over exact raw bytes and records the key version', async () => {
    const body = JSON.stringify({ action: 'opened', number: 7 });
    const envelope = await security.verify(Buffer.from(body, 'utf8'), signingHeaders(body));
    expect(envelope.deliveryId).toBe('d9e1aa30-6b88-11ee-8c99-0242ac120002');
    expect(envelope.eventType).toBe('pull_request');
    expect(envelope.signatureKeyVersion).toBe('v2');
    expect(envelope.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honors the previous key during rotation windows', async () => {
    const body = JSON.stringify({ action: 'synchronize' });
    const envelope = await security.verify(
      Buffer.from(body, 'utf8'),
      signingHeaders(body, SECRET_PREVIOUS),
    );
    expect(envelope.signatureKeyVersion).toBe('v1');
  });

  it('rejects byte mutation, wrong keys, algorithm confusion, and bad grammar', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const headers = signingHeaders(body);

    // Single-byte mutation of the body.
    const mutated = Buffer.from(JSON.stringify({ action: 'closed' }), 'utf8');
    await expect(security.verify(mutated, headers)).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });

    // Wrong-key signature.
    await expect(
      security.verify(Buffer.from(body), signingHeaders(body, 'wrong')),
    ).rejects.toMatchObject({
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });

    // Algorithm confusion: sha1= accepted by legacy systems must fail here.
    const sha1Sig = `sha1=${createHmac('sha1', SECRET_CURRENT).update(body).digest('hex')}`;
    await expect(
      security.verify(Buffer.from(body), { ...headers, 'x-hub-signature-256': sha1Sig }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });

    // Grammar attacks: uppercase hex, missing prefix, trailing junk.
    for (const bad of [
      `sha256=${createHmac('sha256', SECRET_CURRENT).update(body).digest('hex').toUpperCase()}`,
      createHmac('sha256', SECRET_CURRENT).update(body).digest('hex'),
      `sha256=${'a'.repeat(64)} `,
    ]) {
      await expect(
        security.verify(Buffer.from(body), { ...headers, 'x-hub-signature-256': bad }),
      ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
  });

  it('requires delivery/event headers within bounded shapes', async () => {
    const body = JSON.stringify({ ok: true });
    const base = signingHeaders(body);
    await expect(
      security.verify(Buffer.from(body), { ...base, 'x-github-delivery': '../escape' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
    await expect(
      security.verify(Buffer.from(body), { ...base, 'x-github-event': 'PULL_REQUEST' }),
    ).rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
  });
});

describe('C094 transactional delivery acceptance', () => {
  function storeWith(existing?: {
    digest: string;
    status: string;
  }): WebhookDeliveryStore & { calls: number } {
    return {
      calls: 0,
      async acceptDelivery(record) {
        this.calls += 1;
        if (existing === undefined) {
          existing = { digest: record.payloadDigest, status: 'PERSISTED' };
          return { outcome: 'accepted_new', status: 'ENQUEUED' };
        }
        if (existing.digest === record.payloadDigest) {
          return { outcome: 'duplicate', status: 'PERSISTED' };
        }
        return { outcome: 'conflict', existingStatus: 'PROCESSED' };
      },
    };
  }

  const security = new WebhookSecurityService({
    getVerificationKeys: async () => [{ version: 'v2', secret: SECRET_CURRENT }],
  });
  const acceptanceService = new WebhookAcceptanceService(storeWith());

  function verifiedEnvelopeFor(body: string) {
    return security.verify(Buffer.from(body, 'utf8'), signingHeaders(body));
  }

  it('accepts new deliveries as 202 and duplicates as 200 without new work', async () => {
    const body = JSON.stringify({ action: 'opened', pull_request: { id: 1 } });
    const store = storeWith();
    const acceptance = new WebhookAcceptanceService(store);
    const envelope = await verifiedEnvelopeFor(body);
    void acceptanceService;
    const first = await acceptance.accept(envelope, JSON.parse(body));
    expect(first.httpStatus).toBe(202);
    expect(first.outcome).toBe('accepted_new');

    // Replay with same bytes → duplicate semantics.
    const replay = await acceptance.accept(envelope, JSON.parse(body));
    expect(replay.outcome).toBe('duplicate');
    expect(replay.httpStatus).toBe(200);
    expect(store.calls).toBe(2); // store dedupes; no second enqueue effect
  });

  it('rejects same-ID/different-digest deliveries with a conflict', async () => {
    const bodyA = JSON.stringify({ action: 'opened' });
    const envelopeA = await verifiedEnvelopeFor(bodyA);
    const store = storeWith({ digest: 'different-digest', status: 'PROCESSED' });
    const acceptance = new WebhookAcceptanceService(store);
    await expect(acceptance.accept(envelopeA, JSON.parse(bodyA))).rejects.toMatchObject({
      code: 'WEBHOOK_DELIVERY_CONFLICT',
    });
  });
});

describe('C094 CORS / CSRF / origin policy', () => {
  const policy = new OriginPolicy(['https://app.devguard.dev', 'https://preview.devguard.dev']);

  it('matches exact normalized origins only — never suffix or scheme tricks', () => {
    expect(policy.isAllowed('https://app.devguard.dev')).toBe(true);
    expect(policy.isAllowed('https://APP.DEVGUARD.DEV')).toBe(true); // case-insensitive host
    expect(policy.isAllowed('https://evil-app.devguard.dev')).toBe(false); // suffix trick
    expect(policy.isAllowed('https://app.devguard.dev.evil.com')).toBe(false);
    expect(policy.isAllowed('http://app.devguard.dev')).toBe(false); // mixed scheme
    expect(policy.isAllowed('null')).toBe(false);
    expect(policy.isAllowed(undefined)).toBe(false);
  });

  it('evaluateCors denies by default and varies on allowlist hits', () => {
    const denied = policy.evaluateCors('https://random.example');
    expect(denied.allowed).toBe(false);
    const allowed = policy.evaluateCors('https://preview.devguard.dev');
    expect(allowed.allowed).toBe(true);
    expect(allowed.varyOrigin).toBe(true);
  });

  it('fetch metadata defaults conservatively when the header is absent', () => {
    expect(fetchMetadataSite(undefined)).toBe('none');
    expect(fetchMetadataSite('cross-site')).toBe('cross-site');
  });

  it('blocks cookie-authenticated mutations without a valid CSRF pair or approved origin', () => {
    const base = {
      method: 'POST',
      cookieToken: 'csrf-cookie-value',
      headerToken: 'csrf-cookie-value',
      origin: 'https://app.devguard.dev',
      secFetchSite: 'same-origin' as const,
      publicOrigin: 'https://app.devguard.dev',
      bearerAuthenticated: false,
      webhookPath: false,
    };
    expect(verifyCsrf(base).allowed).toBe(true);

    expect(verifyCsrf({ ...base, headerToken: 'mismatched' }).reasonCode).toBe(
      'csrf_pair_mismatch',
    );
    expect(verifyCsrf({ ...base, headerToken: undefined }).reasonCode).toBe('csrf_pair_missing');
    expect(verifyCsrf({ ...base, origin: 'https://evil.example' }).reasonCode).toBe(
      'origin_disallowed',
    );
    expect(verifyCsrf({ ...base, secFetchSite: 'cross-site' }).reasonCode).toBe(
      'cross_site_blocked',
    );

    // Bearer-only non-browser call without cookies is exempt (no ambient cookies).
    expect(verifyCsrf({ ...base, cookieToken: undefined, bearerAuthenticated: true }).allowed).toBe(
      true,
    );

    // GET requests are never CSRF-blocked.
    expect(verifyCsrf({ ...base, method: 'GET', headerToken: undefined }).allowed).toBe(true);
  });
});

describe('C094 rate-limit policies', () => {
  class FakeRedisLimiter implements DistributedRateLimiterPort {
    private counters = new Map<string, number>();
    private available = true;
    constructor(private readonly limit: number) {}
    setAvailability(value: boolean): void {
      this.available = value;
    }
    reset(): void {
      this.counters.clear();
    }
    async consume(
      key: string,
    ): Promise<{ allowed: boolean; retryAfterSeconds: number; remaining: number }> {
      if (!this.available) throw new Error('redis_down');
      const next = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, next);
      return {
        allowed: next <= this.limit,
        retryAfterSeconds: next > this.limit ? 60 : 0,
        remaining: Math.max(0, this.limit - next),
      };
    }
  }

  it('builds hierarchical pseudonymous keys (no raw ids)', () => {
    const key = hierarchicalRateKey('workflow_start', ['user-123', 'repo-456', '203.0.113.9']);
    expect(key.startsWith('workflow_start:')).toBe(true);
    expect(key).not.toContain('user-123');
    expect(key).not.toContain('repo-456');
    expect(key).not.toContain('203.0.113.9');
  });

  it('fails CLOSED for high-risk classes when the limiter is down', async () => {
    const inner = new FakeRedisLimiter(RATE_POLICIES['approval_resolve'].limit);
    inner.setAvailability(false);
    const limiter = new FailClosedRateLimiter(inner);
    const decision = await limiter.consume('approval_resolve', ['user-1']);
    expect(decision.allowed).toBe(false);
    expect(decision.failClosed).toBe(true);
  });

  it('degrades OPEN only for low-risk classes, with a hint flag', async () => {
    const inner = new FakeRedisLimiter(RATE_POLICIES['artifact_download'].limit);
    inner.setAvailability(false);
    const limiter = new FailClosedRateLimiter(inner);
    const decision = await limiter.consume('artifact_download', ['user-1']);
    expect(decision.allowed).toBe(true);
    expect(decision.failClosed).toBe(true);
  });

  it('counts atomically per distinct key and returns 429 metadata after the limit', async () => {
    const inner = new FakeRedisLimiter(3);
    const limiter = new FailClosedRateLimiter(inner);
    let lastDecision = await limiter.consume('auth_login', ['u1']);
    for (let index = 0; index < 5 && !lastDecision.failClosed; index += 1) {
      lastDecision = await limiter.consume('auth_login', ['u1']);
      if (!lastDecision.allowed) break;
      // A different user's bucket is unaffected by user-1's count.
      const other = await limiter.consume('auth_login', ['u2']);
      expect(other.allowed).toBe(true);
    }
    expect(lastDecision.allowed).toBe(false);
    expect(lastDecision.retryAfterSeconds).toBeGreaterThan(0);
  });
});
