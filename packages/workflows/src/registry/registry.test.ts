/**
 * C045 §22 — semver + registry unit tests.
 */
import { describe, expect, it } from 'vitest';
import { computeSkillAssetDigest, type SkillAssetShape } from '../schemas/skill-asset.js';
import { semverSchema, semverSatisfies } from '../schemas/semver.js';
import type { WorkflowDefinitionSourceInput } from '../schemas/workflow-definition.js';
import {
  createSchemaCatalog,
  type SchemaEntry,
  type ToolCatalogPort,
} from '../definitions/catalogs.js';
import { WorkflowRegistry, type RegistryBuildContext } from './registry.js';

describe('semver (C045 §23.3)', () => {
  it('parses a validated version string into a Semver object', () => {
    const value = semverSchema.parse('1.2.3');
    expect(value).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('rejects malformed versions at the boundary', () => {
    expect(() => semverSchema.parse('v1.2.3')).toThrow();
    expect(() => semverSchema.parse('1.2')).toThrow();
  });

  it('satisfies exact, caret and wildcard ranges', () => {
    expect(semverSatisfies('1.2.3', '1.2.3')).toBe(true);
    expect(semverSatisfies('1.9.0', '^1.2.3')).toBe(true);
    expect(semverSatisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(semverSatisfies('1.5.0', '1.x')).toBe(true);
  });

  it('never lets a prerelease satisfy a non-prerelease range', () => {
    expect(semverSatisfies('1.2.3-beta.1', '^1.2.3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const assetDigest = (asset: Omit<SkillAssetShape, 'digest'>): string =>
  computeSkillAssetDigest(asset);

function skillAsset(
  id: string,
  version: string,
  trustTier: SkillAssetShape['trustTier'],
): SkillAssetShape {
  const content: Omit<SkillAssetShape, 'digest'> = {
    schemaVersion: 'skill-asset/v1',
    id,
    version: semverSchema.parse(version),
    trustTier,
    mediaType: 'text/markdown',
    content: '# guardrails\nFollow the operating rules.',
    requiredContextVariables: [],
    prohibitedMutableFields: [],
    source: { path: `skills/${id}.md` },
  };
  return { ...content, digest: assetDigest(content) };
}

function makeDefinition(
  id: 'implement_issue' | 'diagnose_failure' = 'implement_issue',
): WorkflowDefinitionSourceInput {
  return {
    schemaVersion: 'workflow-definition/v1',
    id,
    name: 'Implement Issue',
    description: 'Turn an issue into a validated, approved merge.',
    version: '1.0.0',
    inputSchema: { id: 'issue-input', version: '1.0.0' },
    outputSchema: { id: 'issue-output', version: '1.0.0' },
    allowedActions: [],
    validators: [],
    tools: [],
    skills: [{ id: 'core.safety', version: '1.0.0' }],
    capabilities: [],
    steps: [
      {
        id: 'plan',
        name: 'Plan',
        attempts: { max: 3 },
        timeoutMs: 60_000,
        onFailure: 'abort',
      },
    ],
    completion: {
      requiredValidators: [],
      evidence: { required: true, artifactKinds: ['report'] },
      conditions: [{ kind: 'all_steps_succeeded' }],
    },
    failure: { conditions: [{ kind: 'step_failed', steps: ['plan'] }] },
    compatibility: [],
  };
}

function schemaEntry(id: string, version: string): SchemaEntry {
  return {
    id,
    version,
    digest: 'a'.repeat(64),
    schema: { parse: (value: unknown) => value } as never,
  };
}

function toolCatalog(): ToolCatalogPort {
  return { getTool: () => undefined };
}

function makeRegistry(): {
  registry: WorkflowRegistry;
  assets: ReadonlyMap<string, SkillAssetShape>;
} {
  const assets = new Map<string, SkillAssetShape>();
  assets.set('core.safety@1.0.0', skillAsset('core.safety', '1.0.0', 'global_core'));
  const context: RegistryBuildContext = {
    schemaCatalog: createSchemaCatalog([
      schemaEntry('issue-input', '1.0.0'),
      schemaEntry('issue-output', '1.0.0'),
    ]),
    toolCatalog: toolCatalog(),
    skillAssets: assets,
    registryGeneration: 1,
  };
  return { registry: new WorkflowRegistry(context), assets };
}

describe('WorkflowRegistry (C045 §9/§12)', () => {
  it('registers a valid definition into an immutable active snapshot', async () => {
    const { registry } = makeRegistry();
    const outcome = await registry.register(makeDefinition());
    expect(outcome.outcome).toBe('registered');
    if (outcome.outcome !== 'registered') return;
    expect(outcome.snapshot.definition.status).toBe('active');
    expect(outcome.snapshot.workflow.version).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('blocks a definition with structural issues (fail closed)', async () => {
    const { registry } = makeRegistry();
    const bad = makeDefinition();
    const outcome = await registry.register({ ...bad, skills: [] });
    expect(outcome.outcome).toBe('blocked');
  });

  it('rejects an immutable re-registration with conflicting content', async () => {
    const { registry } = makeRegistry();
    await registry.register(makeDefinition());
    const conflicting = makeDefinition();
    conflicting.name = 'Changed Name';
    await expect(registry.register(conflicting)).rejects.toThrowError(/immutable/);
  });

  it('tracks the current (active) snapshot per definition id', async () => {
    const { registry } = makeRegistry();
    await registry.register(makeDefinition());
    const current = registry.current('implement_issue');
    expect(current?.workflow.id).toBe('implement_issue');
    expect(registry.current('security_audit')).toBeUndefined();
  });
});
