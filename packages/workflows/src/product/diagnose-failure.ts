/**
 * C050 — `diagnose_failure` product workflow definition.
 *
 * Diagnose a GitHub check/CI run/PR failure or user-described repository
 * failure: resolve a canonical failure target and snapshot its head/base/check
 * state; build compact repository/changed-code context; create and validate a
 * reproduction recipe (run only in the restricted TrueForge sandbox; record why
 * reproduction is blocked/divergent); rank evidence-backed hypotheses; apply a
 * bounded repair only when authorized; then focused rerun -> policy regressions
 * -> security validation, updating the owned branch/PR with current-head
 * evidence and branch ownership. No blind reruns, unbounded fix loops, force
 * pushes, or production debugging.
 */
export const DIAGNOSE_FAILURE_DEFINITION_ID = 'diagnose_failure';
export const DIAGNOSE_FAILURE_DEFINITION_VERSION = '1.0.0';

export interface FailureStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const DIAGNOSE_FAILURE_STEPS: readonly FailureStep[] = [
  {
    id: 'resolve_target',
    kind: 'turn',
    actionTypes: ['action:pr_read', 'action:run_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_target'],
  },
  {
    id: 'snapshot',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_snapshot'],
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
    id: 'recipe',
    kind: 'turn',
    actionTypes: ['action:sandbox_reproduce'],
    maxRetries: 1,
    maxWallMillis: 300_000,
    failureBehavior: 'stop',
    validatorIds: ['v_recipe'],
  },
  {
    id: 'hypotheses',
    kind: 'turn',
    actionTypes: ['action:root_cause'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_evidence'],
  },
  {
    id: 'repair',
    kind: 'turn',
    actionTypes: ['action:edit_patch'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_diff_scope'],
  },
  {
    id: 'focused_rerun',
    kind: 'command',
    actionTypes: ['action:sandbox_test'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_test_focused'],
  },
  {
    id: 'regressions',
    kind: 'command',
    actionTypes: ['action:sandbox_test'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_broad', 'v_sec_scan'],
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

export const DIAGNOSE_FAILURE_ALLOWED_ACTIONS: readonly string[] = [
  'action:pr_read',
  'action:run_read',
  'action:repo_map',
  'action:sandbox_reproduce',
  'action:root_cause',
  'action:edit_patch',
  'action:sandbox_test',
  'action:commit',
  'action:push_branch',
  'action:create_pr',
];

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

export function validateDefinition(): DefinitionValidation {
  if (DIAGNOSE_FAILURE_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of DIAGNOSE_FAILURE_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes)
      if (!DIAGNOSE_FAILURE_ALLOWED_ACTIONS.includes(action))
        return { ok: false, violation: `unallowed action ${action}` };
  }
  if (!DIAGNOSE_FAILURE_STEPS.some((s) => s.actionTypes.includes('action:sandbox_reproduce')))
    return { ok: false, violation: 'reproduction required' };
  return { ok: true };
}

export const diagnoseFailureDefinition = {
  id: DIAGNOSE_FAILURE_DEFINITION_ID,
  semanticVersion: DIAGNOSE_FAILURE_DEFINITION_VERSION,
  status: 'ACTIVE',
  enabled: true,
  steps: DIAGNOSE_FAILURE_STEPS,
  allowedActionTypes: DIAGNOSE_FAILURE_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:sandbox_exec', 'cap:github_write'],
  artifactDeclarations: ['reproduction', 'hypotheses', 'patch', 'test_evidence'],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;
