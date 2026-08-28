import { describe, expect, it } from 'vitest';
import {
  REPOSITORY_HEALTH_STEPS,
  REPOSITORY_HEALTH_ALLOWED_ACTIONS,
  repositoryHealthDefinition,
  validateDefinition,
} from './repository-health.js';

const MUTATION_ACTIONS = [
  'branch_create',
  'commit_create',
  'branch_push',
  'pull_request_create',
  'pull_request_update',
  'pull_request_merge',
  'workspace_write_file',
  'workspace_apply_patch',
  'sandbox_install_dependency',
];

describe('C055 repository_health_check product workflow definition', () => {
  it('is an extension: advisory, bounded, and disabled by default', () => {
    expect(validateDefinition().ok).toBe(true);
    expect(repositoryHealthDefinition.enabled).toBe(false);
  });

  it('every step action is within the allowed-action ceiling', () => {
    const used = new Set(REPOSITORY_HEALTH_STEPS.flatMap((s) => s.actionTypes));
    for (const action of used) expect(REPOSITORY_HEALTH_ALLOWED_ACTIONS).toContain(action);
  });

  it('is non-mutating: no source/Git write action is ever allowed', () => {
    for (const action of MUTATION_ACTIONS)
      expect(REPOSITORY_HEALTH_ALLOWED_ACTIONS).not.toContain(action);
    // The report terminal step must not touch GitHub.
    expect(REPOSITORY_HEALTH_ALLOWED_ACTIONS).not.toContain('commit_create');
    expect(REPOSITORY_HEALTH_ALLOWED_ACTIONS).not.toContain('pull_request_update');
  });

  it('preserves unknown/blocked domains and gates source immutability', () => {
    expect(
      REPOSITORY_HEALTH_STEPS.some((s) => s.validatorIds.includes('v_aggregate_unknown_preserved')),
    ).toBe(true);
    expect(REPOSITORY_HEALTH_STEPS.some((s) => s.validatorIds.includes('v_source_immutable'))).toBe(
      true,
    );
  });

  it('ships the expected extension definition shape', () => {
    expect(repositoryHealthDefinition.id).toBe('repository_health_check');
    expect(repositoryHealthDefinition.semanticVersion).toBe('1.0.0');
    expect(repositoryHealthDefinition.requiredCapabilities).not.toContain('cap:github_write');
    expect(repositoryHealthDefinition.allowedActionTypes).toEqual(
      REPOSITORY_HEALTH_ALLOWED_ACTIONS,
    );
  });
});
