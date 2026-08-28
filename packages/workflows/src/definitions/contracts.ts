/**
 * C045 §8/§9/§10 — workflow definition + skill contracts.
 *
 * Definitions are immutable, versioned build assets: typed inputs/outputs,
 * ordered step templates, allowed action types (a maximum-capability ceiling,
 * never an authorization), validators/freshness, limits, artifacts, and
 * completion/failure rules. Skills are composed in explicit trust order with
 * provenance and carry NO mutable policy (policy is a durable runtime snapshot,
 * never embedded in prompts). Unknown/unsupported references fail closed.
 */
import { z } from 'zod';

export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1 as const;

export const DEFINITION_STATUSES = [
  'DISCOVERED',
  'VALIDATING',
  'ACTIVE',
  'DEPRECATED',
  'RETIRED',
] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

export const TRUST_TIERS = ['global_core', 'workflow'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const stepTemplateSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(['turn', 'validator', 'command', 'approval', 'published']),
    actionTypes: z.array(z.string().min(1).max(64)).max(32),
    maxRetries: z.number().int().nonnegative().max(8),
    maxWallMillis: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
    failureBehavior: z.enum(['fail_run', 'stop', 'repair_turn']),
    validatorIds: z.array(z.string().min(1).max(64)).max(16),
  })
  .strict();
export interface WorkflowStepTemplate {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'approval' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const workflowDefinitionSchema = z
  .object({
    id: z.string().min(1).max(64),
    semanticVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: z.enum(DEFINITION_STATUSES),
    enabled: z.boolean(),
    agentDefinitionId: z.string().min(1).max(64),
    inputSchemaId: z.string().min(1).max(64),
    outputSchemaId: z.string().min(1).max(64),
    steps: z.array(stepTemplateSchema).min(1).max(64),
    allowedActionTypes: z.array(z.string().min(1).max(64)).max(64),
    requiredCapabilities: z.array(z.string().min(1).max(64)).max(32),
    artifactDeclarations: z.array(z.string().min(1).max(128)).max(32),
    skillBundleRefs: z.array(z.string().min(1).max(128)).max(32),
    compatibilityRange: z.string().min(1).max(64),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export interface WorkflowDefinition {
  readonly id: string;
  readonly semanticVersion: string;
  readonly status: DefinitionStatus;
  readonly enabled: boolean;
  readonly agentDefinitionId: string;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly steps: readonly WorkflowStepTemplate[];
  readonly allowedActionTypes: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly artifactDeclarations: readonly string[];
  readonly skillBundleRefs: readonly string[];
  readonly compatibilityRange: string;
  readonly digest: string;
}

export const skillAssetSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(32),
    trustTier: z.enum(TRUST_TIERS),
    mediaType: z.string().min(1).max(64),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
    requiredContextVariables: z.array(z.string().max(64)).max(32),
    prohibitedMutableFields: z.array(z.string().max(64)).max(32),
    sourceProvenance: z.string().max(200),
  })
  .strict();
export interface SkillAsset {
  readonly id: string;
  readonly version: string;
  readonly trustTier: TrustTier;
  readonly mediaType: string;
  readonly contentDigest: string;
  readonly requiredContextVariables: readonly string[];
  readonly prohibitedMutableFields: readonly string[];
  readonly sourceProvenance: string;
}

/** Immutable run-bound snapshot (C045 §9/§13). */
export interface WorkflowDefinitionSnapshot {
  readonly id: string;
  readonly definitionId: string;
  readonly semanticVersion: string;
  readonly normalizedJsonDigest: string;
  readonly normalizedJson: string;
  readonly capturedAtIso: string;
}

export interface WorkflowCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly available: boolean;
  readonly blockReason?: string | undefined;
  readonly inputSchemaId: string;
}

export type RegisterResult =
  | { readonly ok: true; readonly definition: WorkflowDefinition }
  | {
      readonly ok: false;
      readonly code:
        'WORKFLOW_VERSION_IMMUTABLE' | 'INVALID' | 'BLOCKED_CAPABILITY' | 'UNKNOWN_REFERENCE';
      readonly detail: string;
    };

export const workflowDefinitionContractsSchema = {
  workflowDefinitionSchema,
  skillAssetSchema,
  stepTemplateSchema,
};
