/**
 * C045 §12/§23.2 — definition validator: canonicalize, seal and cross-check.
 *
 * Every candidate is zod-parsed at the boundary, canonicalized, cross-checked
 * against the action/validator/tool/schema/capability/skill catalogs, and
 * sealed with a content digest. Validation NEVER executes anything and NEVER
 * reads the filesystem — the loader passes explicit records (C045 §12).
 *
 * Fail-closed rules enforced here:
 *  - unknown action/validator/tool/schema/capability/skill ids ⇒ issue
 *  - duplicate (id, version) with identical digest ⇒ no-op; with a DIFFERENT
 *    digest ⇒ WORKFLOW_VERSION_IMMUTABLE (definitions are immutable, §20)
 *  - steps must be unique, bounded (finite attempts/timeout) and declare an
 *    explicit failure behavior
 *  - completion evidence is structurally REQUIRED (schema literal) and the
 *    validator confirms the output schema ref exists in the schema catalog
 *  - compatibility ranges must parse; pre-release rules are handled by the
 *    semver module
 */
import { makeError } from '@devguard/errors';
import { digestJson } from '../canonical.js';
import { computeSkillAssetDigest, skillAssetSchema, type SkillAssetShape } from '../schemas/skill-asset.js';
import { detectMutablePolicy } from '../skills/mutable-policy-detector.js';
import { semverRangeSchema } from '../schemas/semver.js';
import type { Semver } from '../schemas/semver.js';
import { type SchemaRef, type WorkflowDefinitionSource } from '../schemas/workflow-definition.js';
import type { ValidatorKindMember } from '../schemas/workflow-definition.js';
import {
  isKnownCapability,
  isKnownValidatorKind,
  type SchemaCatalogPort,
  type ToolCatalogPort,
} from './catalogs.js';

export type ValidationIssueCode =
  | 'WORKFLOW_DEFINITION_INVALID'
  | 'WORKFLOW_CROSS_REFERENCE_UNKNOWN'
  | 'WORKFLOW_SKILL_DIGEST_MISMATCH'
  | 'WORKFLOW_VERSION_IMMUTABLE';

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly path: string;
  readonly constraint: string;
  readonly refKind?:
    'action' | 'validator' | 'tool' | 'schema' | 'capability' | 'skill' | undefined;
  readonly refId?: string | undefined;
  readonly refVersion?: string | undefined;
  readonly expectedDigest?: string | undefined;
  readonly actualDigest?: string | undefined;
}

/** Sealed canonical content (registry assigns status; digest is content-only). */
export interface SealedDefinition {
  readonly source: WorkflowDefinitionSource;
  /** sha256 over canonical content (status/digest excluded). */
  readonly digest: string;
  readonly issues: readonly ValidationIssue[];
  readonly duplicate: DuplicateDetection;
}

export interface DuplicateDetection {
  readonly kind: 'unique' | 'identical' | 'conflict';
  readonly existingDigest?: string | undefined;
}

export interface ValidateDefinitionOptions {
  readonly source: WorkflowDefinitionSource;
  readonly schemaCatalog: SchemaCatalogPort;
  readonly toolCatalog: ToolCatalogPort;
  readonly skillAssetsByRef: ReadonlyMap<string, SkillAssetShape>;
  /** All definitions in this load (for duplicate detection). */
  readonly seen: ReadonlyMap<string, string>; // `${id}@${version}` => digest
}

const keyOf = (id: string, version: string): string => `${id}@${version}`;

/** Canonical digest payload: set-like fields sorted, steps keep their order. */
function canonicalDefinitionPayload(source: WorkflowDefinitionSource): unknown {
  return {
    schemaVersion: source.schemaVersion,
    id: source.id,
    name: source.name,
    description: source.description,
    version: `${source.version.major}.${source.version.minor}.${source.version.patch}${
      source.version.prerelease !== undefined ? `-${source.version.prerelease}` : ''
    }`,
    inputSchema: source.inputSchema,
    outputSchema: source.outputSchema,
    allowedActions: [...source.allowedActions].sort(),
    validators: [...source.validators].sort((a, b) =>
      a.kind === b.kind
        ? compareVersionStrings(versionString(a.version), versionString(b.version))
        : a.kind.localeCompare(b.kind),
    ),
    tools: [...source.tools].sort((a, b) =>
      a.id === b.id ? a.registryVersion.localeCompare(b.registryVersion) : a.id.localeCompare(b.id),
    ),
    skills: [...source.skills].sort((a, b) =>
      a.id === b.id
        ? compareVersionStrings(versionString(a.version), versionString(b.version))
        : a.id.localeCompare(b.id),
    ),
    capabilities: [...source.capabilities].sort((a, b) => a.id.localeCompare(b.id)),
    steps: source.steps,
    limits: source.limits,
    completion: source.completion,
    failure: source.failure,
    compatibility: [...source.compatibility].sort(),
  };
}

