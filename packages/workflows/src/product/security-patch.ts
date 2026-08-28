/**
 * C052 — `security_patch` product workflow definition.
 *
 * Remediate an eligible, evidence-backed security finding in an isolated
 * workflow-owned branch and prove — via targeted regression + a comparable
 * re-scan with adequate coverage — that the original stable finding identity is
 * ABSENT. The workflow never marks a finding fixed because the model, diff, or
 * generic test suite merely says so. Outcomes: fixed/not_fixed/inconclusive/
 * superseded/blocked. Merge stays outside this workflow.
 */
export const SECURITY_PATCH_DEFINITION_ID = 'security_patch';
export const SECURITY_PATCH_DEFINITION_VERSION = '1.0.0';

export interface PatchStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const SECURITY_PATCH_STEPS: readonly PatchStep[] = [
  {
    id: 'eligibility',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_finding_eligibility'],
  },
  {
    id: 'context',
    kind: 'turn',
    actionTypes: ['action:repo_map'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_context'],
  },
  {
    id: 'patch_plan',
    kind: 'turn',
    actionTypes: ['action:plan'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_patch_plan'],
  },
  {
    id: 'branch',
    kind: 'command',
    actionTypes: ['action:create_branch'],
    maxRetries: 2,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'patch',
    kind: 'turn',
    actionTypes: ['action:edit_patch'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_diff_scope'],
  },
  {
    id: 'targeted_sec_regression',
    kind: 'command',
    actionTypes: ['action:sandbox_scan'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_sec_regression'],
  },
  {
    id: 'functional_regressions',
    kind: 'command',
    actionTypes: ['action:sandbox_test'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_broad'],
  },
  {
    id: 'comparable_rescan',
    kind: 'command',
    actionTypes: ['action:sandbox_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_rescan_coverage'],
  },
  {
    id: 'finding_identity_compare',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_finding_absent'],
  },
  {
    id: 'push_evidence',
    kind: 'published',
    actionTypes: ['action:commit', 'action:push_branch', 'action:create_pr'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
];

export const SECURITY_PATCH_ALLOWED_ACTIONS: readonly string[] = [
  'action:repo_map',
  'action:plan',
  'action:create_branch',
  'action:edit_patch',
  'action:sandbox_scan',
  'action:sandbox_test',
  'action:commit',
  'action:push_branch',
  'action:create_pr',
];

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

export function validateDefinition(): DefinitionValidation {
  if (SECURITY_PATCH_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of SECURITY_PATCH_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes)
      if (!SECURITY_PATCH_ALLOWED_ACTIONS.includes(action))
        return { ok: false, violation: `unallowed action ${action}` };
  }
  // Must prove absence via a comparable re-scan + finding-identity comparison.
  if (!SECURITY_PATCH_STEPS.some((s) => s.validatorIds.includes('v_rescan_coverage')))
    return { ok: false, violation: 'comparable re-scan required' };
  if (!SECURITY_PATCH_STEPS.some((s) => s.validatorIds.includes('v_finding_absent')))
    return { ok: false, violation: 'finding-absence proof required' };
  // Merge is outside this workflow.
  if (SECURITY_PATCH_ALLOWED_ACTIONS.includes('action:merge_pr'))
    return { ok: false, violation: 'merge not allowed' };
  return { ok: true };
}

export const securityPatchDefinition = {
  id: SECURITY_PATCH_DEFINITION_ID,
  semanticVersion: SECURITY_PATCH_DEFINITION_VERSION,
  status: 'ACTIVE',
  enabled: true,
  steps: SECURITY_PATCH_STEPS,
  allowedActionTypes: SECURITY_PATCH_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:sandbox_exec', 'cap:github_write'],
  artifactDeclarations: ['patch', 'sec_regression', 'rescan_evidence'],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;
