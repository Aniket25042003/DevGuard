/**
 * C045 §9/§12/§23 — versioned workflow definition registry.
 *
 * Assembles a validated, immutable definition into a sealed snapshot,
 * enforces one-write/immutability per (id, version), keeps a current-pointer
 * per definition, and emits lifecycle events. Validation never executes
 * anything and never reads the filesystem; provider/persistence wiring flows
 * through typed ports (catalogs, snapshot store, event sink).
 *
 * Lifecycle: a candidate is either ACTIVATED (valid + capability-satisfiable)
 * or BLOCKED (issues/unsupported). Versions are immutable: re-registering the
 * same (id, version) with an identical digest is a no-op; a different digest
 * is rejected as WORKFLOW_VERSION_IMMUTABLE.
 */
import { makeError } from '@devguard/errors';
import '../errors.js';
import { digestJson } from '../canonical.js';
import {
  validateDefinition,
  versionOf,
  type SealedDefinition,
  type ValidationIssue,
} from '../definitions/definition-validator.js';
import type { SchemaCatalogPort, ToolCatalogPort } from '../definitions/catalogs.js';
import {
  workflowDefinitionSourceSchema,
  type WorkflowDefinitionShape,
  type WorkflowDefinitionSourceInput,
} from '../schemas/workflow-definition.js';
import { type WorkflowDefinitionSnapshotShape } from '../schemas/snapshot.js';
import type { SkillAssetShape } from '../schemas/skill-asset.js';
import type { SnapshotPersistencePort } from '../ports/snapshot-persistence-port.js';
import { emitWorkflowEvent, type EventSinkPort } from '../events.js';
import { compareSemver } from '../schemas/semver.js';

export interface RegistryBuildContext {
  readonly schemaCatalog: SchemaCatalogPort;
  readonly toolCatalog: ToolCatalogPort;
  /** Digest-addressed skill assets keyed by `${id}@${version}`. */
  readonly skillAssets: ReadonlyMap<string, SkillAssetShape>;
  readonly persistence?: SnapshotPersistencePort | undefined;
  readonly events?: EventSinkPort | undefined;
  readonly registryGeneration: number;
}

export type RegisterOutcome =
  | { readonly outcome: 'registered'; readonly snapshot: WorkflowDefinitionSnapshotShape }
  | {
      readonly outcome: 'blocked';
      readonly issues: readonly ValidationIssue[];
      readonly reasonCode: 'WORKFLOW_DEFINITION_INVALID';
    };

const keyOf = (id: string, version: string): string => `${id}@${version}`;

function sortTools(refs: readonly { id: string; registryVersion: string }[]): string[] {
  return [...refs].map((ref) => JSON.stringify([ref.id, ref.registryVersion])).sort();
}

function sortValidators(
  refs: readonly {
    kind: string;
    version?: { major: number; patch: number; minor: number } | undefined;
  }[],
): string[] {
  return [...refs]
    .map((ref) =>
      JSON.stringify([ref.kind, ref.version !== undefined ? versionOf(ref.version) : '']),
    )
    .sort();
}

function sortCapabilities(
  refs: readonly {
    id: string;
    version?: { major: number; patch: number; minor: number } | undefined;
  }[],
): string[] {
  return [...refs]
    .map((ref) => JSON.stringify([ref.id, ref.version !== undefined ? versionOf(ref.version) : '']))
    .sort();
}

/**
 * Deterministic sub-digests over the sorted cross-reference sets so changing
 * any tool/validator/capability changes the snapshot even when the definition
 * source digest does not.
 */
function digestOfSet(values: readonly string[]): string {
  return digestJson({ entries: values });
}

function sealDefinition(
  sealed: SealedDefinition,
  context: RegistryBuildContext,
  nowIso: string,
): WorkflowDefinitionSnapshotShape {
  const source = sealed.source;
  const input = context.schemaCatalog.getSchema({
    id: source.inputSchema.id,
    version: versionOf(source.inputSchema.version),
  });
  const output = context.schemaCatalog.getSchema({
    id: source.outputSchema.id,
    version: versionOf(source.outputSchema.version),
  });
  if (input === undefined || output === undefined) {
    // The definition validator already surfaces these as cross-reference
    // issues; seal can only run on a clean definition.
    throw makeError('WORKFLOW_CROSS_REFERENCE_UNKNOWN', {
      details: { refKind: 'schema', refId: source.inputSchema.id },
    });
  }

  const skills: WorkflowDefinitionSnapshotShape['skills'] = source.skills.map((skill) => {
    const asset = context.skillAssets.get(keyOf(skill.id, versionOf(skill.version)));
    if (asset === undefined) {
      throw makeError('WORKFLOW_CROSS_REFERENCE_UNKNOWN', {
        details: { refKind: 'skill', refId: skill.id, refVersion: versionOf(skill.version) },
      });
    }
    return {
      id: skill.id,
      version: asset.version,
      trustTier: asset.trustTier,
      digest: asset.digest,
    };
  });

  const definition: WorkflowDefinitionShape = {
    ...source,
    status: 'active',
    digest: sealed.digest,
  };

  const snapshot: WorkflowDefinitionSnapshotShape = {
    schemaVersion: 'workflow-definition-snapshot/v1',
    workflow: { id: source.id, version: source.version },
    registryGeneration: context.registryGeneration,
    definitionDigest: sealed.digest,
    definition,
    inputSchema: { id: input.id, version: source.inputSchema.version, digest: input.digest },
    outputSchema: { id: output.id, version: source.outputSchema.version, digest: output.digest },
    skills,
    toolsDigest: digestOfSet(sortTools(source.tools)),
    validatorsDigest: digestOfSet(sortValidators(source.validators)),
    capabilitiesDigest: digestOfSet(sortCapabilities(source.capabilities)),
    createdAt: nowIso,
  };
  // Boundary validation: the snapshot is assembled from a source that already
  // passed the strict `workflowDefinitionSourceSchema` plus verified catalog
  // lookups; the output-typed shape is structurally valid by construction.
  return snapshot;
}

