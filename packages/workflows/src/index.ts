/**
 * @devguard/workflows — Durable workflow engine (C045-C060): versioned registry,
 * run/step FSM orchestration, executor concurrency/retry/locks and
 * validation/completion aggregation, and in later trains product workflows.
 * Provider-neutral application layer; SDK types and SQL row shapes never cross.
 */
import './errors.js';

// ---- C052 product workflow: security_patch ----
export {
  SECURITY_PATCH_STEPS,
  SECURITY_PATCH_ALLOWED_ACTIONS,
  SECURITY_PATCH_DEFINITION_ID,
  SECURITY_PATCH_DEFINITION_VERSION,
  securityPatchDefinition,
  type PatchStep,
} from './product/security-patch.js';

// ---- C051 product workflow: security_audit ----
export {
  SECURITY_AUDIT_STEPS,
  SECURITY_AUDIT_ALLOWED_ACTIONS,
  SECURITY_AUDIT_DEFINITION_ID,
  SECURITY_AUDIT_DEFINITION_VERSION,
  securityAuditDefinition,
  type AuditStep,
} from './product/security-audit.js';

// ---- C050 product workflow: diagnose_failure ----
export {
  DIAGNOSE_FAILURE_STEPS,
  DIAGNOSE_FAILURE_ALLOWED_ACTIONS,
  DIAGNOSE_FAILURE_DEFINITION_ID,
  DIAGNOSE_FAILURE_DEFINITION_VERSION,
  diagnoseFailureDefinition,
  type FailureStep,
} from './product/diagnose-failure.js';

// ---- C054 product workflow: review_remediation ----
export {
  REVIEW_REMEDIATION_STEPS,
  REVIEW_REMEDIATION_ALLOWED_ACTIONS,
  REVIEW_REMEDIATION_CYCLE_BUDGET,
  REVIEW_REMEDIATION_DEFINITION_ID,
  REVIEW_REMEDIATION_DEFINITION_VERSION,
  reviewRemediationDefinition,
  type ReviewStep,
} from './product/review-remediation.js';

// ---- C049 product workflow: implement_issue ----
export {
  IMPLEMENT_ISSUE_STEPS,
  IMPLEMENT_ISSUE_ALLOWED_ACTIONS,
  IMPLEMENT_ISSUE_ARTIFACTS,
  IMPLEMENT_ISSUE_DEFINITION_ID,
  IMPLEMENT_ISSUE_DEFINITION_VERSION,
  IMPLEMENT_ISSUE_REQUIRED_CAPABILITIES,
  implementIssueDefinition,
  validateDefinition,
  type DefinitionValidation,
  type ProductStep,
} from './product/implement-issue.js';

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

// ---- C045 workflow definition registry + skills ----
export {
  WORKFLOW_DEFINITION_SCHEMA_VERSION,
  DEFINITION_STATUSES,
  TRUST_TIERS,
  workflowDefinitionContractsSchema,
  workflowDefinitionSchema,
  skillAssetSchema,
  stepTemplateSchema,
  type DefinitionStatus,
  type SkillAsset,
  type TrustTier,
  type WorkflowCatalogEntry,
  type WorkflowDefinition,
  type WorkflowDefinitionSnapshot,
  type WorkflowStepTemplate,
  type RegisterResult,
} from './definitions/contracts.js';
export {
  WorkflowDefinitionRegistry,
  canonicalDigest,
  sha256,
  type RegistryKnownIds,
  type WorkflowDefinitionRegistryDeps,
} from './definitions/registry.js';

// ---- C046 run/step orchestration ----
export {
  WORKFLOW_RUN_SCHEMA_VERSION,
  RUN_STATES,
  STEP_STATES,
  runSchema,
  workflowRunContractsSchema,
  type LaunchWorkflowInput,
  type RunState,
  type StepState,
  type WorkflowRun,
  type WorkflowRunStep,
} from './runs/contracts.js';
export {
  resolveRunEdge,
  resolveStepEdge,
  type RunTrigger,
  type RunVerdict,
  type StepTrigger,
  type StepVerdict,
} from './runs/fsm.js';
export {
  WorkflowRunOrchestrator,
  InMemoryRunStore,
  type LaunchResult,
  type RunOrchestratorDeps,
  type RunStorePort,
} from './runs/run-orchestrator.js';
