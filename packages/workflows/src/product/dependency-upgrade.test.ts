import { describe, expect, it } from 'vitest';
import { workflowDefinitionSchema } from '../definitions/contracts.js';
import { canonicalDigest } from '../definitions/registry.js';
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

  it('is a registrable build asset (schema-complete with an honest canonical digest)', () => {
    const parsed = workflowDefinitionSchema.safeParse(dependencyUpgradeDefinition);
    expect(parsed.success).toBe(true);
    expect(dependencyUpgradeDefinition.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(dependencyUpgradeDefinition.digest).toBe(canonicalDigest(dependencyUpgradeDefinition));
    expect(dependencyUpgradeDefinition.inputSchemaId).toBeTruthy();
    expect(dependencyUpgradeDefinition.outputSchemaId).toBeTruthy();
    expect(dependencyUpgradeDefinition.agentDefinitionId).toBeTruthy();
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(DEPENDENCY_UPGRADE_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(DEPENDENCY_UPGRADE_ALLOWED_ACTIONS).toContain(action);
  });

  it('enforces the candidate budget via the install repair-step retry ceiling', () => {
    const install = DEPENDENCY_UPGRADE_STEPS.find((s) =>
      s.actionTypes.includes('sandbox_install_dependency'),
    );
    expect(install).toBeDefined();
    expect(install?.failureBehavior).toBe('repair_turn');
    expect(install?.maxRetries).toBe(DEPENDENCY_UPGRADE_CANDIDATE_BUDGET);
  });

  it('gates every git-write publish step on ownership + evidence freshness', () => {
    const publish = DEPENDENCY_UPGRADE_STEPS.find((s) => s.id === 'publish');
    expect(publish?.validatorIds).toEqual(
      expect.arrayContaining(['v_branch_owned', 'v_evidence_current']),
    );
    expect(DEPENDENCY_UPGRADE_ALLOWED_ACTIONS).not.toContain('pull_request_merge');
  });

  it('installs contained and re-scans for remediation before publish', () => {
    const kinds = DEPENDENCY_UPGRADE_STEPS.map((s) => s.kind);
    const firstPublish = kinds.indexOf('published');
    expect(kinds.slice(0, firstPublish).includes('command')).toBe(true);
    const rescanIndex = DEPENDENCY_UPGRADE_STEPS.findIndex((s) =>
      s.validatorIds.includes('v_rescan_comparable'),
    );
    expect(rescanIndex).toBeGreaterThan(
      DEPENDENCY_UPGRADE_STEPS.findIndex((s) =>
        s.actionTypes.includes('sandbox_install_dependency'),
      ),
    );
  });
});
