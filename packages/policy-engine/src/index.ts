/**
 * @devguard/policy-engine — canonical repository-policy pipeline (C023).
 *
 * Boundary rule: only canonical policy objects cross into the policy domain;
 * parser values and library nodes stop at the decoder. No provider SDK types
 * and no LLM-assisted behavior exist here — parsing/normalization/validation
 * are fully deterministic (C023 §2).
 */
export {
  POLICY_LIMIT_DEFAULTS,
  POLICY_LIMIT_GLOBAL_CAPS,
  policyLimits,
  repositoryPolicyV1,
  type CanonicalPolicyDocument,
  type PolicyLimits,
  type RepositoryPolicyV1,
  type RepositoryPolicyV1Input,
} from './schema/policy-v1.js';

export {
  PolicyValidationReport,
  errorToDiagnostic,
  httpStatusFor,
  MAX_DIAGNOSTICS,
  type PolicyDiagnostic,
  type PolicyDiagnosticCode,
  type SourceLocation,
} from './schema/diagnostics.js';

export { DECODE_LIMITS, PolicyDecoder, type DecodedDocument } from './parsing/decoder.js';
export {
  EMPTY_REGISTRIES,
  validateSemantics,
  type RegistryLookups,
  type SemanticContext,
} from './validation/semantic.js';
export {
  canonicalHash,
  canonicalJson,
  canonicalizationIsStable,
  effectiveLimits,
  normalizePolicyV1,
} from './normalization/canonical.js';

export {
  POLICY_VERSION_STATUSES,
  buildVersionRecord,
  canTransition,
  type ActivatePolicyVersionInput,
  type PolicySnapshot,
  type PolicyVersionRecord,
  type PolicyVersionRepositoryPort,
  type PolicyVersionStatus,
  type RegistryBindingVersions,
} from './versioning/version.js';

export {
  PolicyDocumentService,
  type CreatePolicyVersionInput,
  type PolicyDocumentServiceOptions,
  type PolicySource,
  type ValidatePolicyResult,
} from './service.js';

// ---- C024 action taxonomy + tool registry ----
export {
  ACTION_CATEGORIES,
  ACTION_DEFINITIONS,
  findActionDefinition,
  normalizeActionId,
  validateCatalog,
  type ActionCategory,
  type CanonicalActionId,
  type ActionDefinition,
  type ExecutionObligation,
} from './actions/catalog.js';
export {
  PROVIDER_IDS,
  TOOL_STATUSES,
  RegistryBuildError,
  buildRegistry,
  versionSatisfies,
  type ActionMetadata,
  type ProviderCapabilityManifest,
  type ProviderId,
  type RawProviderToolCall,
  type RegisteredTool,
  type RegistrySnapshot,
  type ResolveResult,
  type ToolDefinitionInput,
  type ToolStatus,
} from './tools/registry.js';

// ---- C025 contextual risk classification ----
export {
  CLASSIFIER_VERSION,
  CONTEXT_RISK_RULES,
  classify,
  compareClassifications,
  looksSensitivePath,
  type ContextRiskRule,
} from './classification/rules.js';
export {
  RISK_LATTICE,
  actionContext,
  isTrustedFact,
  joinRisks,
  monotonic,
  provenance,
  rankOf,
  targetDescriptor,
  type ActionContext,
  type Classification,
  type LatticeRisk,
  type Provenance,
  type RiskFactor,
} from './classification/lattice.js';

// ---- C026 command risk analysis ----
export {
  analyzeCommand,
  analyzeShellSource,
  networkRequest,
  relativePath,
  sandboxCommandProposal,
  type CommandClass,
  type CommandClassification,
  type SandboxCommandProposal,
} from './commands/analyzer.js';

// ---- C027 global safety + autonomy ceilings ----
export {
  AUTONOMY_PROFILES,
  GLOBAL_RULES,
  GLOBAL_SAFETY_VERSION,
  RESTRICTION_SOURCES,
  profileForLevel,
  type AutonomyProfile,
  type GlobalRule,
  type Restriction,
  type RestrictionSource,
  type SafetyCatalogSnapshot,
} from './safety/catalog.js';
export {
  restrictionRank,
  SafetyCatalogError,
  SafetyConstraintService,
  type ClassifiedActionRef,
} from './safety/service.js';

// ---- C028 invocation policy ----
export {
  COMMAND_ALIASES_V1,
  CommandUnknownError,
  INVOCATION_REGISTRY_VERSION,
  MANUAL_COMMANDS_V1,
  TRIGGER_IDS_V1,
  WORKFLOW_IDS_V1,
  normalizeCommandId,
  normalizeWorkflowId,
  triggerFilter,
  type ManualCommandDefinition,
  type TriggerFilter,
  type TriggerIdV1,
  type TriggerRule,
  type WorkflowIdResult,
  type WorkflowIdV1,
} from './invocation/registry.js';
export { validateManualCommandInput } from './invocation/command-input.js';
export {
  invocationDedupeKey,
  ManualCommandRegistry,
  TriggerMatcher,
  type ManualCommandRequest,
  type ManualResult,
  type MatchedCandidate,
  type MatchResult,
  type NormalizedEvent,
  type PolicyTriggerSnapshot,
} from './invocation/matcher.js';

// ---- C029 validation gates ----
export {
  DEFAULT_OBLIGATIONS,
  EVIDENCE_STATUSES,
  GATE_KINDS,
  VALIDATOR_IDS_V1,
  mergeObligations,
  validationEvidence,
  type EvidenceStatus,
  type GateKind,
  type ValidationEvidence,
  type ValidationObligation,
} from './validation-gates/schemas.js';
export {
  ValidationGateService,
  type GateContext,
  type GateOutcome,
  type ObligationAssessment,
} from './validation-gates/gates.js';

// ---- C030 policy evaluator ----
export {
  EVALUATOR_VERSION,
  PolicyEvaluationService,
  DecisionStoreUnavailableError,
  evaluatePrecedence,
  inputFingerprint as evaluationInputFingerprint,
  mergeSnapshotWithCurrent,
  type AuthorizedActionToken,
  type DecisionPersistencePort,
  type DecisionEffect,
  type EvaluationInput,
  type EvaluationOutcome,
  type EvaluationRequest,
  type MatchedRule,
  type PolicyDecisionRecord,
  type RiskClass5,
} from './evaluator/service.js';
export type { EvaluationInput as PrecedenceEvaluationInput } from './evaluator/precedence.js';
