/**
 * @devguard/github-adapter — provider-isolating GitHub adapter (C017–C021).
 *
 * Boundary rules:
 * - Provider SDK/REST types never cross this boundary.
 * - Writes require an AuthorizedActionContext from the action gateway (C030).
 * - Tokens/keys never leave here except via SecretString (non-serializable).
 * - Read-only resource adapters (C019); writes arrive through C020/C021 later.
 */
export {
  CAPABILITY_PERMISSION_MAP,
  GITHUB_CAPABILITIES,
  SecretString,
  requiredPermissionsFor,
  scopeDigest,
  secretFrom,
  type GitHubCapability,
  type InstallationContext,
  type InstallationTokenLease,
} from './auth/contracts.js';
export {
  AppJwtSigner,
  InMemoryKeyProvider,
  type AppKeyMaterial,
  type AppJwtSignerOptions,
  type SecretKeyProvider,
  type SignedAppJwt,
} from './auth/app-jwt-signer.js';
export {
  InMemoryTokenLeaseCache,
  TokenLeaseManager,
  type InstallationTokenMintPort,
  type TokenLeaseCache,
} from './auth/token-lease-cache.js';

export type {
  AuthorizedActionContext,
  CallSafety,
  GitHubAdapterError,
  GitHubAdapterErrorKind,
  GitHubOperation,
  GitHubRateInfo,
  GitHubRequestContext,
  GitHubResponseMeta,
  GitHubResult,
  HttpMethod,
} from './core/contracts.js';

export {
  FetchTransport,
  GitHubBaseClient,
  type GitHubClientOptions,
  type GitHubTransport,
  type RawTransportResponse,
} from './core/client.js';

// ---- C019 read adapter ----
export {
  GITHUB_API_VERSION,
  OP_GET_FILE,
  OP_GET_ISSUE,
  OP_GET_REPOSITORY,
  OP_GET_TREE,
  OP_LIST_ISSUE_COMMENTS,
  OP_RESOLVE_REF,
  repoPath,
  sha40,
  type GitHubComment,
  type GitHubIssue,
  type GitHubRepository,
  type GitFile,
  type GitTreeEntry,
  type GitTreePage,
} from './read/operations.js';
export { GitHubReadAdapter, type ReadContext, type ReadResult } from './read/read-adapter.js';

// ---- C013 repository lifecycle ----
export {
  REPOSITORY_LIFECYCLE_STATUSES,
  RepositoryLifecycleService,
  type ConnectionResult,
  type ConnectedRepositoryRecord,
  type ConnectRepository,
  type DefaultPolicySeeder,
  type InstallationContextPort,
  type RepositoryLifecyclePersistencePort,
  type RepositoryLifecycleStatus,
} from './read/lifecycle.js';

// ---- C014 repository metadata/health ----
export {
  DIMENSION_STATUSES,
  FIELD_OBSERVATION_STATUSES,
  getSnapshotInputSchema,
  HEALTH_DIMENSIONS,
  HEALTH_REASON_CODES,
  HEALTH_SCHEMA_VERSION,
  HEALTH_STATUSES,
  HINT_CAUSES,
  HINT_RESOURCES,
  METADATA_FIELDS,
  METADATA_SCHEMA_VERSION,
  READINESS_STATUSES,
  refreshMetadataInputSchema,
  REFRESH_CAUSES,
  repositoryRefreshHintSchema,
  REQUIRED_READ_PERMISSIONS,
  type CiDescriptor,
  type DimensionStatus,
  type EffectivePermissions,
  type FieldFailure,
  type FieldObservationStatus,
  type GetSnapshotInput,
  type HealthDimension,
  type HealthDimensions,
  type HealthReasonCode,
  type HealthStatus,
  type HintCause,
  type HintResource,
  type LanguageCount,
  type MetadataDimensionId,
  type MetadataField,
  type MetadataHealthView,
  type ReadinessStatus,
  type RefreshCause,
  type RefreshRepositoryMetadata,
  type RefreshRepositoryMetadataInput,
  type RepositoryHealthSnapshot,
  type RepositoryMetadataSnapshot,
  type RepositoryRefreshHint,
  type RepositoryRefreshHintInput,
  type ResourceEtag,
} from './read/metadata-health/contracts.js';
export {
  RepositoryMetadataHealthService,
  type LifecycleReadPort,
  type MetadataHealthServiceOptions,
} from './read/metadata-health/service.js';
export {
  InMemoryMetadataProvider,
  type IdentityObservation,
  type ProviderErrorCode,
  type ProviderRateState,
  type ProviderReadContext,
  type ProviderReadResult,
  type RepositoryMetadataProviderPort,
} from './read/metadata-health/provider-port.js';
export type { CollectedFields } from './read/metadata-health/collectors.js';
export { HealthEvaluator } from './read/metadata-health/health-evaluator.js';
export {
  evaluateHealthTransition,
  evaluateReadiness,
  type HealthTransitionEvidence,
  type HealthTransitionVerdict,
} from './read/metadata-health/state-machine.js';
export {
  InMemoryMetadataSnapshotStore,
  type MetadataSnapshotStorePort,
  type SaveResult,
} from './read/ports/metadata-snapshot-store.js';
export {
  InMemoryEventSink,
  NoopLogPort,
  READ_COMPONENT_EVENTS,
  type ComponentLogPort,
  type EmittedReadEvent,
  type EventSinkPort,
  type ReadComponentEventType,
} from './read/ports/shared.js';

