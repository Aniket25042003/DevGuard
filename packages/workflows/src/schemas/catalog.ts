/**
 * C045 §11/§14 — safe catalog projections and the launch envelope.
 *
 * Catalog entries expose launcher metadata ONLY: id/version/name/description,
 * input schema reference, availability, block reasons and limits. They never
 * carry authorization decisions, validator promises, prompt bodies or
 * mutable skill policy (C045 §11). Availability is computed against a
 * caller-supplied capability context and FAILS CLOSED: an absent manifest
 * blocks every definition that declares capabilities.
 */
import { z } from 'zod';
import { WorkflowKind } from '@devguard/contracts';
import type { Semver } from './semver.js';
import { semverSchema } from './semver.js';
import { publicEntryStatusSchema, workflowLimitsSchema } from './workflow-definition.js';
import type { PublicEntryStatus } from './workflow-definition.js';
import type { WorkflowLimits } from './workflow-definition.js';

export interface CatalogContext {
  /** Capability ids verified by the provider manifest (C036). Absent ⇒ unknown. */
  readonly availableCapabilities?: readonly string[] | undefined;
}

export const workflowCatalogEntrySchema: z.ZodType<WorkflowCatalogEntryShape> = z
  .object({
    id: WorkflowKind,
    version: semverSchema,
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    inputSchema: z.object({ id: z.string().min(1).max(64), version: semverSchema }).strict(),
    status: publicEntryStatusSchema,
    available: z.boolean(),
    blockReasons: z.array(z.string().min(1).max(160)).max(16),
    limits: workflowLimitsSchema.optional(),
    requiredCapabilities: z.array(z.string().min(1).max(128)).max(32),
  })
  .strict();

export interface WorkflowCatalogEntryShape {
  readonly id: WorkflowKind;
  readonly version: Semver;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly id: string; readonly version: Semver };
  readonly status: PublicEntryStatus;
  readonly available: boolean;
  readonly blockReasons: readonly string[];
  readonly limits?: WorkflowLimits | undefined;
  readonly requiredCapabilities: readonly string[];
}

/**
 * Launch envelope (C045 §10): workflow id+version, the input schema version
 * the payload was validated against, the raw input and an idempotency key.
 * Idempotency SEMANTICS (duplicate-key-with-different-content) are decided by
 * C046/C067; C045 validates shape + version + input against the pinned schema.
 */
export const workflowLaunchEnvelopeSchema = z
  .object({
    workflow: z.object({ id: WorkflowKind, version: semverSchema }).strict(),
    inputSchemaVersion: semverSchema,
    input: z.unknown(),
    idempotencyKey: z.string().min(8).max(256),
  })
  .strict();
export type WorkflowLaunchEnvelope = z.infer<typeof workflowLaunchEnvelopeSchema>;

/** Result of envelope + input validation before any run is created. */
export type LaunchValidationResult =
  | {
      readonly ok: true;
      readonly definitionId: WorkflowKind;
      readonly version: Semver;
      readonly inputSchemaVersion: Semver;
      readonly input: unknown;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'WORKFLOW_UNKNOWN'
        | 'WORKFLOW_VERSION_RETIRED'
        | 'WORKFLOW_CAPABILITY_UNSUPPORTED'
        | 'WORKFLOW_INPUT_INVALID';
      readonly issues?: readonly { path: string; constraint: string }[] | undefined;
    };
