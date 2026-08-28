/**
 * @devguard/workflows — Durable workflow engine (C045-C060): versioned registry,
 * run/step FSM orchestration, and (in later trains) executor concurrency,
 * validation/completion and product workflows. Provider-neutral application
 * layer; SDK types and SQL row shapes never cross.
 */
import './errors.js';

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
