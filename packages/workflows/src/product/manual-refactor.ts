/**
 * C056 — `manual_refactor` product workflow definition (Extension).
 *
 * User-initiated, explicitly scoped, behavior-preserving refactor in a sandbox:
 * validate manual inputs + canonical include/exclude scope, capture a baseline
 * BEFORE any modification (baseline failure blocks by default), produce a
 * traceable refactor plan validated before branch/write, apply governed scoped
 * file changes, run incremental + broad + security validators, compare diff and
 * public contracts against baseline (allowPublicApiChange is fixed FALSE in v1),
 * and publish an evidence-rich workflow-owned PR. Merge, review automation,
 * dependency-upgrade, and migration execution stay outside.
 */
import { findActionDefinition } from '@devguard/policy-engine';

export const MANUAL_REFACTOR_DEFINITION_ID = 'manual_refactor';
export const MANUAL_REFACTOR_DEFINITION_VERSION = '1.0.0';

/** v1 fixed: public API / behavior changes require a separate explicitly-authorized workflow. */
export const MANUAL_REFACTOR_ALLOW_PUBLIC_API_CHANGE = false as const;

/** Bounded transform rework loop (proposal revision is not unlimited). */
export const MANUAL_REFACTOR_PLAN_BUDGET = 2;

export interface RefactorStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const MANUAL_REFACTOR_STEPS: readonly RefactorStep[] = [
  {
    id: 'intake',
    kind: 'turn',
    actionTypes: ['repository_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_manual_actor'],
  },
  {
    id: 'scope',
    kind: 'validator',
    actionTypes: ['tree_list', 'content_read'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'stop',
    validatorIds: ['v_scope_validated'],
  },
  {
    id: 'context',
    kind: 'turn',
    actionTypes: ['content_read', 'tree_list', 'repository_metadata_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_context_provenance'],
  },
  {
    id: 'baseline',
    kind: 'command',
    actionTypes: ['sandbox_run_test', 'sandbox_run_typecheck', 'sandbox_run_lint'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_baseline_captured'],
  },
  {
    id: 'plan',
    kind: 'turn',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_plan_validated'],
  },
  {
    id: 'workspace',
    kind: 'command',
    actionTypes: ['workspace_create', 'tree_list', 'content_read'],
    maxRetries: 2,
    maxWallMillis: 300_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'branch',
    kind: 'command',
    actionTypes: ['branch_create'],
    maxRetries: 2,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_branch_owned'],
  },
  {
    id: 'transform',
    kind: 'command',
    actionTypes: ['workspace_apply_patch', 'workspace_write_file', 'workspace_delete_file'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_scope_enforced'],
  },
  {
    id: 'incremental',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_incremental'],
  },
  {
    id: 'diff_invariant',
    kind: 'validator',
    actionTypes: ['commit_compare'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_diff_invariant', 'v_public_contract'],
  },
  {
    id: 'broad',
    kind: 'command',
    actionTypes: ['sandbox_run_build', 'sandbox_run_typecheck', 'sandbox_run_lint'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_broad'],
  },
  {
    id: 'security',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_security'],
  },
  {
    id: 'publish',
    kind: 'published',
    actionTypes: ['commit_create', 'branch_push', 'pull_request_create'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'finalize',
    kind: 'published',
    actionTypes: ['pull_request_update'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
];

export const MANUAL_REFACTOR_ALLOWED_ACTIONS: readonly string[] = [
  'repository_read',
  'tree_list',
  'content_read',
  'repository_metadata_read',
  'commit_compare',
  'workspace_create',
  'workspace_write_file',
  'workspace_delete_file',
  'workspace_apply_patch',
  'workspace_collect_artifact',
  'workspace_destroy',
  'sandbox_run_test',
  'sandbox_run_typecheck',
  'sandbox_run_lint',
  'sandbox_run_build',
  'sandbox_run_security_scan',
  'branch_create',
  'commit_create',
  'branch_push',
  'pull_request_create',
  'pull_request_update',
  'workflow_cancel',
];

/** Explicitly excluded: merge, review automation, dependency/migration/settings, protected writes. */
const EXCLUDED_ACTIONS: readonly string[] = [
  'pull_request_merge',
  'pull_request_comment',
  'review_request',
  'sandbox_install_dependency',
  'sandbox_run_networked',
  'sandbox_run_migration_simulation',
  'protected_branch_write',
  'ci_workflow_modify',
  'branch_delete',
  'repository_settings_modify',
  'secret_config_modify',
  'default_branch_history_rewrite',
  'repository_delete',
  'repository_content_permanent_delete',
  'production_deploy',
];

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

export function validateDefinition(): DefinitionValidation {
  if (MANUAL_REFACTOR_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of MANUAL_REFACTOR_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes) {
      if (!MANUAL_REFACTOR_ALLOWED_ACTIONS.includes(action) || !findActionDefinition(action))
        return { ok: false, violation: `unregistered action ${action}` };
    }
  }
  // No merge, review automation, dependency/migration/settings writes.
  for (const action of MANUAL_REFACTOR_ALLOWED_ACTIONS)
    if (EXCLUDED_ACTIONS.includes(action))
      return { ok: false, violation: `excluded action ${action} present` };
  // Baseline must precede any modification; failure blocks by default.
  if (!MANUAL_REFACTOR_STEPS.some((s) => s.validatorIds.includes('v_baseline_captured')))
    return { ok: false, violation: 'baseline before modification required' };
  // Public API changes are not permitted in v1.
  if (MANUAL_REFACTOR_ALLOW_PUBLIC_API_CHANGE)
    return { ok: false, violation: 'public API change must be allowed off in v1' };
  if (!MANUAL_REFACTOR_STEPS.some((s) => s.validatorIds.includes('v_public_contract')))
    return { ok: false, violation: 'public-contract comparison required' };
  if (MANUAL_REFACTOR_PLAN_BUDGET <= 0)
    return { ok: false, violation: 'plan budget must be positive' };
  return { ok: true };
}

export const manualRefactorDefinition = {
  id: MANUAL_REFACTOR_DEFINITION_ID,
  semanticVersion: MANUAL_REFACTOR_DEFINITION_VERSION,
  status: 'ACTIVE',
  // Extension: disabled by default; manual-only via feature/policy gates.
  enabled: false,
  steps: MANUAL_REFACTOR_STEPS,
  allowedActionTypes: MANUAL_REFACTOR_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:sandbox_exec', 'cap:github_write'],
  artifactDeclarations: [
    'baseline',
    'refactor_plan',
    'diff',
    'public_contract',
    'validation_evidence',
    'security_evidence',
  ],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;
