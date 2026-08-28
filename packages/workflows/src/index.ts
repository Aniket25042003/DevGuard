/**
 * @devguard/workflows — Durable workflow engine (C045-C060): versioned registry,
 * run/step FSM orchestration, (this train) executor concurrency/retry/locks and
 * validation/completion aggregation, and in later trains product workflows.
 * Provider-neutral application layer; SDK types and SQL row shapes never cross.
 */
import './errors.js';

// ---- C047 workflow executor ----
export {
  EXECUTOR_SCHEMA_VERSION,
  EXECUTOR_ATTEMPT_STATES,
  LOCK_STATES,
  RETRY_CLASSES,
  WorkflowExecutor,
  RetryClassifier,
  InMemoryLockManager,
  type ExecuteStepJob,
  type ExecutorAttemptState,
  type ExecutorCommandPort,
  type ExecutorDeps,
  type LockResult,
  type LockState,
  type RetryClass,
  type RetryDisposition,
  type StepHandler,
} from './executor/executor.js';

// ---- C048 validation / completion / failure ----
export {
  VALIDATION_SCHEMA_VERSION,
  VALIDATION_ITEM_STATES,
  GATE_STATES,
  ValidationAggregator,
  NoopFreshnessEvaluator,
  InMemoryOutcomeStore,
  validationContractsSchema,
  workflowOutcomeKindSchema,
  type AggregateVerdict,
  type FreshnessEvaluator,
  type GateState,
  type OutcomeCommitStorePort,
  type OutcomeEvidenceInput,
  type ValidationItemState,
  type ValidationResult,
  type WorkflowOutcome,
  type WorkflowOutcomeKind,
} from './validation/aggregator.js';
