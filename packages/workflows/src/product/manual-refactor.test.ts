import { describe, expect, it } from 'vitest';
import {
  MANUAL_REFACTOR_STEPS,
  MANUAL_REFACTOR_ALLOWED_ACTIONS,
  MANUAL_REFACTOR_PLAN_BUDGET,
  MANUAL_REFACTOR_ALLOW_PUBLIC_API_CHANGE,
  manualRefactorDefinition,
  validateDefinition,
} from './manual-refactor.js';

const EXCLUDED = [
  'pull_request_merge',
  'pull_request_comment',
  'review_request',
  'sandbox_install_dependency',
  'sandbox_run_migration_simulation',
];

describe('C056 manual_refactor product workflow definition', () => {
  it('is an extension: manual, bounded, disabled by default, no public API change', () => {
    expect(validateDefinition().ok).toBe(true);
    expect(manualRefactorDefinition.enabled).toBe(false);
    expect(MANUAL_REFACTOR_ALLOW_PUBLIC_API_CHANGE).toBe(false);
    expect(MANUAL_REFACTOR_PLAN_BUDGET).toBeGreaterThan(0);
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(MANUAL_REFACTOR_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(MANUAL_REFACTOR_ALLOWED_ACTIONS).toContain(action);
  });

  it('excludes merge, review automation, and dependency/migration actions', () => {
    for (const action of EXCLUDED) expect(MANUAL_REFACTOR_ALLOWED_ACTIONS).not.toContain(action);
  });

  it('captures a baseline before modification and compares public contracts', () => {
    const baselineIndex = MANUAL_REFACTOR_STEPS.findIndex((s) =>
      s.validatorIds.includes('v_baseline_captured'),
    );
    const transformIndex = MANUAL_REFACTOR_STEPS.findIndex((s) => s.id === 'transform');
    expect(baselineIndex).toBeLessThan(transformIndex);
    expect(MANUAL_REFACTOR_STEPS.some((s) => s.validatorIds.includes('v_public_contract'))).toBe(
      true,
    );
    // Merge is not in the allowed set.
    expect(MANUAL_REFACTOR_ALLOWED_ACTIONS).not.toContain('pull_request_merge');
  });

  it('ships the expected extension definition shape', () => {
    expect(manualRefactorDefinition.id).toBe('manual_refactor');
    expect(manualRefactorDefinition.semanticVersion).toBe('1.0.0');
    expect(manualRefactorDefinition.allowedActionTypes).toEqual(MANUAL_REFACTOR_ALLOWED_ACTIONS);
  });
});
