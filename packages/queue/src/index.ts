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

// ---- C058 webhook + workflow processing jobs ----
export {
  WEBHOOK_DELIVERY_STATES,
  resolveDeliveryEdge,
  type DeliveryStorePort,
  type DeliveryVerdict,
  type JobOutcome,
  type TriggerRouter,
  type WebhookDeliveryState,
  type WebhookProcessingJob,
  type WorkflowCreator,
  type WorkflowExecutionJob,
} from './jobs/contracts.js';
export {
  WebhookProcessingService,
  WorkflowExecutionJobService,
  InMemoryDeliveryStore,
  type StepExecutor,
  type WebhookProcessingDeps,
  type WorkflowExecutionDeps,
} from './jobs/job-processing.js';

// ---- C060 retry / DLQ / outbox cleanup ----
export {
  RETRY_CLASSES,
  RetryClassifier,
  OutboxCleanupService,
  InMemoryOutboxStore,
  type OutboxCleanupDeps,
  type OutboxRow,
  type OutboxStorePort,
  type RetryClass,
  type RetryDecision,
} from './jobs/cleanup.js';

// ---- C059 approval resumption / expiry ----
export {
  APPROVAL_RESUME_STATES,
  ApprovalResumeService,
  InMemoryApprovalStore,
  type ApprovalRecord,
  type ApprovalResolution,
  type ApprovalResumeDeps,
  type ApprovalResumeState,
  type ApprovalStorePort,
  type ResumeExecutorPort,
  type ResumeOutcome,
} from './jobs/approval-resume.js';