function versionString(version: Semver | undefined): string {
  if (version === undefined) return '';
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease !== undefined ? `-${version.prerelease}` : ''}${version.build !== undefined ? `+${version.build}` : ''}`;
}

function compareVersionStrings(left: string, right: string): number {
  if (left === '' && right === '') return 0;
  if (left === '') return -1;
  if (right === '') return 1;
  return left.localeCompare(right);
}

/** Deterministic content digest of a parsed definition source. */
export function definitionDigest(source: WorkflowDefinitionSource): string {
  return digestJson(canonicalDefinitionPayload(source));
}

function issue(
  code: ValidationIssueCode,
  path: string,
  constraint: string,
  extra?: Partial<ValidationIssue>,
): ValidationIssue {
  return { code, path, constraint, ...extra };
}

function checkSchemaRef(
  path: string,
  ref: SchemaRef,
  schemaCatalog: SchemaCatalogPort,
  issues: ValidationIssue[],
): void {
  const entry = schemaCatalog.getSchema({ id: ref.id, version: versionOf(ref.version) });
  if (entry === undefined) {
    issues.push(
      issue(
        'WORKFLOW_CROSS_REFERENCE_UNKNOWN',
        path,
        'schema ref is unknown to the schema catalog',
        {
          refKind: 'schema',
          refId: ref.id,
          refVersion: versionOf(ref.version),
        },
      ),
    );
  }
}

/** Render a semantic-version object to its canonical string form. */
export function versionOf(version: Semver | undefined): string {
  if (version === undefined) return '';
  return `${version.major}.${version.minor}.${version.patch}${
    version.prerelease !== undefined ? `-${version.prerelease}` : ''
  }`;
}

/** Seals one definition candidate; returns issues instead of throwing. */
export function validateDefinition(options: ValidateDefinitionOptions): SealedDefinition {
  const { source, schemaCatalog, toolCatalog, skillAssetsByRef, seen } = options;
  // The caller (registry) has already enforced the strict source schema at the
  // boundary; validation here applies structural + cross-reference rules to the
  // parsed, output-typed definition.
  const definition = source;
  const issues: ValidationIssue[] = [];

  // 1. Duplicate/immutability check within this load (and against `seen`).
  const identity = keyOf(definition.id, versionOf(definition.version));
  const digest = definitionDigest(definition);
  const existing = seen.get(identity);
  let duplicate: DuplicateDetection = { kind: 'unique' };
  if (existing !== undefined) {
    duplicate =
      existing === digest
        ? { kind: 'identical', existingDigest: existing }
        : { kind: 'conflict', existingDigest: existing };
  }

  // 3. Cross-references.
  for (const tool of definition.tools) {
    if (toolCatalog.getTool({ id: tool.id, registryVersion: tool.registryVersion }) === undefined) {
      issues.push(
        issue(
          'WORKFLOW_CROSS_REFERENCE_UNKNOWN',
          `tools.${tool.id}`,
          'tool ref is unknown to the tool registry',
          {
            refKind: 'tool',
            refId: tool.id,
            refVersion: tool.registryVersion,
          },
        ),
      );
    }
  }
  checkSchemaRef('inputSchema', definition.inputSchema, schemaCatalog, issues);
  checkSchemaRef('outputSchema', definition.outputSchema, schemaCatalog, issues);

  for (const capability of definition.capabilities) {
    if (!isKnownCapability(capability.id)) {
      issues.push(
        issue(
          'WORKFLOW_CROSS_REFERENCE_UNKNOWN',
          `capabilities.${capability.id}`,
          'capability id is unknown',
          {
            refKind: 'capability',
            refId: capability.id,
            refVersion:
              capability.version !== undefined ? versionOf(capability.version) : undefined,
          },
        ),
      );
    }
  }

  for (const skill of definition.skills) {
    const asset = skillAssetsByRef.get(keyOf(skill.id, versionOf(skill.version)));
    if (asset === undefined) {
      issues.push(
        issue(
          'WORKFLOW_CROSS_REFERENCE_UNKNOWN',
          `skills.${skill.id}`,
          'skill asset is not registered in this build',
          {
            refKind: 'skill',
            refId: skill.id,
            refVersion: versionOf(skill.version),
          },
        ),
      );
    } else if (!skillAssetSchema.safeParse(asset).success) {
        issues.push(issue('WORKFLOW_DEFINITION_INVALID', `skills.${skill.id}`, 'sealed skill asset failed schema validation'));
      } else if (detectMutablePolicy(asset)[0] !== undefined) {
        const scanIssue = detectMutablePolicy(asset)[0]!;
        issues.push(issue('WORKFLOW_DEFINITION_INVALID', `skills.${skill.id}`, `skill rejected by static scan: ${scanIssue.detail} (line ${scanIssue.line})`));
      } else if (asset.digest !== computeSkillAssetDigest(asset)) {
      issues.push(
        issue(
          'WORKFLOW_SKILL_DIGEST_MISMATCH',
          `skills.${skill.id}`,
          'sealed skill digest does not match its content',
          {
            expectedDigest: asset.digest,
            actualDigest: computeSkillAssetDigest(asset),
          },
        ),
      );
    }
  }

  // 4. Structural rules beyond the schema.
  const stepIds = new Set<string>();
  for (const step of definition.steps) {
    if (stepIds.has(step.id)) {
      issues.push(
        issue(
          'WORKFLOW_DEFINITION_INVALID',
          `steps.${step.id}`,
          'step ids must be unique within a definition',
        ),
      );
    }
    stepIds.add(step.id);
  }

  // Every definition composes around the ONE core agent: at least one
  // global_core (immutable safety) skill must be referenced.
  let hasCoreSkill = false;
  for (const skill of definition.skills) {
    const asset = skillAssetsByRef.get(keyOf(skill.id, versionOf(skill.version)));
    if (asset !== undefined && asset.trustTier === 'global_core') hasCoreSkill = true;
  }
  if (!hasCoreSkill) {
    issues.push(
      issue(
        'WORKFLOW_DEFINITION_INVALID',
        'skills',
        'at least one global_core (immutable safety) skill is required',
      ),
    );
  }
  for (const ref of definition.completion.requiredValidators) {
    checkValidatorRef(`completion.requiredValidators.${ref.kind}`, ref.kind, issues);
  }
  for (const requirement of definition.validators) {
    checkValidatorRef(`validators.${requirement.kind}`, requirement.kind, issues);
  }
  for (const condition of definition.completion.conditions ?? []) {
    if (condition.kind === 'validators_passed') {
      for (const ref of condition.validators) {
        checkValidatorRef(`completion.conditions.${ref.kind}`, ref.kind, issues);
      }
    }
  }
  for (const condition of definition.failure.conditions) {
    if (condition.kind === 'validation_failed') {
      for (const ref of condition.validators) {
        checkValidatorRef(`failure.${ref.kind}`, ref.kind, issues);
      }
    }
  }
  for (const range of definition.compatibility) {
    const parsedRange = semverRangeSchema.safeParse(range);
    if (!parsedRange.success) {
      issues.push(
        issue(
          'WORKFLOW_DEFINITION_INVALID',
          'compatibility',
          `invalid compatibility range '${String(range)}'`,
        ),
      );
    }
  }
  if (
    definition.limits?.maxSteps !== undefined &&
    definition.limits.maxSteps < definition.steps.length
  ) {
    issues.push(
      issue(
        'WORKFLOW_DEFINITION_INVALID',
        'limits.maxSteps',
        `maxSteps (${definition.limits.maxSteps}) is below the declared step count (${definition.steps.length})`,
      ),
    );
  }

  return {
    source: definition,
    digest,
    issues,
    duplicate,
  };
}

function checkValidatorRef(
  path: string,
  kind: ValidatorKindMember,
  issues: ValidationIssue[],
): void {
  if (!isKnownValidatorKind(kind)) {
    issues.push(
      issue('WORKFLOW_CROSS_REFERENCE_UNKNOWN', path, 'validator kind is unknown', {
        refKind: 'validator',
        refId: kind,
      }),
    );
  }
}

/** Convenience accessor returning the rendered version string. */
export function renderVersion(version: Semver): string {
  return versionOf(version);
}

/** Throwing variant used by hot-path lookups; keeps detail payloads safe. */
export function crossReferenceError(
  workflowId: string,
  version: string,
  refKind: ValidationIssue['refKind'],
  refId: string,
  refVersion?: string,
): Error {
  return makeError('WORKFLOW_CROSS_REFERENCE_UNKNOWN', {
    details: {
      workflowId,
      version,
      refKind: refKind ?? 'workflow',
      refId,
      ...(refVersion !== undefined ? { refVersion } : {}),
    },
  });
}
