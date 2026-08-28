import { describe, expect, it } from 'vitest';
import {
  DEPENDENCY_UPGRADE_STEPS,
  DEPENDENCY_UPGRADE_ALLOWED_ACTIONS,
  DEPENDENCY_UPGRADE_CANDIDATE_BUDGET,
  dependencyUpgradeDefinition,
  validateDefinition,
} from './dependency-upgrade.js';

describe('C053 dependency_upgrade product workflow definition', () => {
  it('is an extension: bounded, fail-closed, and disabled by default', () => {
    expect(validateDefinition().ok).toBe(true);
    expect(dependencyUpgradeDefinition.enabled).toBe(false);
    expect(DEPENDENCY_UPGRADE_CANDIDATE_BUDGET).toBeGreaterThan(0);
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(DEPENDENCY_UPGRADE_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(DEPENDENCY_UPGRADE_ALLOWED_ACTIONS).toContain(action);
  });

  it('installs contained, re-scans for remediation, and never merges', () => {
    const kinds = DEPENDENCY_UPGRADE_STEPS.map((s) => s.kind);
    const firstPublish = kinds.indexOf('published');
    expect(kinds.slice(0, firstPublish).includes('command')).toBe(true); // install before publish
    expect(DEPENDENCY_UPGRADE_ALLOWED_ACTIONS).not.toContain('pull_request_merge');
    // A version bump alone must not close the loop: a comparable re-scan follows install.
    const rescanIndex = DEPENDENCY_UPGRADE_STEPS.findIndex((s) =>
      s.validatorIds.includes('v_rescan_comparable'),
    );
    expect(rescanIndex).toBeGreaterThan(
      DEPENDENCY_UPGRADE_STEPS.findIndex((s) =>
        s.actionTypes.includes('sandbox_install_dependency'),
      ),
    );
  });

  it('ships the expected extension definition shape', () => {
    expect(dependencyUpgradeDefinition.id).toBe('dependency_upgrade');
    expect(dependencyUpgradeDefinition.semanticVersion).toBe('1.0.0');
    expect(dependencyUpgradeDefinition.allowedActionTypes).toEqual(
      DEPENDENCY_UPGRADE_ALLOWED_ACTIONS,
    );
  });
});
