/**
 * C065/C075 — GitHub webhook acceptance route + repository catalog.
 *
 * POST /api/v1/webhooks/github — HMAC-verifies the raw body (bounded, captured
 *   by the kernel) BEFORE any parsing; on success returns 202 with the delivery
 *   id claimed by the ingress; duplicates replay the same acceptance. Never
 *   lets an unsigned body reach a handler.
 * GET  /api/v1/repositories  — session-required authorized catalog projection.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RegisterV1Route } from '../transport/kernel.js';

export interface WebhookAcceptancePort {
  accept(input: {
    deliveryId: string;
    event: string;
    payloadJson: string;
    headers: { signature: string };
  }): Promise<{ accepted: boolean; replay?: boolean }>;
}

export function registerWebhookRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  accept: WebhookAcceptancePort,
  secret: () => string | undefined,
  verifyHmac: (secretKey: string, expected: string, rawBytes: Uint8Array) => boolean,
): void {
  kernel.registerV1Route(
    'post',
    '/api/v1/webhooks/github',
    { rateLimitClass: 'default', authClass: 'public' },
    async (c) => {
      const rawBody = c.get('rawBody');
      const signatureHeader = c.req.header('x-hub-signature-256') ?? '';
      const event = c.req.header('x-github-event') ?? '';
      const deliveryHeader = c.req.header('x-github-delivery') ?? '';
      const secretKey = secret();
      if (secretKey === undefined || rawBody === undefined) {
        return c.json(
          {
            error: {
              code: 'WEBHOOK_SIGNATURE_INVALID',
              message: 'Webhook signature invalid.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      }
      if (!verifyHmac(secretKey, signatureHeader, new Uint8Array(rawBody))) {
        return c.json(
          {
            error: {
              code: 'WEBHOOK_SIGNATURE_INVALID',
              message: 'Webhook signature invalid.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      }
      if (event.length === 0 || deliveryHeader.length === 0) {
        return c.json(
          {
            error: {
              code: 'WEBHOOK_HEADERS_INVALID',
              message: 'Webhook event and delivery headers are required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          400,
        );
      }
      const payloadJson = Buffer.from(rawBody).toString('utf8');
      const result = await accept.accept({
        deliveryId: deliveryHeader,
        event,
        payloadJson,
        headers: { signature: signatureHeader },
      });
      if (!result.accepted) {
        return c.json(
          {
            error: {
              code: 'WEBHOOK_REJECTED',
              message: 'Webhook not accepted.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          400,
        );
      }
      c.status(202);
      return c.json({ accepted: true, deliveryId: deliveryHeader });
    },
  );
}

export interface Repository {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly owner?: string | undefined;
  readonly fullName?: string | undefined;
  readonly status?: string | undefined;
  readonly defaultBranch?: string | undefined;
  readonly installationId?: string | undefined;
}

export interface RepositoryCatalogPort {
  listFor(userId: string): Promise<readonly Repository[]>;
  /** Optional detail lookup used by repository-scoped command policy. */
  findById?(repositoryId: string): Promise<Repository | null>;
}

export function registerRepositoryRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  catalog: RepositoryCatalogPort | undefined,
): void {
  const catalogFor = catalog ?? {
    async listFor(_userId: string): Promise<readonly Repository[]> {
      // No durable repo linkage yet (C009/C014/C018); a truthful empty catalog.
      return [];
    },
  };
  kernel.registerV1Route(
    'get',
    '/api/v1/repositories',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined) {
        return c.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      }
      const repos = await catalogFor.listFor(principal.userId);
      return c.json({ repositories: repos });
    },
  );
}

/** Constant-time HMAC-SHA256 verification of `sha256=<hex>` header. */
export function verifyGithubHmac(
  secretKey: string,
  expected: string,
  rawBytes: Uint8Array,
): boolean {
  const expectedHex = expected.startsWith('sha256=') ? expected.slice('sha256='.length) : '';
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actual = createHmac('sha256', secretKey).update(rawBytes).digest();
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  return actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf);
}
