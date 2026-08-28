import { describe, expect, it } from 'vitest';
import '../errors.js';
import { WorkflowDefinitionRegistry, canonicalDigest } from '../definitions/registry.js';
import type { WorkflowDefinition } from '../definitions/contracts.js';
import { WorkflowRunOrchestrator, InMemoryRunStore } from './run-orchestrator.js';
import { resolveRunEdge, resolveStepEdge } from './fsm.js';

function def(id = 'issue_fix', version = '1.0.0'): WorkflowDefinition {
  const base: Omit<WorkflowDefinition, 'digest'> = {
    id,
    semanticVersion: version,
    status: 'DISCOVERED',
    enabled: true,
    agentDefinitionId: 'ad-1',
    inputSchemaId: 'in-1',
    outputSchemaId: 'out-1',
    steps: [
      {
        id: 's-plan',
        kind: 'turn',
        actionTypes: ['action:plan'],
        maxRetries: 1,
        maxWallMillis: 60_000,
        failureBehavior: 'fail_run',
        validatorIds: ['v-plan'],
      },
      {
        id: 's-edit',
        kind: 'turn',
        actionTypes: ['action:edit'],
        maxRetries: 2,
        maxWallMillis: 60_000,
        failureBehavior: 'repair_turn',
        validatorIds: ['v-diff'],
      },
    ],
    allowedActionTypes: ['action:plan', 'action:edit'],
    requiredCapabilities: ['cap:trueforge_agent'],
    artifactDeclarations: ['patch'],
    skillBundleRefs: ['skill:core@1'],
    compatibilityRange: '>=1.0.0',
  };
  return { ...base, digest: canonicalDigest(base) };
}

const KNOWN = {
  actionTypes: new Set(['action:plan', 'action:edit']),
  capabilities: new Set(['cap:trueforge_agent']),
  validators: new Set(['v-plan', 'v-diff']),
};

const WS = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';

describe('C045 registry', () => {
  const registry = new WorkflowDefinitionRegistry({
    known: KNOWN,
    clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
  });

  it('registers immutable versions, rejects conflicting digest for same version', () => {
    expect(registry.register(def()).ok).toBe(true);
    expect(registry.register(def()).ok).toBe(true); // same identity no-op
    const conflictDef = { ...def(), steps: [def().steps[0]] };
    conflictDef.digest = canonicalDigest(conflictDef);
    const conflict = registry.register(conflictDef);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('WORKFLOW_VERSION_IMMUTABLE');
  });

  it('fails closed on unknown action/validator/capability references', () => {
    const registry2 = new WorkflowDefinitionRegistry({
      known: KNOWN,
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    });
    const badAction = {
      ...def('bad_action', '1.0.0'),
      steps: [{ ...def().steps[0], actionTypes: ['action:UNKNOWN'] }],
    };
    badAction.digest = canonicalDigest(badAction);
    const r1 = registry2.register(badAction);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('UNKNOWN_REFERENCE');
    const badCap = { ...def('bad_cap', '1.0.0'), requiredCapabilities: ['cap:UNKNOWN'] };
    badCap.digest = canonicalDigest(badCap);
    const r2 = registry2.register(badCap);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('UNKNOWN_REFERENCE');
    void badAction;
    void badCap;
  });

  it('resolves, snapshots, and lists the catalog', () => {
    registry.register(def('resolve_me', '2.1.0'));
    const resolved = registry.resolve('resolve_me', '2.1.0');
    expect(resolved.semanticVersion).toBe('2.1.0');
    expect(() => registry.resolve('nope', '1.0.0')).toThrow();
    const snap = registry.snapshot('resolve_me', '2.1.0');
    expect(snap.normalizedJsonDigest).toMatch(/^[0-9a-f]{64}$/);
    const catalog = registry.list();
    expect(catalog.some((c) => c.id === 'resolve_me')).toBe(true);
  });
});

describe('C046 run orchestration', () => {
  it('run/step FSMs follow the happy path', () => {
    expect(resolveRunEdge('PENDING', 'begin').allowed).toBe(true);
    expect(resolveRunEdge('PROVISIONING', 'provisioned').allowed).toBe(true);
    expect(resolveRunEdge('RUNNING', 'await_approval').allowed).toBe(true);
    expect(resolveRunEdge('WAITING_APPROVAL', 'approval_resolved').allowed).toBe(true);
    expect(resolveRunEdge('RUNNING', 'succeed').allowed).toBe(true);
    expect(resolveRunEdge('SUCCEEDED', 'fail').allowed).toBe(false);
    expect(resolveStepEdge('PENDING', 'begin').allowed).toBe(true);
    expect(resolveStepEdge('PROVISIONING', 'provisioned').allowed).toBe(true);
    expect(resolveStepEdge('RUNNING', 'succeed').allowed).toBe(true);
  });

  it('launches idempotently and advances steps', async () => {
    const registry = new WorkflowDefinitionRegistry({
      known: KNOWN,
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    });
    registry.register(def());
    const store = new InMemoryRunStore();
    const orch = new WorkflowRunOrchestrator({
      store,
      resolveDefinition: (id, v) => registry.resolve(id, v),
      snapshotDefinition: (id, v) => registry.snapshot(id, v),
      clock: { nowIso: () => '2026-08-28T00:00:00.000Z' },
    });
    const input = {
      workflowRunId: WS,
      repositoryId: 'repo-1',
      workflowDefinitionId: 'issue_fix',
      definitionVersion: '1.0.0',
      idempotencyKey: 'launch-1',
    };
    const first = await orch.launch(input);
    expect(first.run.state).toBe('PENDING');
    const replay = await orch.launch(input);
    expect(replay.replayed).toBe(true);
    const running = await orch.transitionRun(first.run.id, 'begin');
    expect(running.state).toBe('PROVISIONING');
    const step = await orch.transitionStep(first.run.id, 0, 'begin');
    expect(step.steps[0].state).toBe('PROVISIONING');
    await expect(orch.transitionRun(first.run.id, 'succeed')).rejects.toThrow(); // not RUNNING
  });
});
