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

export type SecurityPatchOutcome =
  | 'fixed'
  | 'not_fixed'
  | 'inconclusive'
  | 'superseded'
  | 'blocked';

/** Explicit terminal mapping; runtime adapters must not collapse these to failure. */
export const SECURITY_PATCH_OUTCOME_BY_CONDITION = Object.freeze({
  ineligible: 'blocked',
  scan_inadequate: 'inconclusive',
  finding_present: 'not_fixed',
  regression_failed: 'inconclusive',
  finding_absent: 'fixed',
  finding_superseded: 'superseded',
  publication_blocked: 'blocked',
} as const satisfies Readonly<Record<string, SecurityPatchOutcome>>);

export interface PatchStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
  readonly terminalOutcomes?: readonly SecurityPatchOutcome[];
}

export interface SecurityPatchCompletion {
  readonly outcome: SecurityPatchOutcome;
  readonly status: 'success' | 'partial' | 'blocked' | 'failed';
}

export function toSecurityPatchCompletion(outcome: SecurityPatchOutcome): SecurityPatchCompletion {
  return {
    outcome,
    status: outcome === 'fixed' || outcome === 'superseded' ? 'success' : outcome === 'blocked' ? 'blocked' : 'partial',
  };
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
    terminalOutcomes: ['blocked'],
  },
  {
    id: 'context',
    kind: 'turn',
    actionTypes: ['repository_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_context'],
  },
  {
    id: 'patch_plan',
    kind: 'turn',
    actionTypes: ['repository_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_patch_plan'],
  },
  {
    id: 'branch',
    kind: 'command',
    actionTypes: ['branch_create'],
    maxRetries: 2,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'patch',
    kind: 'turn',
    actionTypes: ['workspace_apply_patch'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_diff_scope'],
  },
  {
    id: 'targeted_sec_regression',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_sec_regression'],
  },
  {
    id: 'functional_regressions',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_broad'],
  },
  {
    id: 'comparable_rescan',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
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
    failureBehavior: 'stop',
    validatorIds: ['v_finding_absent'],
    terminalOutcomes: ['fixed', 'not_fixed', 'superseded', 'inconclusive'],
  },
  {
    id: 'push_evidence',
    kind: 'published',
    actionTypes: ['commit_create', 'branch_push', 'pull_request_create'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
];

export const SECURITY_PATCH_ALLOWED_ACTIONS: readonly string[] = [
  'repository_read',
  'workspace_apply_patch',
  'sandbox_run_security_scan',
  'sandbox_run_test',
  'branch_create',
  'commit_create',
  'branch_push',
  'pull_request_create',
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
