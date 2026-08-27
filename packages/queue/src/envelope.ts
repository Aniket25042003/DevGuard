/**
 * C057 §4/§8 — queue names, typed job envelopes and the JobRegistry.
 *
 * Every {jobType, schemaVersion} registers EXACTLY one handler; unknown types
 * or versions fail closed (JOB_UNKNOWN). Envelopes carry correlation context
 * so it survives the outbox→queue→worker boundary (C061 propagation).
 */
export const QUEUE_NAMES = [
  'webhook-processing',
  'workflow-execution',
  'sandbox-monitoring',
  'approval-resume',
  'outbox-publishing',
  'cleanup',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function dlqFor(queue: QueueName): `${QueueName}-dlq` {
  return `${queue}-dlq` as `${QueueName}-dlq`;
}

import type { LoggerPort } from '@devguard/logging';

/** Known job types per C058/C059/C060 consumers; versioned payloads. */
export const JOB_TYPES_V1 = [
  'webhook.process', // C058
  'workflow.execute', // C058/C047
  'approval.resume', // C059
  'outbox.publish', // C060
  'sandbox.monitor', // C058 monitor loop
  'cleanup.retention', // C012 retention executor
] as const;

export type JobTypeV1 = (typeof JOB_TYPES_V1)[number];

const MAX_PAYLOAD_BYTES = 32 * 1024;

/**
 * Envelope v1: payloads contain IDs/snapshots only — never secrets, tokens,
 * raw provider bodies or large source/log content (C057 §8).
 */
export interface JobEnvelope<TType extends string = string, TPayload = Record<string, unknown>> {
  readonly envelopeVersion: 1;
  readonly jobId: string;
  readonly jobType: TType;
  readonly schemaVersion: number;
  readonly queue: QueueName;
  /** Deterministic uniqueness key; equals jobId by construction. */
  readonly uniqueKey: string;
  readonly payload: TPayload;
  readonly tenantId?: string | undefined;
  readonly repositoryId?: string | undefined;
  readonly workflowRunId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly actionId?: string | undefined;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly traceparent?: string | undefined;
  readonly cancellationGeneration: number;
  readonly enqueuedAtIso: string;
}

export class EnvelopeValidationError extends Error {}

export function buildEnvelope<TPayload extends Record<string, unknown>>(
  input: {
    jobType: JobTypeV1;
    schemaVersion: number;
    queue: QueueName;
    uniqueKey: string;
    payload: TPayload;
    correlationId: string;
    cancellationGeneration?: number | undefined;
    now?: () => number;
  } & Partial<
    Pick<
      JobEnvelope,
      | 'repositoryId'
      | 'workflowRunId'
      | 'sessionId'
      | 'actionId'
      | 'tenantId'
      | 'causationId'
      | 'traceparent'
    >
  >,
): JobEnvelope {
  const payloadBytes = Buffer.byteLength(JSON.stringify(input.payload), 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new EnvelopeValidationError(
      `payload ${payloadBytes}B exceeds ${MAX_PAYLOAD_BYTES}B budget`,
    );
  }
  for (const key of ['password', 'token', 'secret', 'authorization'] as const) {
    if (key in input.payload) {
      throw new EnvelopeValidationError(`forbidden payload field '${key}'`);
    }
  }
  return Object.freeze({
    envelopeVersion: 1 as const,
    jobId: `env1:${input.jobType}:${input.uniqueKey}`,
    jobType: input.jobType,
    schemaVersion: input.schemaVersion,
    queue: input.queue,
    uniqueKey: input.uniqueKey,
    payload: input.payload,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.repositoryId !== undefined ? { repositoryId: input.repositoryId } : {}),
    ...(input.workflowRunId !== undefined ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
    correlationId: input.correlationId,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : {}),
    cancellationGeneration: input.cancellationGeneration ?? 0,
    enqueuedAtIso: new Date((input.now ?? Date.now)()).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Handler registry: exactly one handler per {jobType, schemaVersion}.
// ---------------------------------------------------------------------------

export interface HandlerContext {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly leaseToken: string;
  readonly logger?: LoggerPort | undefined;
  signal: AbortSignal | undefined;
}

export type JobHandlerResult =
  | { readonly outcome: 'SUCCEEDED'; readonly detail?: string | undefined }
  | {
      readonly outcome: 'RETRYABLE_FAILURE';
      readonly errorCode: string;
      readonly detail?: string | undefined;
    }
  | {
      readonly outcome: 'PERMANENT_FAILURE';
      readonly errorCode: string;
      readonly detail?: string | undefined;
    };

export type JobHandler = (envelope: JobEnvelope, ctx: HandlerContext) => Promise<JobHandlerResult>;

interface Registration {
  readonly handler: JobHandler;
}

export class DuplicateRegistrationError extends Error {}
export class UnknownJobTypeError extends Error {}

export class JobRegistry {
  #handlers = new Map<string, Registration>();

  register(jobType: JobTypeV1, schemaVersion: number, handler: JobHandler): void {
    const key = `${jobType}@${schemaVersion}`;
    if (this.#handlers.has(key)) {
      throw new DuplicateRegistrationError(`duplicate handler registration for '${key}'`);
    }
    this.#handlers.set(key, { handler });
  }

  resolve(jobType: string, schemaVersion: number): JobHandler {
    const registration = this.#handlers.get(`${jobType}@${schemaVersion}`);
    if (!registration)
      throw new UnknownJobTypeError(`no handler registered for '${jobType}'@${schemaVersion}`);
    return registration.handler;
  }

  get size(): number {
    return this.#handlers.size;
  }
}
