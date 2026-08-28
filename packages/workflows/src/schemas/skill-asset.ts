/**
 * C045 §8/§23.4 — versioned skill asset schema (skill-asset/v1).
 *
 * Skill assets are signed/digested, versioned build artifacts around the one
 * core agent. Trust tiers: `global_core` (immutable safety/operating rules,
 * composed FIRST) and `workflow` (workflow objective/rules). A skill contains
 * objective, approach constraints, evidence expectations, tools, completion
 * and safety reminders — NEVER mutable autonomy/policy decisions (C045 §4.5).
 *
 * `digest` is computed by the compiler over the canonical content and is the
 * registration identity component: `(id, version, digest)`.
 */
import { z } from 'zod';
import type { Semver } from './semver.js';
import { digestJson } from '../canonical.js';
import { sha256DigestSchema } from './workflow-definition.js';
import { semverSchema } from './semver.js';

export const skillTrustTierSchema = z.enum(['global_core', 'workflow']);
export type SkillTrustTier = z.infer<typeof skillTrustTierSchema>;

export const skillMediaTypeSchema = z.enum(['text/markdown', 'text/plain']);
export type SkillMediaType = z.infer<typeof skillMediaTypeSchema>;

/** Bounded context variable names the skill requires (provider maps them). */
export const contextVariableSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'context variable must be snake_case, 1..64 chars');

/** Source/build provenance — never runtime policy or user content. */
export const skillSourceSchema = z
  .object({
    path: z.string().min(1).max(512),
    buildId: z.string().max(128).optional(),
    signature: z.string().max(1024).optional(),
  })
  .strict();
export type SkillSource = z.infer<typeof skillSourceSchema>;

/** Authored skill asset before compilation (no digest yet). */
export const skillSourceAssetSchema = z
  .object({
    schemaVersion: z.literal('skill-asset/v1'),
    id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/),
    version: semverSchema,
    trustTier: skillTrustTierSchema,
    mediaType: skillMediaTypeSchema,
    content: z.string().min(1).max(64_000),
    // Omitted sets normalize to empty arrays.
    requiredContextVariables: z.array(contextVariableSchema).max(64).default([]),
    prohibitedMutableFields: z.array(contextVariableSchema).max(64).default([]),
    source: skillSourceSchema,
  })
  .strict();
export type SkillSourceAsset = z.infer<typeof skillSourceAssetSchema>;

/** Sealed asset: source + computed content digest (registration identity). */
export const skillAssetSchema: z.ZodType<SkillAssetShape> = z
  .object({
    schemaVersion: z.literal('skill-asset/v1'),
    id: z.string().regex(/^[a-z][a-z0-9._-]{1,127}$/),
    version: semverSchema,
    trustTier: skillTrustTierSchema,
    mediaType: skillMediaTypeSchema,
    content: z.string().min(1).max(64_000),
    requiredContextVariables: z.array(contextVariableSchema).max(64),
    prohibitedMutableFields: z.array(contextVariableSchema).max(64),
    source: skillSourceSchema,
    digest: sha256DigestSchema,
  })
  .strict();

export interface SkillAssetShape {
  readonly schemaVersion: 'skill-asset/v1';
  readonly id: string;
  readonly version: Semver;
  readonly trustTier: SkillTrustTier;
  readonly mediaType: SkillMediaType;
  readonly content: string;
  readonly requiredContextVariables: readonly string[];
  readonly prohibitedMutableFields: readonly string[];
  readonly source: SkillSource;
  readonly digest: string;
}

/** Structural subset shared by authored and sealed assets (digest input). */
export type SkillContentShape = Omit<SkillAssetShape, 'digest'>;

const renderedVersion = (version: Semver): string =>
  `${version.major}.${version.minor}.${version.patch}${
    version.prerelease !== undefined ? `-${version.prerelease}` : ''
  }`;

/**
 * Canonical digest payload: identity + content + provenance path. The
 * signature (if any) is deliberately EXCLUDED — the digest is what a
 * signature proves, never the other way around; buildId is included so a
 * digest cannot be re-bound to a different build.
 */
export function skillAssetContentPayload(asset: SkillContentShape): unknown {
  return {
    schemaVersion: asset.schemaVersion,
    id: asset.id,
    version: renderedVersion(asset.version),
    trustTier: asset.trustTier,
    mediaType: asset.mediaType,
    content: asset.content,
    requiredContextVariables: [...asset.requiredContextVariables].sort(),
    prohibitedMutableFields: [...asset.prohibitedMutableFields].sort(),
    source: {
      path: asset.source.path,
      ...(asset.source.buildId !== undefined ? { buildId: asset.source.buildId } : {}),
    },
  };
}

/** Deterministic content digest of a skill asset (registration identity). */
export function computeSkillAssetDigest(asset: SkillContentShape): string {
  return digestJson(skillAssetContentPayload(asset));
}
