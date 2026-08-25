/**
 * C002 — Configuration loading: parse → normalize → freeze.
 *
 * Contract:
 * - Domain and application code never reads process.env; composition roots
 *   call `loadConfig` once and pass explicit typed settings onward.
 * - Loading is deterministic: identical sources produce an identical snapshot
 *   hash regardless of wall-clock time.
 * - Snapshots are deeply frozen; secret values are never included (refs only).
 */
import { createHash } from 'node:crypto';
import { configurationInvalid } from '@devguard/errors';
import { evaluateFeatures } from './features.js';
import type { FeatureDecisionSet, FeatureKey, FlagDecision } from './features.js';
import {
  ConfigParser,
  parseAuth,
  parseEnvironment,
  parseServerSections,
  parseWebApiBaseUrl,
  scanForUnknownVariables,
} from './schema.js';
import type {
  AuthConfig,
  EnvRecord,
  Environment,
  ProcessKind,
  RetentionConfig,
  LimitsConfig,
  ObservabilityConfig,
  GithubAppConfig,
  TrueForgeConfig,
  ArtifactStorageConfig,
} from './schema.js';
import type { SecretRef } from './secrets.js';

export interface ConfigurationValidatedEvent {
  readonly type: 'configuration.validated';
  readonly occurredAt: string;
  readonly hash: string;
  readonly environment: Environment;
}

export interface FeatureFlagChangedEvent {
  readonly type: 'feature_flag.changed';
  readonly occurredAt: string;
  readonly key: FeatureKey;
  readonly value: boolean;
}

export type ConfigEvent = ConfigurationValidatedEvent | FeatureFlagChangedEvent;

export type ConfigEventSink = (event: ConfigEvent) => void;

export interface LoadOptions {
  /** Defaults to process.env. Injectable for tests and alternative runtimes. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Startup event sink; the durable outbox integration arrives with C008. */
  readonly onEvent?: ConfigEventSink;
  /** ISO timestamp provider override (tests). */
  readonly now?: () => Date;
}

interface CoreSnapshotFields {
  readonly processKind: ProcessKind;
  readonly environment: Environment;
  readonly loadedAt: string;
  readonly hash: string;
  readonly warnings: readonly string[];
  readonly features: FeatureDecisionSet;
}

export interface ApiConfigSnapshot extends CoreSnapshotFields {
  readonly processKind: 'api';
  readonly auth: AuthConfig;
  readonly databaseUrlRef: SecretRef;
  readonly redisUrlRef: SecretRef;
  readonly retention: RetentionConfig;
  readonly limits: LimitsConfig;
  readonly observability: ObservabilityConfig;
  readonly github?: GithubAppConfig;
  readonly trueforge?: TrueForgeConfig;
  readonly artifacts: ArtifactStorageConfig;
}

export interface WorkerConfigSnapshot extends CoreSnapshotFields {
  readonly processKind: 'worker';
  readonly databaseUrlRef: SecretRef;
  readonly redisUrlRef: SecretRef;
  readonly retention: RetentionConfig;
  readonly limits: LimitsConfig;
  readonly observability: ObservabilityConfig;
  readonly github?: GithubAppConfig;
  readonly trueforge?: TrueForgeConfig;
  readonly artifacts: ArtifactStorageConfig;
}

export interface WebConfigSnapshot extends CoreSnapshotFields {
  readonly processKind: 'web';
  readonly publicApiBaseUrl: string;
}

export type ConfigSnapshot = ApiConfigSnapshot | WorkerConfigSnapshot | WebConfigSnapshot;

/** Map a process kind to its concrete snapshot type. */
export interface SnapshotForMap {
  readonly api: ApiConfigSnapshot;
  readonly worker: WorkerConfigSnapshot;
  readonly web: WebConfigSnapshot;
}
export type SnapshotFor<K extends ProcessKind> = SnapshotForMap[K];

