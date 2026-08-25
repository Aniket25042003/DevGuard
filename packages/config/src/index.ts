/**
 * @devguard/config — typed startup configuration and conservative feature flags (C002).
 *
 * Boundary rule: only composition roots (apps) import this package; domain and
 * application services receive explicit typed settings, never process.env.
 */
export type {
  ApiConfigSnapshot,
  ConfigEvent,
  ConfigEventSink,
  ConfigSnapshot,
  LoadOptions,
  SafeConfigSummary,
  WebConfigSnapshot,
  WorkerConfigSnapshot,
} from './load.js';
export { loadConfig, safeSummary } from './load.js';

export type {
  ArtifactStorageConfig,
  AuthConfig,
  EnvRecord,
  Environment,
  FieldDefinition,
  GithubAppConfig,
  LimitsConfig,
  ObservabilityConfig,
  ProcessKind,
  RetentionConfig,
  Secrecy,
  TrueForgeConfig,
} from './schema.js';
export {
  ConfigurationIssuesError,
  FIELD_INVENTORY,
  PROCESS_KINDS,
  scanForUnknownVariables,
} from './schema.js';

export { createFeatureGate, evaluateFeatures, FEATURE_DEFAULTS, FEATURE_KEYS } from './features.js';
export type {
  FeatureDecisionSet,
  FeatureEvaluation,
  FeatureGate,
  FeatureKey,
  FeatureDefaults,
  FlagContext,
  FlagDecision,
  FlagSource,
} from './features.js';

export { EnvironmentSecretProvider, secretRef } from './secrets.js';
export type { SecretProvider, SecretRef } from './secrets.js';

export { toPublicConfig } from './public.js';
export type { PublicWebConfig } from './public.js';
