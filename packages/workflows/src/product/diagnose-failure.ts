import { findActionDefinition } from '@devguard/policy-engine';

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
    actionTypes: ['pull_request_read', 'workflow_logs_read'],
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
    actionTypes: ['repository_read', 'tree_list'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_context'],
  },
  {
    id: 'recipe',
    kind: 'turn',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 1,
    maxWallMillis: 300_000,
    failureBehavior: 'stop',
    validatorIds: ['v_recipe'],
  },
  {
    id: 'hypotheses',
    kind: 'turn',
    actionTypes: ['workflow_logs_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_evidence'],
  },
  {
    id: 'repair',
    kind: 'turn',
    actionTypes: ['workspace_apply_patch'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_diff_scope'],
  },
  {
    id: 'focused_rerun',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_test_focused'],
  },
  {
    id: 'regressions',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_broad', 'v_sec_scan'],
  },
  {
    id: 'push_evidence',
    kind: 'published',
    actionTypes: ['commit_create', 'branch_push', 'pull_request_create'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_current_head_evidence', 'v_branch_ownership'],
  },
];

export const DIAGNOSE_FAILURE_ALLOWED_ACTIONS: readonly string[] = [
  'pull_request_read',
  'workflow_logs_read',
  'repository_read',
  'tree_list',
  'sandbox_run_test',
  'workspace_apply_patch',
  'commit_create',
  'branch_push',
  'pull_request_create',
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
      if (findActionDefinition(action) === undefined)
        return { ok: false, violation: `unallowed action ${action}` };
  }
  if (!DIAGNOSE_FAILURE_STEPS.some((s) => s.actionTypes.includes('sandbox_run_test')))
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
