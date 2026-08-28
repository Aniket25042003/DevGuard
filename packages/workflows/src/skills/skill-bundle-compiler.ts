/**
 * C045 §12/§23.4 — skill bundle compiler.
 *
 * Compiles a definition's skill refs into ONE provider-neutral bundle with
 * explicit trust order and provenance markers:
 *   1. seal assets (schema parse → content digest → static policy/secret scan)
 *   2. order sections: `global_core` (immutable safety) FIRST, then `workflow`
 *      (objective/rules); each section carries {skillId, version, trustTier,
 *      digest} provenance
 *   3. declare runtime slots (policy_snapshot, repository_instructions,
 *      task_context, tools, current_state) AFTER the static sections — these
 *      are filled by C037 with normalized runtime data, never embedded here
 *   4. seal the bundle with its own digest
 *
 * Same (id,version) with conflicting content is rejected as a digest
 * mismatch (C045 §18/§20) — registration identity is (id, version, digest).
 */
import { makeError } from '@devguard/errors';
import { digestJson } from '../canonical.js';
import { computeSkillAssetDigest } from '../schemas/skill-asset.js';
import { skillSourceAssetSchema, skillAssetSchema } from '../schemas/skill-asset.js';
import type { SkillAssetShape, SkillSourceAsset, SkillTrustTier } from '../schemas/skill-asset.js';
import type { Semver } from '../schemas/semver.js';
import type { SkillRef, WorkflowType } from '../schemas/workflow-definition.js';
import { detectMutablePolicy } from './mutable-policy-detector.js';

export const RUNTIME_SLOTS = [
  'policy_snapshot',
  'repository_instructions',
  'task_context',
  'tools',
  'current_state',
] as const;
export type RuntimeSlotKind = (typeof RUNTIME_SLOTS)[number];

export interface SkillProvenance {
  readonly skillId: string;
  readonly version: string;
  readonly trustTier: SkillTrustTier;
  readonly digest: string;
}

export type BundleSectionKind = 'immutable_safety' | 'workflow' | 'runtime_slot';

export interface SkillBundleSection {
  readonly kind: BundleSectionKind;
  readonly trustTier: SkillTrustTier | 'runtime';
  readonly provenance?: SkillProvenance | undefined;
  readonly content: string;
}

export interface RuntimeSlotDeclaration {
  readonly kind: 'runtime_slot';
  readonly slot: RuntimeSlotKind;
  readonly trustTier: 'runtime';
  readonly content: '';
}

export interface SkillBundle {
  readonly schemaVersion: 'skill-bundle/v1';
  readonly definitionRef: { readonly id: WorkflowType; readonly version: string };
  readonly bundleDigest: string;
  readonly sections: readonly SkillBundleSection[];
  readonly runtimeSlots: readonly RuntimeSlotDeclaration[];
  readonly skillDigests: readonly {
    readonly id: string;
    readonly version: string;
    readonly trustTier: SkillTrustTier;
    readonly digest: string;
  }[];
}

const versionOf = (version: Semver): string =>
  `${version.major}.${version.minor}.${version.patch}${
    version.prerelease !== undefined ? `-${version.prerelease}` : ''
  }`;

const identityOf = (asset: { id: string; version: Semver }): string =>
  `${asset.id}@${versionOf(asset.version)}`;

/**
 * Seal one authored asset: boundary-parse, run the static policy/secret scan
 * (throws WORKFLOW_DEFINITION_INVALID), compute the content digest.
 */
export function sealSkillAsset(source: SkillSourceAsset): SkillAssetShape {
  const parsed = skillSourceAssetSchema.safeParse(source);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw makeError('WORKFLOW_DEFINITION_INVALID', {
      details: [
        {
          path: first !== undefined ? first.path.join('.') : '(root)',
          constraint: first !== undefined ? first.message : 'invalid skill source',
        },
      ],
    });
  }
  const asset = parsed.data;
  const issue = detectMutablePolicy(asset)[0];
  if (issue !== undefined) {
    throw makeError('WORKFLOW_DEFINITION_INVALID', {
      details: [
        {
          path: `skills.${asset.id}`,
          constraint: `skill rejected by static scan: ${issue.detail} (line ${issue.line})`,
        },
      ],
    });
  }
  return skillAssetSchema.parse({ ...asset, digest: computeSkillAssetDigest(asset) });
}

/**
 * Seal a set of assets; conflicting (id,version) content is fatal.
 * Returns {assets, conflicts} — the builder decides how conflicts surface.
 */
