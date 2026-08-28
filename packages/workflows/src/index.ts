/**
 * @devguard/workflows — durable workflow engine (C045-C056): versioned
 * definition registry and skill contracts (C045), run/step FSM (C046),
 * executor concurrency (C047), validation/completion (C048) and product
 * workflows.
 *
 * Provider-neutral application layer. Policy/evaluator, provider capability,
 * schema/tool catalogs and SQL persistence reach this package only through
 * typed ports; the composition root (apps) supplies concrete implementations.
 * Provider SDK types and row shapes never cross this boundary.
 */

// Error codes registered at package load.
import './errors.js';

export { canonicalize, digestJson, sha256Hex, CanonicalizationError } from './canonical.js';

export {
  compareSemver,
  maxSemver,
  parseSemver,
  semverRangeSchema,
  semverSchema,
  semverSatisfies,
  SemverError,
  type Semver,
  type SemverRange,
} from './schemas/semver.js';

export {
  actionTypeSchema,
  capabilityRefSchema,
  completionConditionSchema,
  completionCriteriaSchema,
  definitionEntryStatusSchema,
  failureConditionSchema,
  failureCriteriaSchema,
  publicEntryStatusSchema,
  schemaRefSchema,
  sha256DigestSchema,
  skillRefSchema,
  stepTemplateSchema,
  toolRefSchema,
  validatorKindSchema,
  validatorRefSchema,
  validatorRequirementSchema,
  workflowDefinitionSchema,
  workflowDefinitionSourceSchema,
  workflowLimitsSchema,
  type ActionTypeMember,
  type CapabilityRef,
  type CompletionCondition,
  type CompletionCriteria,
  type DefinitionEntryStatus,
  type FailureCondition,
  type FailureCriteria,
  type PublicEntryStatus,
  type SchemaRef,
  type Sha256Digest,
  type SkillRef,
  type StepTemplate,
  type ToolRef,
  type ValidatorKindMember,
  type ValidatorRef,
  type ValidatorRequirement,
  type WorkflowDefinitionShape,
  type WorkflowDefinitionSource,
  type WorkflowLimits,
  type WorkflowType,
} from './schemas/workflow-definition.js';

export {
  computeSkillAssetDigest,
  contextVariableSchema,
  skillAssetContentPayload,
  skillAssetSchema,
  skillMediaTypeSchema,
  skillSourceAssetSchema,
  skillSourceSchema,
  skillTrustTierSchema,
  type SkillAssetShape,
  type SkillContentShape,
  type SkillMediaType,
  type SkillSource,
  type SkillSourceAsset,
  type SkillTrustTier,
} from './schemas/skill-asset.js';

export {
  workflowDefinitionSnapshotSchema,
  type WorkflowDefinitionSnapshotShape,
} from './schemas/snapshot.js';

export {
  workflowCatalogEntrySchema,
  workflowLaunchEnvelopeSchema,
  type CatalogContext,
  type LaunchValidationResult,
  type WorkflowCatalogEntryShape,
  type WorkflowLaunchEnvelope,
} from './schemas/catalog.js';

export {
  definitionDigest,
  renderVersion,
  validateDefinition,
  versionOf,
  type DuplicateDetection,
  type SealedDefinition,
  type ValidationIssue,
  type ValidationIssueCode,
} from './definitions/definition-validator.js';

export {
  capabilityDescription,
  createSchemaCatalog,
  createToolCatalog,
  isKnownActionType,
  isKnownCapability,
  isKnownValidatorKind,
  KNOWN_ACTION_TYPES,
  KNOWN_CAPABILITIES,
  KNOWN_CAPABILITY_IDS,
  KNOWN_VALIDATOR_KINDS,
  type CapabilityInfo,
  type SchemaCatalogPort,
  type SchemaEntry,
  type ToolBindingInfo,
  type ToolCatalogPort,
} from './definitions/catalogs.js';

export {
  assertCapabilitiesSupported,
  evaluateCapabilityRequirements,
  type CapabilityEvaluation,
  type CapabilityManifest,
  type VerifiedCapability,
} from './capabilities/capability-evaluator.js';

export * from './skills/skill-bundle-compiler.js';
export {
  assertSkillAssetSafe,
  detectMutablePolicy,
  isSkillAssetSafe,
  type PolicyIssue,
  type PolicyIssueKind,
} from './skills/mutable-policy-detector.js';

export { type ProviderCapabilityPort } from './ports/provider-capability-port.js';
export {
  type NormalizedSkillContextPayload,
  type SkillContextPort,
} from './ports/skill-context-port.js';
export {
  type SnapshotPersistencePort,
  type StoredSnapshot,
} from './ports/snapshot-persistence-port.js';
export { type PolicySnapshotPort } from './ports/policy-snapshot-port.js';

export {
  emitWorkflowEvent,
  REGISTRY_FAILED_DIGEST,
  type EventSinkPort,
  type WorkflowEventType,
} from './events.js';

export {
  WorkflowRegistry,
  type RegisterOutcome,
  type RegistryBuildContext,
} from './registry/registry.js';