// ---- C015 repository understanding map ----
export {
  BUDGET_KINDS,
  MAP_FACT_KINDS,
  MAP_TERMINAL_STATUSES,
  MAP_TRUST_LABELS,
  REPOSITORY_MAP_SCHEMA_VERSION,
  REPOSITORY_MAP_STATUSES,
  buildRepositoryMapSchema,
  invalidateRepositoryMapSchema,
  mapBudgetSchema,
  queryRepositoryMapSchema,
  type BudgetKind,
  type BuildRepositoryMap,
  type BuildRepositoryMapInput,
  type CiWorkflowRecord,
  type CommandCandidate,
  type CommitRecord,
  type InvalidateRepositoryMapInput,
  type InstructionCandidateRecord,
  type LanguageProjection,
  type LinkedContextRecord,
  type ManifestRecord,
  type MapBudget,
  type MapFact,
  type MapFactKind,
  type MapProvenance,
  type MapQueryResult,
  type MapTruncation,
  type MapTrustLabel,
  type QueryRepositoryMapInput,
  type RepositoryMap,
  type RepositoryMapRef,
  type RepositoryMapStatus,
  type TargetedPath,
  type TreeSummary,
} from './read/repository-map/contracts.js';
export {
  RepositoryMapServiceGate,
  REPOSITORY_MAP_FRESHNESS_MS,
  type RepositoryMapService,
  type RepositoryMapServiceDeps,
} from './read/repository-map/repository-map-service.js';
export {
  MAX_INSTRUCTION_CANDIDATES,
  MAX_LANGUAGES,
  MAX_RECENT_COMMITS,
  MAX_TARGETED_PATHS,
  collectRepositoryMapEvidence,
  type CollectedEvidence,
  type CollectEvidenceInput,
} from './read/repository-map/collectors.js';
export { BudgetTracker, type BudgetState } from './read/repository-map/budget.js';
export {
  CommandCandidateDetector,
  CiDescriptorCollector,
  InstructionCandidateCollector,
  ManifestDetector,
} from './read/repository-map/detectors.js';
export {
  canonicalizeRepoPath,
  isBinaryPath,
  isVendorOrGeneratedPath,
} from './read/repository-map/path-safety.js';
export {
  RepositoryMapStateMachine,
  type MapTransition,
} from './read/repository-map/state-machine.js';
export { taskFingerprint, type FingerprintInput } from './read/repository-map/task-fingerprint.js';
export { TargetRanker, scorePath } from './read/repository-map/target-ranker.js';
export { TreeCollector, type TreeCollectionResult } from './read/repository-map/tree-summary.js';
export {
  InMemoryMapArtifactStore,
  type MapArtifactRef,
  type MapArtifactStorePort,
} from './read/ports/map-artifact-store.js';
export {
  InMemoryRepositoryMapStore,
  type MapSaveResult,
  type RepositoryMapStorePort,
} from './read/ports/repository-map-store.js';
export {
  InMemoryMapProvider,
  type MapProviderErrorCode,
  type MapProviderResult,
  type RepositoryContentProviderPort,
  type TreeEntryLike,
} from './read/repository-map/provider-port.js';

