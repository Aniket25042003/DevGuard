/**
 * C014 §8/§10 — Repository metadata and health contracts.
 *
 * Normalized, freshness-aware snapshot shapes plus deterministic health and
 * readiness. All states are closed unions; no loose booleans. Every snapshot
 * carries provenance (capturedAt, source request ids, per-resource ETags),
 * an explicit `validUntil`, and a monotonically increasing `generation` used
 * for CAS so an old refresh can never replace newer observations.
 */
import { idSchemas } from '@devguard/contracts';
import { z } from 'zod';
import type { RepositoryLifecycleStatus } from '../lifecycle.js';

export const METADATA_SCHEMA_VERSION = 1 as const;
export const HEALTH_SCHEMA_VERSION = 1 as const;

/** Per-resource metadata fields collected during a refresh (C014 §8/§12). */
export const METADATA_FIELDS = [
  'identity',
  'default_branch',
  'languages',
  'permissions',
  'activity',
  'checks',
] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

/** Per-field observation freshness. */
export const FIELD_OBSERVATION_STATUSES = ['fresh', 'stale', 'unavailable'] as const;
export type FieldObservationStatus = (typeof FIELD_OBSERVATION_STATUSES)[number];

/** Health states (C014 §9): evidence-driven, never inferred from prose. */
export const HEALTH_STATUSES = ['healthy', 'degraded', 'unavailable', 'unknown'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Readiness: blocks unsafe workflow start but is never action authorization. */
export const READINESS_STATUSES = ['ready', 'read_only', 'blocked'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** Health dimensions (C014 §8). */
export const HEALTH_DIMENSIONS = [
  'connection',
  'authentication',
  'permissions',
  'repository',
  'defaultBranch',
  'metadataFreshness',
  'checksIntegration',
] as const;
export type MetadataDimensionId = (typeof HEALTH_DIMENSIONS)[number];

export const DIMENSION_STATUSES = ['ok', 'degraded', 'failed', 'unknown'] as const;
export type DimensionStatus = (typeof DIMENSION_STATUSES)[number];

/** Refresh causes (C014 §10). */
export const REFRESH_CAUSES = ['connect', 'webhook', 'preflight', 'manual', 'read_repair'] as const;
export type RefreshCause = (typeof REFRESH_CAUSES)[number];

/** Webhook/hint resource groups that can invalidate cached freshness. */
export const HINT_RESOURCES = [
  'push',
  'default_branch',
  'checks',
  'permissions',
  'metadata',
] as const;
export type HintResource = (typeof HINT_RESOURCES)[number];

export const HINT_CAUSES = REFRESH_CAUSES;
export type HintCause = RefreshCause;

/** Required installation read permissions mirroring C013 onboarding. */
export const REQUIRED_READ_PERMISSIONS = [
  'contents: read',
  'issues: read',
  'metadata: read',
] as const;

/**
 * Stable, machine-readable reason codes used across dimensions and
 * field-failure records. They are data (safe to expose in views), not error
 * codes; they never carry free-form provider prose.
 */
export const HEALTH_REASON_CODES = [
  'LIFECYCLE_CONNECTED',
  'LIFECYCLE_DEGRADED',
  'LIFECYCLE_DISCONNECTED',
  'LIFECYCLE_UNKNOWN',
  'PROVIDER_REACHABLE',
  'PROVIDER_UNREACHABLE',
  'AUTHENTICATION_FAILED',
  'MISSING_PERMISSIONS',
  'PERMISSIONS_OK',
  'REPOSITORY_OBSERVED',
  'REPOSITORY_STALE',
  'DEFAULT_BRANCH_RESOLVED',
  'DEFAULT_BRANCH_MISSING',
  'METADATA_FRESH',
  'METADATA_STALE',
  'METADATA_HARD_STALE',
  'METADATA_NEVER_CAPTURED',
  'CHECKS_INTEGRATION_OK',
  'CHECKS_UNAVAILABLE',
  'CHECKS_UNVERIFIED',
  'NO_EVIDENCE_YET',
] as const;
export type HealthReasonCode = (typeof HEALTH_REASON_CODES)[number];

/** Language usage with byte counts (normalized from provider `languages`). */
export interface LanguageCount {
  readonly name: string;
  readonly bytes: number;
}

/** Effective permissions projection (C014 §8; provider verification deferred). */
export interface EffectivePermissions {
  readonly kind: 'read' | 'write' | 'admin';
  readonly canPush: boolean;
}

/** A detected CI/check descriptor; presence never implies passing. */
export interface CiDescriptor {
  readonly name: string;
  readonly kind: 'check_run' | 'workflow_run' | 'status' | 'unknown';
  readonly externalKey: string;
}

/** Per-resource conditional-request state (ETag / Last-Modified). */
export interface ResourceEtag {
  readonly resource: MetadataField;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
}

/** Normalized per-field failure; provider prose is never embedded. */
export interface FieldFailure {
  readonly field: MetadataField;
  readonly reasonCode: string;
  readonly detail: string;
}

export interface RepositoryMetadataSnapshot {
  readonly repositoryDevguardId: string;
  readonly githubRepositoryId: number;
  readonly ownerLogin: string;
  readonly repoName: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private';
  readonly archived: boolean;
  readonly disabled: boolean;
  readonly fork: boolean;
  readonly languages: readonly LanguageCount[];
  readonly effectivePermissions: EffectivePermissions;
  readonly pushedAtIso?: string | undefined;
  readonly providerUpdatedAtIso?: string | undefined;
  readonly latestObservedSha?: string | undefined;
  readonly ciDescriptors: readonly CiDescriptor[];
  readonly resourceEtags: readonly ResourceEtag[];
  readonly capturedAtIso: string;
  readonly validUntilIso: string;
  readonly sourceRequestIds: readonly string[];
  readonly fieldFailures: readonly FieldFailure[];
  readonly schemaVersion: 1;
  /** CAS generation: strictly increasing; old refreshes may never replace new. */
  readonly generation: number;
}

/** One dimension of the health snapshot (C014 §8). */
export interface HealthDimension {
  readonly status: DimensionStatus;
  readonly reasonCode: HealthReasonCode;
  readonly observedAtIso: string;
  readonly evidenceRef?: string | undefined;
  readonly remediation?: string | undefined;
}

/** Fixed seven-dimension record: no loose indexing, every key always present. */
export interface HealthDimensions {
  readonly connection: HealthDimension;
  readonly authentication: HealthDimension;
  readonly permissions: HealthDimension;
  readonly repository: HealthDimension;
  readonly defaultBranch: HealthDimension;
  readonly metadataFreshness: HealthDimension;
  readonly checksIntegration: HealthDimension;
}

export interface RepositoryHealthSnapshot {
  readonly repositoryDevguardId: string;
  readonly status: HealthStatus;
  readonly readiness: ReadinessStatus;
  readonly dimensions: HealthDimensions;
  readonly lifecycleStatus: RepositoryLifecycleStatus | 'unknown';
  readonly reasonCode: HealthReasonCode;
  readonly computedVersion: number;
  readonly capturedAtIso: string;
  readonly supersededAtIso?: string | undefined;
  readonly schemaVersion: 1;
}

/** Public view (C014 §10): age, partial-field errors, readiness, lifecycle. */
export interface MetadataHealthView {
  readonly repositoryDevguardId: string;
  readonly snapshot?: RepositoryMetadataSnapshot | undefined;
  readonly health?: RepositoryHealthSnapshot | undefined;
  /** Milliseconds since capture, or undefined when no snapshot exists yet. */
  readonly snapshotAgeMs?: number | undefined;
  readonly partialFieldErrors: readonly FieldFailure[];
  readonly status: HealthStatus;
  readonly readiness: ReadinessStatus;
  readonly lifecycleStatus: RepositoryLifecycleStatus | 'unknown';
  readonly refreshPending: boolean;
  readonly retryAfterMs?: number | undefined;
}

export interface RefreshRepositoryMetadata {
  readonly repositoryId: string;
  readonly cause: RefreshCause;
  readonly minimumFields?: MetadataField[] | undefined;
  readonly operationKey: string;
}

export interface RepositoryRefreshHint {
  readonly repositoryId: string;
  readonly cause: HintCause;
  readonly resources: readonly HintResource[];
  readonly eventId?: string | undefined;
}

// ---- boundary schemas (zod v4, strict; branded ids from @devguard/contracts) --

export const refreshMetadataInputSchema = z
  .object({
    repositoryId: idSchemas.repositoryId,
    cause: z.enum(REFRESH_CAUSES),
    minimumFields: z.array(z.enum(METADATA_FIELDS)).max(6).optional(),
    operationKey: idSchemas.operationKey,
  })
  .strict();

export const repositoryRefreshHintSchema = z
  .object({
    repositoryId: idSchemas.repositoryId,
    cause: z.enum(HINT_CAUSES),
    resources: z.array(z.enum(HINT_RESOURCES)).min(1).max(8),
    eventId: z.string().max(128).optional(),
  })
  .strict();

export type RefreshRepositoryMetadataInput = z.output<typeof refreshMetadataInputSchema>;
export type RepositoryRefreshHintInput = z.output<typeof repositoryRefreshHintSchema>;

/** Parsed, validated refresh request (internal carrier). */
export type ParsedRefreshRequest = RefreshRepositoryMetadataInput;

export const getSnapshotInputSchema = z
  .object({
    repositoryId: idSchemas.repositoryId,
    maxAgeMs: z.number().int().min(0),
  })
  .strict();

export type GetSnapshotInput = z.output<typeof getSnapshotInputSchema>;
