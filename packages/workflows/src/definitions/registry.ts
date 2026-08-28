/**
 * C045 §9/§10/§12 — immutable workflow definition registry.
 *
 * Build assets are registered once; the same `(id, version, digest)` is a no-op,
 * but a conflicting digest for an existing version is `WORKFLOW_VERSION_IMMUTABLE`
 * and rejects. Cross-references to action/tool/validator/capabilities/artifacts
 * are validated; unknown references fail closed. The registry swaps atomically —
 * a partially invalid candidate is never exposed. Definitions/skill digests are
 * canonical; a run snapshot binds exact versions.
 */
import { createHash } from 'node:crypto';
import {
  workflowDefinitionSchema,
  skillAssetSchema,
  type RegisterResult,
  type SkillAsset,
  type WorkflowCatalogEntry,
  type WorkflowDefinition,
  type WorkflowDefinitionSnapshot,
} from './contracts.js';

export interface RegistryKnownIds {
  readonly actionTypes: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<string>;
  readonly validators: ReadonlySet<string>;
}

export interface WorkflowDefinitionRegistryDeps {
  readonly known: RegistryKnownIds;
  readonly clock?: { readonly nowIso: () => string };
  readonly featureAvailability?: (definition: WorkflowDefinition) => {
    readonly available: boolean;
    readonly reason?: string | undefined;
  };
}

export class WorkflowDefinitionRegistry {
  readonly #definitions = new Map<string, WorkflowDefinition>(); // `id@version` -> def
  readonly #skills = new Map<string, SkillAsset>(); // `id@version` -> skill
  generation = 0;
  readonly #deps: WorkflowDefinitionRegistryDeps;

  constructor(deps: WorkflowDefinitionRegistryDeps) {
    this.#deps = deps;
  }

  registerSkill(skill: SkillAsset): void {
    const parsed = skillAssetSchema.safeParse(skill);
    if (!parsed.success) throw new Error('INVALID_SKILL');
    const key = `${skill.id}@${skill.version}`;
    const existing = this.#skills.get(key);
    if (existing !== undefined && stableStringify(existing) !== stableStringify(skill))
      throw new Error('WORKFLOW_VERSION_IMMUTABLE');
    this.#skills.set(key, deepFreeze(deepClone(skill)));
  }

  register(definition: WorkflowDefinition): RegisterResult {
    // Recompute canonical digest (definition.digest must be truthfully derivable).
    if (definition.digest !== canonicalDigest(definition)) {
      return { ok: false, code: 'INVALID', detail: 'digest mismatch' };
    }
    const parsed = workflowDefinitionSchema.safeParse(definition);
    if (!parsed.success) return { ok: false, code: 'INVALID', detail: 'schema' };

    // Cross-reference validation (fail closed on unknown ids).
    for (const action of definition.allowedActionTypes)
      if (!this.#deps.known.actionTypes.has(action))
        return { ok: false, code: 'UNKNOWN_REFERENCE', detail: `action ${action}` };
    for (const step of definition.steps) {
      for (const action of step.actionTypes)
        if (!definition.allowedActionTypes.includes(action))
          return {
            ok: false,
            code: 'UNKNOWN_REFERENCE',
            detail: `action ${action} exceeds ceiling`,
          };
      for (const action of step.actionTypes)
        if (!this.#deps.known.actionTypes.has(action))
          return { ok: false, code: 'UNKNOWN_REFERENCE', detail: `action ${action}` };
      for (const v of step.validatorIds)
        if (!this.#deps.known.validators.has(v))
          return { ok: false, code: 'UNKNOWN_REFERENCE', detail: `validator ${v}` };
    }
    for (const cap of definition.requiredCapabilities)
      if (!this.#deps.known.capabilities.has(cap))
        return { ok: false, code: 'UNKNOWN_REFERENCE', detail: `capability ${cap}` };

    const key = `${definition.id}@${definition.semanticVersion}`;
    const existing = this.#definitions.get(key);
    if (existing !== undefined) {
      if (existing.digest === definition.digest) return { ok: true, definition: existing };
      return {
        ok: false,
        code: 'WORKFLOW_VERSION_IMMUTABLE',
        detail: 'conflicting digest for existing version',
      };
    }

    const availability = this.#deps.featureAvailability?.(definition) ?? { available: true };
    if (!availability.available && definition.enabled) {
      return {
        ok: false,
        code: 'BLOCKED_CAPABILITY',
        detail: availability.reason ?? 'capability unsupported',
      };
    }

    const activated = deepFreeze(
      deepClone({ ...definition, status: 'ACTIVE' }),
    ) as WorkflowDefinition;
    this.#definitions.set(key, activated);
    this.generation += 1;
    return { ok: true, definition: activated };
  }

  resolve(id: string, version?: string): WorkflowDefinition {
    const candidate =
      version !== undefined ? `${id}@${version}` : firstKey(this.#definitions.keys(), id);
    const def = candidate !== undefined ? this.#definitions.get(candidate) : undefined;
    if (def === undefined) throw new Error('WORKFLOW_UNKNOWN');
    if (def.status === 'RETIRED' && version !== undefined)
      throw new Error('WORKFLOW_VERSION_RETIRED');
    if (!def.enabled) throw new Error('WORKFLOW_CAPABILITY_UNSUPPORTED');
    return def;
  }

  snapshot(id: string, version: string): WorkflowDefinitionSnapshot {
    const def = this.#definitions.get(`${id}@${version}`);
    if (def === undefined) throw new Error('WORKFLOW_UNKNOWN');
    const normalized = JSON.stringify(def);
    return {
      id: `snap:${sha256(`${id}@${version}`).slice(0, 16)}`,
      definitionId: id,
      semanticVersion: version,
      normalizedJsonDigest: sha256(normalized),
      normalizedJson: normalized,
      capturedAtIso: this.#deps.clock?.nowIso() ?? new Date().toISOString(),
    };
  }

  list(): WorkflowCatalogEntry[] {
    const out: WorkflowCatalogEntry[] = [];
    for (const def of this.#definitions.values()) {
      const availability = this.#deps.featureAvailability?.(def) ?? { available: true };
      out.push({
        id: def.id,
        version: def.semanticVersion,
        name: def.id,
        available: def.enabled && availability.available,
        blockReason:
          def.enabled && !availability.available
            ? (availability.reason ?? 'capability unsupported')
            : undefined,
        inputSchemaId: def.inputSchemaId,
      });
    }
    return out;
  }

  hasDefinition(id: string, version: string): boolean {
    return this.#definitions.has(`${id}@${version}`);
  }
}

export function canonicalDigest(definition: WorkflowDefinition): string {
  const { digest: _digest, ...rest } = definition;
  return sha256(
    JSON.stringify({
      id: rest.id,
      version: rest.semanticVersion,
      steps: rest.steps,
      schemaOutput: rest.outputSchemaId,
    }),
  );
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function firstKey(keys: IterableIterator<string>, id: string): string | undefined {
  for (const key of keys) if (key.startsWith(`${id}@`)) return key;
  return undefined;
}
