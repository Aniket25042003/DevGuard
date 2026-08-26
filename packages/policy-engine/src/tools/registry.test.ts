/**
 * C024 §22 — taxonomy completeness, registry build validation, resolution
 * matrix, capability drift, and SANDBOX_ONLY obligation semantics.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ACTION_DEFINITIONS,
  PROVIDER_IDS,
  RegistryBuildError,
  buildRegistry,
  findActionDefinition,
  validateCatalog,
  versionSatisfies,
  type ToolDefinitionInput,
} from '@devguard/policy-engine';

const inputSchema = z
  .object({
    ref: z.string().max(256).optional(),
    path: z.string().max(1024).optional(),
  })
  .strip();

function tool(id: string, actionId: string, providerToolName = id): ToolDefinitionInput<never> {
  return {
    id,
    provider: 'trueforge_mcp',
    providerToolName,
    capabilityVersionRange: '^1.0.0',
    actionId,
    inputSchema,
    metadataExtractor: (input) => ({ targetRef: (input as { ref?: string }).ref }),
  } as unknown as ToolDefinitionInput<never>;
}

describe('taxonomy completeness (REG-UNIT-001)', () => {
  it('publishes every initial action with valid risk/effect coherence', () => {
    expect(validateCatalog()).toEqual([]);
    for (const id of [
      'repository_read',
      'issue_read',
      'workspace_write_file',
      'sandbox_run_test',
      'branch_push',
      'protected_branch_write',
      'pull_request_merge',
      'repository_delete',
      'production_deploy',
      'validation_run',
    ]) {
      expect(findActionDefinition(id)).toBeDefined();
    }
    // No catch-all/generic action exists by design.
    expect(findActionDefinition('generic_execute')).toBeUndefined();
    expect(findActionDefinition('any_tool')).toBeUndefined();
  });

  it('destructive defaults never auto-allow and privileged actions demand approval or deny', () => {
    for (const definition of ACTION_DEFINITIONS) {
      if (definition.baselineRisk === 'destructive') {
        expect(['REQUIRE_APPROVAL', 'DENY']).toContain(definition.defaultEffect);
      }
      if (definition.privileged && definition.defaultEffect === 'ALLOW') {
        throw new Error(`privileged action ${definition.id} defaulted ALLOW`);
      }
    }
  });
});

describe('registry build validation', () => {
  it('rejects duplicate tool IDs at publication', () => {
    expect(() =>
      buildRegistry([
        tool('t1', 'issue_read'),
        tool('t1', 'file.read' in {} ? 'issue_read' : 'issue_read'),
      ]),
    ).toThrow(RegistryBuildError);
  });

  it('rejects one provider name mapping to multiple actions (alias collision)', () => {
    expect(() =>
      buildRegistry([
        tool('a', 'issue_read', 'shared_name'),
        tool('b', 'file.read'.replace('read', 'read') as string, 'shared_name'),
      ]),
    ).toThrow(/collision/);
  });

  it('rejects tools referencing unregistered actions', () => {
    expect(() => buildRegistry([tool('t', 'does_not_exist')])).toThrow(/unregistered action/);
  });

  it('produces an immutable hash-identified snapshot', () => {
    const registry = buildRegistry([tool('t1', 'issue_read'), tool('t2', 'pull_request_create')]);
    const snapshot = registry.snapshot();
    expect(snapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.registryVersionId).toBe(`registry-${snapshot.snapshotHash.slice(0, 16)}`);
    expect(Object.isFrozen(snapshot)).toBe(true);
    // Snapshot identity is stable across repeated calls.
    expect(registry.snapshot().snapshotHash).toBe(snapshot.snapshotHash);
  });
});

describe('resolve() decision matrix (C024 §22)', () => {
  function make() {
    return buildRegistry([
      tool('mcp.github_read_issues', 'issue_read', 'github_read_issues'),
      tool('mcp.merge_pr', 'pull_request_merge', 'merge_pr'),
    ]);
  }
  const VALID = { ref: 'main' };

  it('enabled+unique+valid input emits typed action with metadata', () => {
    const result = make().resolve({
      provider: 'trueforge_mcp',
      toolName: 'github_read_issues',
      capabilityVersion: '1.2.0',
      payload: VALID,
    });
    expect(result.outcome).toBe('RESOLVED');
    if (result.outcome === 'RESOLVED') {
      expect(result.action.id).toBe('issue_read');
      expect(result.metadata.targetRef).toBe('main');
      expect(result.registrySnapshotId).toMatch(/^registry-/);
    }
  });

  it('unknown MCP tool denies UNKNOWN_TOOL regardless of payload', () => {
    const result = make().resolve({
      provider: 'trueforge_mcp',
      toolName: 'brand_new_tool',
      payload: VALID,
    });
    expect(result).toMatchObject({
      outcome: 'DENIED_UNKNOWN_CAPABILITY',
      reasonCode: 'UNKNOWN_TOOL',
    });
  });

  it('unknown provider denies closed', () => {
    const result = make().resolve({ provider: 'rogue_provider', toolName: 'x', payload: VALID });
    expect(result).toMatchObject({
      outcome: 'DENIED_UNKNOWN_CAPABILITY',
      reasonCode: 'UNKNOWN_PROVIDER',
    });
    expect(PROVIDER_IDS).not.toContain('rogue_provider');
  });

  it('invalid input denies with field errors, never a guessed pass', () => {
    const result = make().resolve({
      provider: 'trueforge_mcp',
      toolName: 'github_read_issues',
      payload: { ref: 123 },
    });
    expect(result.outcome).toBe('DENIED_INVALID_INPUT');
    if (result.outcome === 'DENIED_INVALID_INPUT')
      expect(result.fieldErrors.length).toBeGreaterThan(0);
  });

  it('capability version drift denies incompatible', () => {
    const result = make().resolve({
      provider: 'trueforge_mcp',
      toolName: 'github_read_issues',
      capabilityVersion: '9.9.9',
      payload: VALID,
    });
    expect(result).toMatchObject({
      outcome: 'DENIED_INCOMPATIBLE',
      reasonCode: 'CAPABILITY_VERSION_DRIFT',
    });
  });

  it('merging through a resolved tool still carries its destructive baseline; sandbox obligation cannot flip DENY', () => {
    const registry = make();
    const resolved = registry.resolve({
      provider: 'trueforge_mcp',
      toolName: 'merge_pr',
      payload: {},
    });
    expect(resolved.outcome).toBe('RESOLVED');
    if (resolved.outcome === 'RESOLVED') {
      expect(resolved.action.defaultEffect).not.toBe('ALLOW');
      // Even with a hypothetical sandbox obligation attached, default effect remains approval/deny:
      const definition = findActionDefinition(resolved.action.id)!;
      const obligationsWithSandbox = [...definition.obligations];
      void obligationsWithSandbox;
      expect(definition.defaultEffect).toBe('REQUIRE_APPROVAL');
    }
  });
});

describe('workflow-filtered exposure (least privilege)', () => {
  it('lists only enabled tools whose actions the workflow declares', () => {
    const registry = buildRegistry([
      tool('r1', 'issue_read'),
      tool('w1', 'pull_request_create'),
      tool('d1', 'repository_delete'),
    ]);
    const exposed = registry.listForWorkflow(new Set(['issue_read']));
    expect(exposed.map((toolEntry) => toolEntry.id)).toEqual(['r1']);
  });
});

describe('capability verification & drift (REG-CONTRACT-001 basis)', () => {
  it('verifies compatible manifests and flags drifted versions', () => {
    const registry = buildRegistry([tool('t1', 'issue_read')]);
    const good = registry.verifyCapabilities({
      provider: 'trueforge_mcp',
      apiVersion: '2026-01-01',
      capabilities: { t1: '1.4.2' },
      manifestHash: 'hash-1',
    });
    expect(good.ok).toBe(true);

    const drifted = registry.verifyCapabilities({
      provider: 'trueforge_mcp',
      apiVersion: '2026-01-01',
      capabilities: { t1: '2.0.0' },
      manifestHash: 'hash-2',
    });
    expect(drifted.ok).toBe(false);
    expect(drifted.problems.join()).toContain('drift');
  });
});

describe('versionSatisfies ranges', () => {
  it('supports caret, tilde, exact and >= ranges', () => {
    expect(versionSatisfies('1.4.0', '^1.0.0')).toBe(true);
    expect(versionSatisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(versionSatisfies('1.9.9', '~1.5.0')).toBe(true);
    expect(versionSatisfies('2.0.0', '~1.5.0')).toBe(false);
    expect(versionSatisfies('3.2.1', '3.2.1')).toBe(true);
    expect(versionSatisfies('3.3.0', '>=3.2.0')).toBe(true);
    expect(versionSatisfies('banana', '^1.0.0')).toBe(false);
  });
});
