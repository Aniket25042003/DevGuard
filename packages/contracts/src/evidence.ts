/**
 * C004 — Evidence contracts: artifacts, validation results, security findings.
 *
 * Metadata only — artifact bytes live in object storage. Validation results
 * bind to an exact commit/workspace state; skipped/blocked never count as
 * passed. Findings preserve provenance and never invent severity.
 */
import { z } from 'zod';
import { provenance, DataClassification } from './context.js';
import type { ProvenanceShape } from './context.js';
import { boundedText, schemas, timestampIso } from './primitives.js';

export interface ArtifactShape {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly classification: DataClassification;
  /** Opaque storage reference; object-store keys never leave the store adapter. */
  readonly storageRef: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly createdAt: string;
  readonly retentionExpiresAt?: string | undefined;
}

export const artifact: z.ZodType<ArtifactShape> = z
  .object({
    id: schemas.artifactId,
    runId: schemas.workflowRunId.optional(),
    classification: DataClassification,
    storageRef: z.string().min(1).max(512),
    contentType: z.string().max(128),
    sizeBytes: z.number().int().nonnegative(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: timestampIso,
    retentionExpiresAt: timestampIso.optional(),
  })
  .strip();

export const ValidationStatus = z.enum(['passed', 'failed', 'skipped', 'blocked']);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

/** Canonical validator identifiers (A-12). */
export const ValidatorKind = z.enum([
  'unit_tests',
  'integration_tests',
  'typecheck',
  'lint',
  'build',
  'security_scan',
  'dependency_check',
]);
export type ValidatorKind = z.infer<typeof ValidatorKind>;

export interface ValidationResultShape {
  readonly id: string;
  readonly validator: ValidatorKind;
  /** Exact commit the evidence binds to; stale SHA ⇒ not valid for gating. */
  readonly commitSha: string;
  readonly workspaceRef?: string | undefined;
  readonly status: ValidationStatus;
  readonly exitCode?: number | undefined;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly artifactIds: readonly string[];
}

const shaPattern = /^[0-9a-f]{40}$/;

export const validationResult: z.ZodType<ValidationResultShape> = z
  .object({
    id: schemas.validationResultId,
    validator: ValidatorKind,
    commitSha: z.string().regex(shaPattern),
    workspaceRef: z.string().max(256).optional(),
    status: ValidationStatus,
    exitCode: z.number().int().min(-128).max(255).optional(),
    startedAt: timestampIso,
    endedAt: timestampIso,
    artifactIds: z.array(schemas.artifactId).max(256),
  })
  .strip();

export const FindingSeverity = z.enum(['unknown', 'low', 'medium', 'high', 'critical']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const FindingStatus = z.enum(['open', 'confirmed', 'fixed', 'dismissed', 'suppressed']);
export type FindingStatus = z.infer<typeof FindingStatus>;

/** Provider-neutral security finding with preserved provenance (WF-05). */
export interface SecurityFindingShape {
  readonly id: string;
  readonly runId?: string | undefined;
  readonly fingerprint: string;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly source: {
    readonly scanner: string;
    readonly ruleId?: string | undefined;
    readonly provenance: ProvenanceShape;
  };
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export const securityFinding: z.ZodType<SecurityFindingShape> = z
  .object({
    id: schemas.securityFindingId,
    runId: schemas.workflowRunId.optional(),
    fingerprint: z.string().min(8).max(128),
    title: boundedText(300),
    severity: FindingSeverity,
    status: FindingStatus,
    source: z
      .object({
        scanner: z.string().min(1).max(128),
        ruleId: z.string().max(128).optional(),
        provenance: provenance,
      })
      .strict(),
    firstSeenAt: timestampIso,
    lastSeenAt: timestampIso,
  })
  .strip();

export type { ProvenanceShape, DataClassification };
