/**
 * C045 §8/§10 — durable workflow definition snapshot (workflow-definition-snapshot/v1).
 *
 * C046 persists this object with the run in one transaction. It reproduces
 * the EXACT definition, schemas, skills, tools, validators and capabilities a
 * run is bound to (C045 §25): definition digest, schema refs+digests,
 * skill digests, tool/validator/capability digests, registry generation and
 * creation time. Snapshots are immutable and retained for audit/replay — the
 * normalized JSON is byte-stable so a re-hash always matches.
 */
import { z } from 'zod';
import { WorkflowKind } from '@devguard/contracts';
import type { Semver } from './semver.js';
import { semverSchema } from './semver.js';
import type { SkillTrustTier } from './skill-asset.js';
import { skillTrustTierSchema } from './skill-asset.js';
import type { WorkflowDefinitionShape } from './workflow-definition.js';
import { sha256DigestSchema, workflowDefinitionSchema } from './workflow-definition.js';

export const workflowDefinitionSnapshotSchema: z.ZodType<WorkflowDefinitionSnapshotShape> = z
  .object({
    schemaVersion: z.literal('workflow-definition-snapshot/v1'),
    workflow: z.object({ id: WorkflowKind, version: semverSchema }).strict(),
    registryGeneration: z.number().int().nonnegative(),
    definitionDigest: sha256DigestSchema,
    definition: workflowDefinitionSchema,
    inputSchema: z
      .object({ id: z.string().min(1).max(64), version: semverSchema, digest: sha256DigestSchema })
      .strict(),
    outputSchema: z
      .object({ id: z.string().min(1).max(64), version: semverSchema, digest: sha256DigestSchema })
      .strict(),
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            version: semverSchema,
            trustTier: skillTrustTierSchema,
            digest: sha256DigestSchema,
          })
          .strict(),
      )
      .max(64),
    /** Digest over canonical sorted tool refs (tool contents live in C024). */
    toolsDigest: sha256DigestSchema,
    /** Digest over canonical sorted validator requirements. */
    validatorsDigest: sha256DigestSchema,
    /** Digest over canonical sorted capability refs. */
    capabilitiesDigest: sha256DigestSchema,
    createdAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), 'expected ISO timestamp'),
  })
  .strict();

export interface WorkflowDefinitionSnapshotShape {
  readonly schemaVersion: 'workflow-definition-snapshot/v1';
  readonly workflow: { readonly id: WorkflowKind; readonly version: Semver };
  readonly registryGeneration: number;
  readonly definitionDigest: string;
  readonly definition: WorkflowDefinitionShape;
  readonly inputSchema: { readonly id: string; readonly version: Semver; readonly digest: string };
  readonly outputSchema: { readonly id: string; readonly version: Semver; readonly digest: string };
  readonly skills: readonly {
    readonly id: string;
    readonly version: Semver;
    readonly trustTier: SkillTrustTier;
    readonly digest: string;
  }[];
  readonly toolsDigest: string;
  readonly validatorsDigest: string;
  readonly capabilitiesDigest: string;
  readonly createdAt: string;
}