export function sealSkillAssets(sources: readonly SkillSourceAsset[]): {
  readonly assets: readonly SkillAssetShape[];
  readonly conflicts: readonly string[];
} {
  const byIdentity = new Map<string, SkillAssetShape>();
  const conflicts: string[] = [];
  const assets: SkillAssetShape[] = [];
  for (const source of sources) {
    const asset = sealSkillAsset(source);
    const existing = byIdentity.get(identityOf(asset));
    if (existing === undefined) {
      byIdentity.set(identityOf(asset), asset);
      assets.push(asset);
    } else if (existing.digest !== asset.digest && !conflicts.includes(identityOf(asset))) {
      conflicts.push(identityOf(asset));
    }
  }
  return { assets, conflicts };
}

function bundleContent(
  sections: readonly SkillBundleSection[],
  runtimeSlots: readonly RuntimeSlotDeclaration[],
): unknown {
  return {
    schemaVersion: 'skill-bundle/v1',
    sections: sections.map((section) => ({
      kind: section.kind,
      trustTier: section.trustTier,
      ...(section.provenance !== undefined ? { provenance: section.provenance } : {}),
      content: section.content,
    })),
    runtimeSlots: runtimeSlots.map((slot) => ({
      kind: slot.kind,
      slot: slot.slot,
      trustTier: slot.trustTier,
    })),
  };
}

/**
 * Compile the ordered bundle for one definition. `assets` must already be
 * sealed; only assets referenced by `definitionSkills` are included, in
 * trust order (global_core first), with stable tie-break ordering.
 */
export function compileSkillBundle(options: {
  readonly definitionId: WorkflowType;
  readonly definitionVersion: Semver;
  readonly definitionSkills: readonly SkillRef[];
  readonly assets: readonly SkillAssetShape[];
  readonly runtimeSlots?: readonly RuntimeSlotKind[] | undefined;
}): SkillBundle {
  const { definitionId, definitionVersion, definitionSkills, assets } = options;
  const byIdentity = new Map<string, SkillAssetShape>();
  for (const asset of assets) {
    byIdentity.set(identityOf(asset), asset);
  }

  const referencedAssets: SkillAssetShape[] = [];
  const seen = new Set<string>();
  for (const ref of definitionSkills) {
    const asset = byIdentity.get(`${ref.id}@${versionOf(ref.version)}`);
    if (asset === undefined) {
      throw makeError('WORKFLOW_CROSS_REFERENCE_UNKNOWN', {
        details: {
          workflowId: definitionId,
          version: versionOf(definitionVersion),
          refKind: 'skill',
          refId: ref.id,
          refVersion: versionOf(ref.version),
        },
      });
    }
    if (!seen.has(identityOf(asset))) {
      seen.add(identityOf(asset));
      referencedAssets.push(asset);
    }
  }

  const tierRank: Readonly<Record<SkillTrustTier, number>> = { global_core: 0, workflow: 1 };
  const ordered = [...referencedAssets].sort((a, b) => {
    const tier = tierRank[a.trustTier] - tierRank[b.trustTier];
    if (tier !== 0) return tier;
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    return versionOf(a.version).localeCompare(versionOf(b.version));
  });

  const sections: SkillBundleSection[] = ordered.map((asset) => ({
    kind: asset.trustTier === 'global_core' ? 'immutable_safety' : 'workflow',
    trustTier: asset.trustTier,
    provenance: {
      skillId: asset.id,
      version: versionOf(asset.version),
      trustTier: asset.trustTier,
      digest: asset.digest,
    },
    content: asset.content,
  }));

  const slotKinds: readonly RuntimeSlotKind[] = options.runtimeSlots ?? RUNTIME_SLOTS;
  const runtimeSlots: RuntimeSlotDeclaration[] = slotKinds.map((slot) => ({
    kind: 'runtime_slot',
    slot,
    trustTier: 'runtime',
    content: '',
  }));

  const bundleDigest = digestJson(bundleContent(sections, runtimeSlots));

  return {
    schemaVersion: 'skill-bundle/v1',
    definitionRef: { id: definitionId, version: versionOf(definitionVersion) },
    bundleDigest,
    sections,
    runtimeSlots,
    skillDigests: ordered.map((asset) => ({
      id: asset.id,
      version: versionOf(asset.version),
      trustTier: asset.trustTier,
      digest: asset.digest,
    })),
  };
}