// ---- C016 instruction trust hierarchy ----
export {
  AUTHORITATIVE_TIERS,
  ADVISORY_TIERS,
  UNTRUSTED_TIERS,
  DIRECTIVE_CATEGORIES,
  INSTRUCTION_SCHEMA_VERSION,
  INSTRUCTION_SNAPSHOT_STATUSES,
  INSTRUCTION_TIERS,
  INSTRUCTION_TRUST_LABELS,
  REJECTION_REASON_CODES,
  assembleInstructionSnapshotSchema,
  directiveCategorySchema,
  instructionTierSchema,
  resolveInstructionsForPathSchema,
  tierPrecedes,
  validateInstructionCandidateSchema,
  type AssembleInstructionSnapshotInput,
  type DirectiveCategory,
  type InstructionConflict,
  type InstructionSegment,
  type InstructionSnapshot,
  type InstructionSnapshotStatus,
  type InstructionSource,
  type InstructionTier,
  type InstructionTrustLabel,
  type InstructionValidation,
  type RejectedDirective,
  type RejectionReasonCode,
  type ResolvedInstructionSet,
  type ResolveInstructionsForPathInput,
  type ValidateInstructionCandidateInput,
} from './read/instruction-trust/contracts.js';
export {
  classifyDirective,
  reasonCodeForCategory,
  type DirectiveClassification,
} from './read/instruction-trust/directive-classifier.js';
export { globMatch, pathMatchesScope } from './read/instruction-trust/applicability-resolver.js';
export {
  InstructionTrustServiceGate,
  MAX_LINE_BYTES,
  MAX_SEGMENTS,
  MAX_SNAPSHOT_BYTES,
  type InstructionContentPort,
  type InstructionTrustService,
  type InstructionTrustServiceDeps,
  type RawInstructionSource,
} from './read/instruction-trust/instruction-trust-service.js';
export {
  InMemoryInstructionSnapshotStore,
  type InstructionSnapshotStorePort,
  type SnapshotSaveResult,
} from './read/instruction-trust/instruction-snapshot-store.js';

// ---- C021 GitHub Pull Requests / Reviews / Checks ----
export {
  PR_SCHEMA_VERSION,
  PR_STATES,
  REVIEW_EVIDENCE_KINDS,
  createPullRequestSchema,
  evidenceConclusionSchema,
  gitRepoRefSchema,
  mergePullRequestSchema,
  postCommentSchema,
  pullRequestFingerprintSchema,
  pullRequestSchema,
  requestReviewSchema,
  reviewEvidenceSchema,
  updatePullRequestSchema,
  type CreatePullRequest,
  type MergePullRequest,
  type PostPullRequestComment,
  type PrRef,
  type PullRequest,
  type PullRequestFingerprint,
  type RequestReview,
  type ReviewEvidence,
  type ReviewEvidenceKind,
  type UpdatePullRequest,
} from './write/pr/contracts.js';
export { resolvePrMergeEdge, resolvePrMutationEdge, type PrMergeStatus } from './write/pr/fsm.js';
export {
  GitHubPullRequestsReviewsChecksAdapter,
  type GitHubPullRequestsReviewsChecks,
  type GitHubPullRequestsReviewsChecksDeps,
  type MergeResult,
  type PrEvent,
  type PrEventSinkPort,
  type PrMutationResult,
  type PrReadContext,
  type PrWriteContext,
  type ReconciliationResult,
} from './write/pr/github-pull-requests.js';
export {
  InMemoryPrOperationStore,
  type PrClaimResult,
  type PrOperation,
  type PrOperationStorePort,
} from './write/pr/operation-store.js';
export {
  InMemoryPrProvider,
  type PrProviderErrorCode,
  type PrProviderResult,
  type PrProviderPort,
} from './write/pr/provider-port.js';
export {
  canonicalize,
  sha256Hex,
  mutationInputDigest,
  sanitizePrContent,
  prSafe,
} from './write/pr/pr-safe.js';
