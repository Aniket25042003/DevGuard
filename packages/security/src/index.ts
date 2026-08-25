/**
 * @devguard/security — cross-cutting security library (C092/C093).
 *
 * Boundary rules:
 * - Trust: every context byte carries provenance; lower authority can never
 *   mutate higher authority; model proposals are stripped and reconstructed
 *   from trusted state before authorization.
 * - Secrets: reference-based resolution with purpose/scope enforcement;
 *   leases are non-serializable; redaction runs at every output boundary;
 *   publication requires a fresh, digest-bound clean leak scan.
 */
// ---- C092 trust ----
export {
  MAX_CONTENT_BYTES,
  ProvenanceError,
  provenanceEnvelopeSchema,
  registerSource,
  sha256Hex,
  SOURCE_KINDS,
  TRUST_CLASSES,
  TRUST_RANK,
  canCarryControlFields,
} from './trust/provenance.js';
export type {
  ProvenanceEnvelopeShape,
  RegisterSourceInput,
  SourceKind,
  TrustClass,
} from './trust/provenance.js';

export { authorityOf, resolveInstructionConflicts } from './trust/precedence.js';
export type {
  InstructionItem,
  InstructionResolution,
  RejectedInstruction,
} from './trust/precedence.js';

export { detectInjectionSignals } from './trust/scanner.js';
export type { InjectionSignal } from './trust/scanner.js';

export {
  closeBoundary,
  encodeUntrustedSection,
  openBoundary,
  sanitizeQuotedContent,
} from './trust/boundary.js';

export { AgentTrustService, authoritySnapshotDigest } from './trust/service.js';
export type {
  AssembledSection,
  AuthorityContext as TrustAuthorityContext,
  EventSink as TrustEventSink,
  TrustedContextBundleShape,
  TrustDecision,
  TrustEvaluationShape,
  ValidatedActionProposal,
} from './trust/service.js';

// ---- C093 secrets ----
export {
  RESOLVABLE_STATUSES,
  ResolvedSecretLease,
  SECRET_STATUSES,
  secretRefSchema,
} from './secrets/refs.js';
export type {
  AuthorizationContext as SecretAuthorizationContext,
  ScopeType,
  SecretRefShape,
  SecretStatus,
} from './secrets/refs.js';

export { SecretService } from './secrets/resolver.js';
export type { SecretBackend, SecretServiceOptions } from './secrets/resolver.js';

export { aadDigest, EnvelopeEncryptor, staticKeyProvider } from './secrets/envelope.js';
export type {
  AssociatedData,
  EncryptedSecretRecord,
  MasterKeyProvider,
} from './secrets/envelope.js';

// ---- C093 redaction + scanning ----
import { PublicationGuard } from './leak-scan/publication.js';
import { SensitiveDataGuard } from './redaction/guard.js';

export { PublicationGuard, SensitiveDataGuard };
export type { RedactionResult, SinkType } from './redaction/guard.js';
export type { LeakFinding, LeakScanResult, ScanStatus } from './leak-scan/publication.js';

/** Convenience factory wiring the guard into a publication guard. */
export function createPublicationGuard(hmacKeyHex?: string): PublicationGuard {
  return new PublicationGuard(new SensitiveDataGuard({ hmacKeyHex }));
}

// ---- C094 perimeter ----
export {
  FailClosedRateLimiter,
  OriginPolicy,
  RATE_POLICIES,
  fetchMetadataSite,
  hierarchicalRateKey,
  verifyCsrf,
} from './api/perimeter.js';
export type {
  CorsDecision,
  CsrfDecision,
  CsrfVerificationInput,
  DistributedRateLimiterPort,
  FetchMetadataSite,
  RateLimitDecision,
  RatePolicy,
  RatePolicyClass,
} from './api/perimeter.js';

export { WebhookAcceptanceService, WebhookSecurityService } from './api/webhooks.js';
export type {
  AcceptanceOutcome,
  VerifiedWebhookEnvelope,
  WebhookAcceptance,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookDeliveryStore,
  WebhookSecretProvider,
} from './api/webhooks.js';

// ---- C095 content safety ----
export {
  contentBudget,
  normalizeRelativePath,
  resolveWorkspacePath,
  DEFAULT_BUDGET,
} from './content/paths.js';
export type { ContentBudget, SafePathShape } from './content/paths.js';

export { ArchiveRejectedError, inspectTarArchive } from './content/archives.js';
export type { ArchiveEntry, ArchiveManifest } from './content/archives.js';

export { validatePatch } from './content/patches.js';
export type {
  PatchOperation,
  PatchOperationKind,
  PatchValidationContext,
  PatchValidationShape,
  PathDecision,
} from './content/patches.js';

export {
  ArtifactPromotionService,
  authorizeArtifactRead,
  collectOutput,
  sanitizeTerminal,
} from './content/artifacts.js';
export type {
  ArtifactCandidate,
  ArtifactRecordShape,
  ArtifactScanState,
  BoundedOutput,
  ContentScannerPort,
} from './content/artifacts.js';