/** Presence/health metadata only — safe for diagnostics and logs (C074). */
export interface SafeConfigSummary {
  readonly processKind: ProcessKind;
  readonly environment: Environment;
  readonly configHash: string;
  readonly hasDatabaseCredentials: boolean;
  readonly hasRedisCredentials: boolean;
  readonly hasGithubAppCredentials: boolean;
  readonly hasTrueForgeCredentials: boolean;
  readonly features: Readonly<Record<FeatureKey, boolean>>;
  readonly warningCount: number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalize(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function stableHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

/**
 * Load and validate configuration for a process kind.
 * Throws the typed CONFIGURATION_INVALID DevGuardError when validation fails;
 * issue details carry paths and constraints only — never raw values.
 */
export function loadConfig<K extends ProcessKind>(
  processKind: K,
  options: LoadOptions = {},
): Readonly<SnapshotFor<K>> {
  const env: EnvRecord = options.env ?? globalThis.process?.env ?? {};
  const now = options.now ?? (() => new Date());
  const sink: ConfigEventSink = options.onEvent ?? (() => undefined);

  const parser = new ConfigParser();

  // Unknown variables: reject in CI, warn otherwise (C002 §5).
  const scan = scanForUnknownVariables(env);
  const warnings: string[] = [];
  if (scan.unknown.length > 0) {
    const inCi = env['CI'] === 'true' || env['CI'] === '1';
    if (inCi) {
      for (const name of scan.unknown) {
        parser.addIssue(name, 'unknown variable name');
      }
    } else {
      warnings.push(`unknown variable names ignored: ${scan.unknown.join(', ')}`);
    }
  }

  // Feature flags first: enabling a capability can make sections required.
  const featureEvaluation = evaluateFeatures(env);
  parser.addIssues(featureEvaluation.issues);
  warnings.push(...featureEvaluation.warnings);

  const environment = parseEnvironment(parser, env);
  const features = featureEvaluation.decisions;
  const loadedAt = now().toISOString();

  let snapshot: ConfigSnapshot;
  switch (processKind) {
    case 'web': {
      const publicApiBaseUrl = parseWebApiBaseUrl(parser, env);
      if (publicApiBaseUrl === undefined) {
        parser.addIssue('PUBLIC_API_BASE_URL', 'required for web process');
        snapshot = finalizeWeb(environment, features, warnings, loadedAt, '<invalid>');
      } else {
        snapshot = finalizeWeb(environment, features, warnings, loadedAt, publicApiBaseUrl);
      }
      break;
    }
    case 'api':
    case 'worker': {
      const server = parseServerSections(parser, env);
      if (
        features['trueforgeIntegrationEnabled'].value &&
        server.trueforge === undefined &&
        !parser.hasIssueFor('DEVGUARD_TRUEFORGE_BASE_URL') &&
        !parser.hasIssueFor('TRUEFORGE_API_KEY')
      ) {
        parser.addIssue(
          'DEVGUARD_TRUEFORGE_BASE_URL',
          'required when FLAG_TRUEFORGE_INTEGRATION_ENABLED=true',
        );
      }
      if (features['devNoAuthMode'].value && environment === 'production') {
        parser.addIssue('FLAG_DEV_NO_AUTH_MODE', 'cannot be enabled in production');
      }

      const shared = {
        environment,
        features,
        warnings,
        databaseUrlRef: { name: server.databaseUrlRef } satisfies SecretRef,
        redisUrlRef: { name: server.redisUrlRef } satisfies SecretRef,
        retention: server.retention,
        limits: server.limits,
        observability: server.observability,
        ...(server.github !== undefined ? { github: server.github } : {}),
        ...(server.trueforge !== undefined ? { trueforge: server.trueforge } : {}),
        artifacts: server.artifacts,
      };
      snapshot =
        processKind === 'api'
          ? {
              processKind: 'api',
              ...shared,
              auth: parseAuth(parser, env, environment),
              loadedAt,
              hash: '',
            }
          : { processKind: 'worker', ...shared, loadedAt, hash: '' };
      break;
    }
  }

  if (parser.hasIssues) {
    throw configurationInvalid(parser.issuesList);
  }

  // Deterministic identity excludes wall-clock fields.
  const hashable = { ...snapshot, loadedAt: undefined, hash: undefined };

  sink({
    type: 'configuration.validated',
    occurredAt: loadedAt,
    hash: stableHash(hashable),
    environment,
  });
  for (const key of Object.keys(features) as FeatureKey[]) {
    const decision: FlagDecision = features[key];
    if (decision.source === 'environment') {
      sink({
        type: 'feature_flag.changed',
        occurredAt: loadedAt,
        key,
        value: decision.value,
      });
    }
  }

  return deepFreeze({ ...snapshot, hash: stableHash(hashable) }) as SnapshotFor<K>;
}

function finalizeWeb(
  environment: Environment,
  features: FeatureDecisionSet,
  warnings: string[],
  loadedAt: string,
  publicApiBaseUrl: string,
): WebConfigSnapshot {
  return {
    processKind: 'web',
    environment,
    features,
    warnings,
    loadedAt,
    hash: '',
    publicApiBaseUrl,
  };
}

/** Presence/health summary derived from a validated snapshot. */
export function safeSummary(snapshot: ConfigSnapshot): SafeConfigSummary {
  const features = {} as Record<FeatureKey, boolean>;
  for (const [key, decision] of Object.entries(snapshot.features)) {
    features[key as FeatureKey] = (decision as FlagDecision).value;
  }
  const common = {
    processKind: snapshot.processKind,
    environment: snapshot.environment,
    configHash: snapshot.hash,
    features,
    warningCount: snapshot.warnings.length,
  };
  if (snapshot.processKind === 'web') {
    return {
      ...common,
      hasDatabaseCredentials: false,
      hasRedisCredentials: false,
      hasGithubAppCredentials: false,
      hasTrueForgeCredentials: false,
    };
  }
  return {
    ...common,
    hasDatabaseCredentials: !snapshot.databaseUrlRef.name.startsWith('<'),
    hasRedisCredentials: !snapshot.redisUrlRef.name.startsWith('<'),
    hasGithubAppCredentials: snapshot.github !== undefined,
    hasTrueForgeCredentials: snapshot.trueforge !== undefined,
  };
}
