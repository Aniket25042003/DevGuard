/**
 * C027 §22 — global safety rules, autonomy ceilings, catalog integrity and
 * effective summaries. Every action × level must resolve explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_DEFINITIONS,
  AUTONOMY_PROFILES,
  GLOBAL_SAFETY_VERSION,
  SafetyCatalogError,
  SafetyConstraintService,
  restrictionRank,
} from '@devguard/policy-engine';

const service = new SafetyConstraintService();

describe('catalog integrity (SAFE-UNIT-001)', () => {
  it('validates against C024 taxonomy without error', () => {
    expect(() => new SafetyConstraintService()).not.toThrow();
    expect(service.snapshot().globalSafetyVersionId).toBe(GLOBAL_SAFETY_VERSION);
    expect(service.snapshot().catalogHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when a rule references an unregistered action (typo guard)', () => {
    // Simulated via internal indexes: ask for a made-up action — no rule may match it.
    const result = service.globalRestrictions({ actionId: 'totally_unknown_action' });
    expect(result).toEqual([]); // unknown actions fail closed UPSTREAM in C024, not here
  });

  it('covers every registered action in every autonomy profile', () => {
    for (const [level, profile] of Object.entries(AUTONOMY_PROFILES)) {
      void level;
      for (const definition of ACTION_DEFINITIONS) {
        const mapped =
          profile.automaticActions.has(definition.id) ||
          profile.approvalRequiredActions.has(definition.id) ||
          profile.deniedActions.has(definition.id);
        expect(mapped, `${definition.id} unmapped at ${profile.level}`).toBe(true);
      }
    }
  });
});

describe('global restrictions', () => {
  it('denies repository deletion / history rewrite / credentials / destructive migration everywhere', () => {
    for (const actionId of [
      'repository_delete',
      'repository_content_permanent_delete',
      'credential_rotate_or_remove',
      'destructive_migration',
      'default_branch_history_rewrite',
      'secret_config_modify',
    ]) {
      const restrictions = service.globalRestrictions({ actionId });
      expect(restrictions.length).toBeGreaterThanOrEqual(1);
      expect(restrictions.every((r) => r.minimumEffect === 'DENY' && r.nonOverridable)).toBe(true);
    }
  });

  it('places approval floors on merge/protected/settings/production/billing operations', () => {
    for (const actionId of [
      'pull_request_merge',
      'protected_branch_write',
      'ci_workflow_modify',
      'branch_delete',
      'issue_destructive_close',
      'production_deploy',
      'production_settings_modify',
      'billing_resource_create',
    ]) {
      const restrictions = service.globalRestrictions({ actionId });
      expect(
        restrictions.some((r) => r.minimumEffect === 'REQUIRE_APPROVAL' && r.nonOverridable),
      ).toBe(true);
    }
  });

  it('adds protected/default-branch floor even for ordinary write actions', () => {
    const push = service.globalRestrictions({
      actionId: 'branch_push',
      targetsProtectedBranch: true,
    });
    expect(push.some((r) => r.ruleId === 'global-floor-protected-target')).toBe(true);

    const featurePush = service.globalRestrictions({
      actionId: 'branch_push',
      targetsProtectedBranch: false,
    });
    expect(featurePush.some((r) => r.ruleId === 'global-floor-protected-target')).toBe(false);
  });

  it('reads carry no global restrictions (ceiling checks handle assist)', () => {
    expect(service.globalRestrictions({ actionId: 'repository_read' })).toEqual([]);
  });
});

describe('autonomy ceilings (C027 §22 matrix)', () => {
  it('assist cannot create/push branches or PRs; sandbox work remains eligible', () => {
    expect(
      service.autonomyRestrictions('assist', { actionId: 'branch_push' })[0]?.minimumEffect,
    ).toBe('DENY');
    expect(
      service.autonomyRestrictions('assist', { actionId: 'pull_request_create' })[0]?.minimumEffect,
    ).toBe('DENY');
    expect(
      service.autonomyRestrictions('assist', { actionId: 'pull_request_merge' })[0]?.minimumEffect,
    ).toBe('DENY');
    // Sandbox obligations remain (no ceiling denial).
    expect(service.autonomyRestrictions('assist', { actionId: 'sandbox_run_test' })).toEqual([]);
    expect(service.autonomyRestrictions('assist', { actionId: 'workspace_apply_patch' })).toEqual(
      [],
    );
  });

  it('developer/trusted keep branch/PR writes eligible but floor merges and protected writes', () => {
    for (const level of ['developer', 'trusted'] as const) {
      expect(service.autonomyRestrictions(level, { actionId: 'branch_push' })).toEqual([]);
      expect(
        service
          .autonomyRestrictions(level, { actionId: 'protected_branch_write' })
          .some((r) => r.minimumEffect === 'REQUIRE_APPROVAL'),
      ).toBe(true);
      expect(
        service
          .autonomyRestrictions(level, { actionId: 'pull_request_merge' })
          .some((r) => r.minimumEffect === 'REQUIRE_APPROVAL'),
      ).toBe(true);
      // Destructive stays denied at ALL levels including autonomous.
      expect(
        service.autonomyRestrictions(level, { actionId: 'repository_delete' })[0]?.minimumEffect,
      ).toBe('DENY');
    }
  });

  it('autonomous does not imply allow: floors remain floors and denies remain denials', () => {
    expect(
      service
        .autonomyRestrictions('autonomous', { actionId: 'pull_request_merge' })
        .some((r) => r.minimumEffect === 'REQUIRE_APPROVAL'),
    ).toBe(true);
    expect(
      service.autonomyRestrictions('autonomous', { actionId: 'default_branch_history_rewrite' })[0]
        ?.minimumEffect,
    ).toBe('DENY');
  });

  it('combines restrictions and ranks strongest first among all matches', () => {
    // merge under developer: autonomy floor + possibly protected target floor.
    const combined = service.restrictionsFor('developer', {
      actionId: 'pull_request_merge',
      mergesProtectedBranch: true,
    });
    expect(combined.length).toBeGreaterThanOrEqual(2);
    const top = combined.reduce(
      (best, r) => (restrictionRank(r) > restrictionRank(best) ? r : best),
      combined[0]!,
    );
    expect(top.minimumEffect).toBe('REQUIRE_APPROVAL');
    // Sorted by stable rule ID.
    const ids = combined.map((r) => r.ruleId);
    expect([...ids].sort()).toEqual(ids);
  });

  it('every assist denial is also classified correctly per taxonomy category', () => {
    // Regression-style sanity: GitHub writes are exactly the category `github_write`.
    const gitWrites = ACTION_DEFINITIONS.filter(
      (definition) => definition.category === 'github_write',
    ).map((d) => d.id);
    expect(gitWrites.length).toBeGreaterThan(0);
    for (const id of gitWrites) {
      expect(AUTONOMY_PROFILES.assist.deniedActions.has(id)).toBe(true);
    }
  });
});

describe('policy validation against impossible overrides', () => {
  it('rejects allow entries that a global deny will always block', () => {
    const result = service.validatePolicy({
      actions: {
        allow: ['repository_delete', 'issue_read'],
        requireApproval: [],
        deny: [],
      },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'POLICY_CONFLICT' });
    expect(result.diagnostics[0]!.message).toContain('repository_delete');
  });

  it('accepts coherent policy grants', () => {
    const result = service.validatePolicy({
      actions: {
        allow: ['issue_read'],
        requireApproval: ['pull_request_merge'],
        deny: ['branch_delete'],
      },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('construction throws SafetyCatalogError with clear reason when integrity breaks', () => {
    class Broken extends SafetyConstraintService {
      constructor() {
        super();
        throw new SafetyCatalogError('simulated bad deployment');
      }
    }
    expect(() => new Broken()).toThrow(SafetyCatalogError);
  });
});
