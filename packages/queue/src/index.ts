/**
 * @devguard/queue — durable delivery substrate (C057).
 *
 * Boundary rule: queue state proves delivery/lease status ONLY. Workflow,
 * approval, action and outbox state stay authoritative in PostgreSQL
 * (C008/C009–C012); Redis-style transports are swappable behind QueueTransport.
 */
export {
  JOB_TYPES_V1,
  QUEUE_NAMES,
  EnvelopeValidationError,
  JobRegistry,
  buildEnvelope,
  dlqFor,
  type DuplicateRegistrationError,
} from './envelope.js';
export type {
  HandlerContext,
  JobEnvelope,
  JobHandler,
  JobHandlerResult,
  JobTypeV1,
  QueueName,
} from './envelope.js';

export {
  CancellationFence,
  InMemoryTransport,
  QUEUE_RETRY_DEFAULTS,
  backoffDelayMs,
  type QueueTransport,
  type RetryOptions,
  type StallDetection,
} from './retry.js';

export {
  Queue,
  WorkerRuntime,
  type EnqueueResult,
  type QueuePortShape,
  type WorkerRuntimeOptions,
} from './runtime.js';
