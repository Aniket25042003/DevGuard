/**
 * C044 §8/§9/§10 — sandbox artifact / cleanup / telemetry contracts.
 *
 * Artifacts are explicit allowlisted outputs (never an unbounded workspace
 * archive), SHA-256 checksummed, provenance-bound, and only `SAFE` artifacts are
 * downloadable/validator-consumable. Cleanup requires provider-absence proof
 * and stays visibly retryable on uncertainty. Telemetry is metadata-only.
 */
import { z } from 'zod';
import { idSchemas } from '@devguard/contracts';

export const SANDBOX_ARTIFACT_SCHEMA_VERSION = 1 as const;

export const ARTIFACT_STATES = [
  'DECLARED',
  'COLLECTING',
  'HASHING',
  'UPLOADING',
  'VERIFYING',
  'SCANNING',
  'SAFE',
  'QUARANTINED',
  'REJECTED',
  'EXPIRING',
  'DELETED',
  'FAILED',
  'RESCAN_REQUIRED',
] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const CLEANUP_STATES = [
  'REQUESTED',
  'INSPECTING',
  'DESTROYING',
  'VERIFYING_ABSENT',
  'COMPLETED',
  'RETRY_WAIT',
  'QUARANTINED',
  'ESCALATED',
] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export type CleanupReason =
  'success' | 'failure' | 'timeout' | 'cancelled' | 'provisioning_failed' | 'lease_expired';

export const artifactSchema = z
  .object({
    id: z.string().min(1).max(128),
    manifestId: z.string().min(1).max(128),
    workspaceId: idSchemas.workflowRunId,
    commandId: z.string().min(1).max(128),
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !p.startsWith('/') && !p.includes('..')),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(256 * 1024 * 1024),
    sha256Checksum: z.string().regex(/^[0-9a-f]{64}$/),
    mimeType: z.string().max(64),
    scanState: z.enum(['UNSCANNED', 'SAFE', 'QUARANTINED', 'REJECTED', 'RESCAN_REQUIRED']),
    retentionClass: z.enum(['ephemeral', 'workflow', 'forensic']),
    state: z.enum(ARTIFACT_STATES),
    storageRef: z.string().max(200).optional(),
    createdAtIso: z.string().min(1).max(40),
  })
  .strict();
export interface SandboxArtifact {
  readonly id: string;
  readonly manifestId: string;
  readonly workspaceId: string;
  readonly commandId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256Checksum: string;
  readonly mimeType: string;
  readonly scanState: 'UNSCANNED' | 'SAFE' | 'QUARANTINED' | 'REJECTED' | 'RESCAN_REQUIRED';
  readonly retentionClass: 'ephemeral' | 'workflow' | 'forensic';
  readonly state: ArtifactState;
  readonly storageRef?: string | undefined;
  readonly createdAtIso: string;
}

export interface ArtifactManifest {
  readonly id: string;
  readonly workspaceId: string;
  readonly commandId: string;
  readonly checksum: string;
  readonly artifactIds: readonly string[];
  readonly createdAtIso: string;
}

export const artifactContractsSchema = { artifactSchema };
