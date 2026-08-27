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
