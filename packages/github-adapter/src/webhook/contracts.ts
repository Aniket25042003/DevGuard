/**
 * C022 §8/§9/§10 — GitHub webhook ingress contracts.
 *
 * Bytes are authenticated (HMAC over the exact raw body) before any parsing;
 * the delivery is durably claimed before acknowledgement; duplicates track the
 * original; unsupported/unknown events are ignored/audited, never errors. Raw
 * payload is untrusted sensitive data with a short TTL; only digests and safe
 * normalized fields survive long-term.
 */
import { z } from 'zod';

export const WEBHOOK_SCHEMA_VERSION = 1 as const;

export const DELIVERY_STATES = [
  'accepted',
  'dispatch_pending',
  'processing',
  'reconciling',
  'routed',
  'ignored',
  'retry_wait',
  'dead_lettered',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = [
  'routed',
  'ignored',
  'dead_lettered',
];

export const WEBHOOK_EVENTS = [
  'issues',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'check_run',
  'push',
  'workflow_run',
  'installation',
  'ping',
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export const eventHeaderSchema = z.string().min(1).max(128);

/** Strict normalized webhook headers (duplicates/conflicts rejected upstream). */
export const githubWebhookHeadersSchema = z
  .object({
    deliveryId: z.string().min(1).max(128),
    event: eventHeaderSchema,
    signature: z.string().min(8).max(512),
    userAgent: z.string().max(512).optional(),
    contentType: z.string().max(64).optional(),
  })
  .strict();
export interface GitHubWebhookHeaders {
  readonly deliveryId: string;
  readonly event: string;
  readonly signature: string;
  readonly userAgent?: string | undefined;
  readonly contentType?: string | undefined;
}

export interface SafeRemoteMetadata {
  readonly ip?: string | undefined;
  readonly tlsVersion?: string | undefined;
}

export type WebhookAcceptance =
  | { readonly kind: 'accepted'; readonly deliveryId: string }
  | {
      readonly kind: 'duplicate';
      readonly deliveryId: string;
      readonly currentState: DeliveryState;
    }
  | {
      readonly kind: 'rejected';
      readonly code: 'SIGNATURE_INVALID' | 'HEADERS_INVALID' | 'PAYLOAD_TOO_LARGE';
    };

export const deliveryLedgerRowSchema = z
  .object({
    deliveryId: z.string().min(1).max(128),
    event: eventHeaderSchema,
    signatureVersion: z.number().int().nonnegative(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    payloadBytes: z
      .number()
      .int()
      .nonnegative()
      .max(10 * 1024 * 1024),
    state: z.enum(DELIVERY_STATES),
    attempts: z.number().int().nonnegative(),
    receivedAtIso: z.string().min(1).max(40),
    completedAtIso: z.string().min(1).max(40).optional(),
    lastErrorCode: z.string().max(64).optional(),
  })
  .strict();
export interface DeliveryLedgerRow {
  readonly deliveryId: string;
  readonly event: string;
  readonly signatureVersion: number;
  readonly payloadHash: string;
  readonly payloadBytes: number;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly receivedAtIso: string;
  readonly completedAtIso?: string | undefined;
  readonly lastErrorCode?: string | undefined;
}

export const normalizedWebhookEventSchema = z
  .object({
    event: eventHeaderSchema,
    action: z.string().max(64).optional(),
    repository: z
      .object({
        owner: z.string().min(1).max(100),
        repo: z.string().min(1).max(100),
        providerRepositoryId: z.string().min(1).max(128),
        defaultBranch: z.string().max(256).optional(),
      })
      .strict()
      .optional(),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    prNumber: z.number().int().positive().optional(),
    issueNumber: z.number().int().positive().optional(),
    providerInstallationId: z.string().min(1).max(128).optional(),
    semantic: z.object({}).passthrough().optional(),
  })
  .strict();
export interface NormalizedWebhookEvent {
  readonly event: string;
  readonly action?: string | undefined;
  readonly repository?:
    | {
        readonly owner: string;
        readonly repo: string;
        readonly providerRepositoryId: string;
        readonly defaultBranch?: string | undefined;
      }
    | undefined;
  readonly headSha?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly issueNumber?: number | undefined;
  readonly providerInstallationId?: string | undefined;
  readonly semantic?: Readonly<Record<string, unknown>> | undefined;
}

export const webhookContractsSchema = {
  githubWebhookHeadersSchema,
  deliveryLedgerRowSchema,
  normalizedWebhookEventSchema,
  eventHeaderSchema,
};