/** In-memory current-pointer for tests/composition until C046 owns persistence. */
export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinitionSnapshotShape>();

  constructor(private readonly context: RegistryBuildContext) {}

  /** Current active snapshot by definition id (highest registered version). */
  current(id: string): WorkflowDefinitionSnapshotShape | undefined {
    let latest: WorkflowDefinitionSnapshotShape | undefined;
    for (const snapshot of this.definitions.values()) {
      if (snapshot.workflow.id !== id) continue;
      if (latest === undefined) {
        latest = snapshot;
        continue;
      }
      latest =
        compareSemver(latest.workflow.version, snapshot.workflow.version) >= 0
          ? latest
          : snapshot;
    }
    return latest;
  }

  list(): readonly WorkflowDefinitionSnapshotShape[] {
    return [...this.definitions.values()];
  }

  /** Register a definition candidate, sealing it into an immutable snapshot. */
  async register(source: WorkflowDefinitionSourceInput): Promise<RegisterOutcome> {
    // Boundary parse: the strict source schema rejects unknown keys, invalid
    // semver strings, empty required sets and missing completion evidence.
    const parsed = workflowDefinitionSourceSchema.safeParse(source);
    if (!parsed.success) {
      const issues: ValidationIssue[] = parsed.error.issues.map((zodIssue) => ({
        code: 'WORKFLOW_DEFINITION_INVALID',
        path: zodIssue.path.join('.') || '(root)',
        constraint: zodIssue.message,
      }));
      emitWorkflowEvent(
        this.context.events,
        'workflow.definition.blocked',
        {
          workflowId: typeof source.id === 'string' ? source.id : String(source.id),
          version: typeof source.version === 'string' ? source.version : '',
          reasons: issues.map((issue) => `${issue.code}: ${issue.constraint}`).slice(0, 16),
        },
        { workflowId: String(source.id), version: String(source.version) },
      );
      return { outcome: 'blocked', issues, reasonCode: 'WORKFLOW_DEFINITION_INVALID' };
    }

    const definition = parsed.data;

    const sealed = validateDefinition({
      source: definition,
      schemaCatalog: this.context.schemaCatalog,
      toolCatalog: this.context.toolCatalog,
      skillAssetsByRef: this.context.skillAssets,
      seen: new Map(),
    });

    if (sealed.issues.length > 0) {
      emitWorkflowEvent(
        this.context.events,
        'workflow.definition.blocked',
        {
          workflowId: definition.id,
          version: versionOf(definition.version),
          reasons: sealed.issues.map((issue) => `${issue.code}: ${issue.constraint}`).slice(0, 16),
        },
        { workflowId: definition.id, version: versionOf(definition.version) },
      );
      return {
        outcome: 'blocked',
        issues: sealed.issues,
        reasonCode: 'WORKFLOW_DEFINITION_INVALID',
      };
    }

    const identity = keyOf(source.id, versionOf(definition.version));
    const existing = this.definitions.get(identity);
    if (existing !== undefined) {
      if (existing.definitionDigest === sealed.digest) {
        return { outcome: 'registered', snapshot: existing };
      }
      throw makeError('WORKFLOW_VERSION_IMMUTABLE', {
        details: { workflowId: definition.id, version: versionOf(definition.version) },
      });
    }

    const snapshot = sealDefinition(sealed, this.context, new Date().toISOString());
    this.definitions.set(identity, snapshot);

    if (this.context.persistence !== undefined) {
      await this.context.persistence.save(snapshot);
    }

    emitWorkflowEvent(
      this.context.events,
      'workflow.definition.registered',
      {
        workflowId: definition.id,
        version: versionOf(definition.version),
        digest: sealed.digest,
      },
      { workflowId: definition.id, version: versionOf(definition.version) },
    );

    return { outcome: 'registered', snapshot };
  }
}

function compareVersions(
  left: { major: number; minor: number; patch: number },
  right: { major: number; minor: number; patch: number },
): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}
