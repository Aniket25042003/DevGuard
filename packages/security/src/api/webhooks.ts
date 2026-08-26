/**
 * C094 — GitHub webhook HMAC verification and transactional acceptance.
 *
 * Invariants:
 * - `X-Hub-Signature-256` verified over the EXACT unmodified raw bytes with
 *   HMAC-SHA-256 and constant-time comparison BEFORE any JSON parsing.
 * - Strict header grammar (`sha256=<64 lowercase hex>`) prevents algorithm
 *   confusion; current AND previous secret versions are honored during a
 *   bounded rotation window, recording which key version matched.
 * - Delivery acceptance is transactional: unique `(provider, deliveryId)`
 *   persistence plus enqueue intent in ONE store call. Duplicates resolve to
 *   the existing record; same-ID/different-digest is a conflict.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { makeError } from '@devguard/errors';

const MAX_WEBHOOK_BYTES = 1_048_576;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const EVENT_NAME_PATTERN = /^[a-z_]{1,64}$/;

export interface WebhookSecretProvider {
  /** Current + previous keys (bounded rotation window); version recorded on match. */
  getVerificationKeys(): Promise<
    ReadonlyArray<{ readonly version: string; readonly secret: string }>
  >;
}

export interface VerifiedWebhookEnvelope {
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly signatureKeyVersion: string;
  /** The object parsed from the HMAC-verified bytes — never caller-supplied. */
  readonly payload: Record<string, unknown>;
}

export class WebhookSecurityService {
  constructor(private readonly secrets: WebhookSecretProvider) {}

  async verify(
    rawBody: Uint8Array,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<VerifiedWebhookEnvelope> {
    if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_WEBHOOK_BYTES) {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', { cause: new Error('body size out of bounds') });
    }

    const signatureHeader = headers['x-hub-signature-256'];
    if (signatureHeader === undefined || typeof signatureHeader !== 'string') {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', {
        cause: new Error('missing signature header'),
      });
    }

    // Strict grammar: sha256= followed by exactly 64 lowercase hex chars.
    const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader);
    if (match === null) {
      // Algorithm confusion / malformed encoding → reject outright.
      throw makeError('WEBHOOK_SIGNATURE_INVALID', {
        cause: new Error('signature grammar invalid'),
      });
    }
    const providedHex = match[1] ?? '';

    const deliveryId = headers['x-github-delivery'];
    const eventType = headers['x-github-event'];
    if (
      typeof deliveryId !== 'string' ||
      !DELIVERY_ID_PATTERN.test(deliveryId) ||
      typeof eventType !== 'string' ||
      !EVENT_NAME_PATTERN.test(eventType)
    ) {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', {
        cause: new Error('delivery/event headers invalid'),
      });
    }

    const verificationKeys = await this.secrets.getVerificationKeys();
    if (verificationKeys.length === 0) {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', {
        cause: new Error('no verification keys configured'),
      });
    }

    // Constant-time comparison over the exact raw bytes per key version.
    let matchedVersion: string | undefined;
    for (const keyEntry of verificationKeys) {
      const expected = createHmac('sha256', keyEntry.secret).update(rawBody).digest();
      const provided = Buffer.from(providedHex, 'hex');
      if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
        matchedVersion = keyEntry.version;
        break;
      }
    }
    if (matchedVersion === undefined) {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', { cause: new Error('signature mismatch') });
    }

    // Parse ONLY after verification; body must be a JSON object, depth-bounded.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
    } catch {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', {
        cause: new Error('body not valid JSON after verification'),
      });
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', {
        cause: new Error('payload must be an object'),
      });
    }

    return {
      deliveryId,
      eventType,
      payloadDigest: createHash('sha256').update(rawBody).digest('hex'),
      signatureKeyVersion: matchedVersion,
      payload: payload as Record<string, unknown>,
    };
  }
}

// ---------------------------------------------------------------------------
// Transactional acceptance (delivery store port + state machine)
// ---------------------------------------------------------------------------

export type WebhookDeliveryStatus =
  'RECEIVED' | 'VERIFIED' | 'PERSISTED' | 'ENQUEUED' | 'PROCESSED' | 'REJECTED';

export interface WebhookDeliveryRecord {
  readonly provider: 'github';
  readonly deliveryId: string;
  readonly eventType: string;
  readonly repositoryExternalId?: string | undefined;
  readonly installationId?: string | undefined;
  readonly payloadDigest: string;
  readonly signatureKeyVersion: string;
  readonly receivedAt: string;
  readonly status: WebhookDeliveryStatus;
  readonly rejectionCode?: string | undefined;
}

export type AcceptanceOutcome =
  | { readonly outcome: 'accepted_new'; readonly status: 'PERSISTED' | 'ENQUEUED' }
  | { readonly outcome: 'duplicate'; readonly status: WebhookDeliveryStatus }
  | { outcome: 'conflict'; existingStatus: WebhookDeliveryStatus };

/**
 * Delivery store port: implementers MUST enforce unique (provider, deliveryId)
 * atomically and persist the enqueue intent together with PERSISTED status
 * (transactional outbox semantics arrive fully with C022/C008).
 */
export interface WebhookDeliveryStore {
  /**
   * Insert-or-return-existing. When a row exists:
   * - same digest → outcome duplicate (caller returns 200/202 without work);
   * - different digest → outcome conflict (audited, rejected).
   */
  acceptDelivery(record: WebhookDeliveryRecord): Promise<AcceptanceOutcome>;
}

export interface WebhookAcceptance {
  readonly outcome: AcceptanceOutcome['outcome'];
  readonly httpStatus: 200 | 202 | 409;
}

/** Payload shape gate: minimal structural requirements post-verification. */
const payloadSchema = z
  .object({
    action: z.string().max(64).optional(),
  })
  .loose();

export class WebhookAcceptanceService {
  constructor(private readonly store: WebhookDeliveryStore) {}

  async accept(
    envelope: VerifiedWebhookEnvelope,
    options: {
      readonly repositoryExternalId?: string | undefined;
      readonly installationId?: string | undefined;
    } = {},
  ): Promise<WebhookAcceptance> {
    // The validated payload IS the envelope's parsed signed bytes — there is
    // no caller-supplied object that could diverge from the HMAC'd body.
    const parsedPayload = payloadSchema.safeParse(envelope.payload);
    if (!parsedPayload.success) {
      throw makeError('WEBHOOK_SIGNATURE_INVALID', { cause: new Error('unsupported event shape') });
    }
    const record: WebhookDeliveryRecord = {
      provider: 'github',
      deliveryId: envelope.deliveryId,
      eventType: envelope.eventType,
      ...(options.repositoryExternalId !== undefined
        ? { repositoryExternalId: options.repositoryExternalId }
        : {}),
      ...(options.installationId !== undefined ? { installationId: options.installationId } : {}),
      payloadDigest: envelope.payloadDigest,
      signatureKeyVersion: envelope.signatureKeyVersion,
      receivedAt: new Date().toISOString(),
      status: 'VERIFIED',
    };
    const outcome = await this.store.acceptDelivery({ ...record, status: 'PERSISTED' });
    switch (outcome.outcome) {
      case 'accepted_new':
        return { outcome: 'accepted_new', httpStatus: 202 };
      case 'duplicate':
        return { outcome: 'duplicate', httpStatus: 200 };
      case 'conflict': {
        throw makeError('WEBHOOK_DELIVERY_CONFLICT', {
          details: { deliveryId: envelope.deliveryId },
          cause: new Error(`existing status ${outcome.existingStatus}`),
        });
      }
    }
  }
}
