/**
 * C023 §8/§23-1 — RepositoryPolicyV1 schema.
 *
 * External input values stay `unknown` until they pass through this Zod
 * schema; every collection is bounded and every unknown key is rejected
 * (strict objects). The schema is versioned explicitly: `schemaVersion: 1`.
 * Missing grants never imply permission — see normalization for defaults.
 */
import { z } from 'zod';
import { ActionType, AutonomyLevel } from '@devguard/contracts';

/** Conservative system defaults (C023 §8) — outside repository control. */
export const POLICY_LIMIT_DEFAULTS = Object.freeze({
  maxFilesChanged: 25,
  maxIterations: 6,
  maxRuntimeMinutes: 20,
} as const);

/** Global caps a repository policy may expand to, never beyond (C023 §8). */
export const POLICY_LIMIT_GLOBAL_CAPS = Object.freeze({
  maxFilesChanged: 200,
  maxIterations: 30,
  maxRuntimeMinutes: 240,
} as const);

const ownerName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'expected repository owner/name segment');

export const policyLimits = z
  .object({
    maxFilesChanged: z.number().int().min(1).max(POLICY_LIMIT_GLOBAL_CAPS.maxFilesChanged),
    maxIterations: z.number().int().min(1).max(POLICY_LIMIT_GLOBAL_CAPS.maxIterations),
    maxRuntimeMinutes: z.number().int().min(1).max(POLICY_LIMIT_GLOBAL_CAPS.maxRuntimeMinutes),
  })
  .strict();

export type PolicyLimits = z.infer<typeof policyLimits>;

/**
 * Strict V1 document schema. `autonomy` is REQUIRED (user-authored documents
 * without an explicit level are invalid — an omitted level must never widen
 * autonomy); collections default at normalization time, not here, so that
 * diagnostics can distinguish "absent" from "explicitly empty".
 */
export const repositoryPolicyV1 = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.object({ owner: ownerName, name: ownerName }).strict(),
    autonomy: z.object({ level: AutonomyLevel }).strict(),
    triggers: z
      .record(z.string().min(1).max(64), z.array(z.string().min(1).max(64)).max(64))
      .default({}),
    manualCommands: z.array(z.string().min(1).max(64)).max(64).default([]),
    actions: z
      .object({
        allow: z.array(ActionType).max(64).default([]),
        requireApproval: z.array(ActionType).max(64).default([]),
        deny: z.array(ActionType).max(64).default([]),
      })
      .strict()
      .default({ allow: [], requireApproval: [], deny: [] }),
    validation: z
      .object({
        obligations: z.array(z.string().min(1).max(128)).max(32).default([]),
      })
      .strict()
      .default({ obligations: [] }),
    limits: z
      .object({
        maxFilesChanged: z.number().int().min(1),
        maxIterations: z.number().int().min(1),
        maxRuntimeMinutes: z.number().int().min(1),
      })
      .strict()
      .partial()
      .default({}),
  })
  .strict();

export type RepositoryPolicyV1Input = z.input<typeof repositoryPolicyV1>;
export type RepositoryPolicyV1 = z.output<typeof repositoryPolicyV1>;

/** A normalized, defaulted, canonical V1 policy — the persisted shape. */
export interface CanonicalPolicyDocument {
  readonly schemaVersion: 1;
  readonly repository: { readonly owner: string; readonly name: string };
  readonly autonomy: { readonly level: z.infer<typeof AutonomyLevel> };
  /** Sorted, deduplicated workflow IDs per trigger kind. */
  readonly triggers: Readonly<Record<string, readonly string[]>>;
  readonly manualCommands: readonly string[];
  readonly actions: {
    readonly allow: readonly string[];
    readonly requireApproval: readonly string[];
    readonly deny: readonly string[];
  };
  readonly validation: { readonly obligations: readonly string[] };
  readonly limits: PolicyLimits;
}
