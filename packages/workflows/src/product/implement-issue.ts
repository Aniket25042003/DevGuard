/**
 * C049 — "implement_issue" product workflow definition.
 *
 * Issue -> context -> validated plan -> workflow-owned branch -> isolated edits
 * -> focused tests -> broad tests -> security -> commit/push -> PR -> generic
 * review remediation -> approval-gated merge. Evidence is persisted through
 * every stage; completion requires structured validation + provider evidence,
 * never an agent statement. `allowedActionTypes` is a maximum-capability ceiling
 * (authorization happens at execution via policy). Merge is approval-gated and
 * revalidated, never automatic.
 */
export const IMPLEMENT_ISSUE_DEFINITION_ID = 'implement_issue';
export const IMPLEMENT_ISSUE_DEFINITION_VERSION = '1.0.0';

export interface ProductStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'approval' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const IMPLEMENT_ISSUE_STEPS: readonly ProductStep[] = [
  {
    id: 'context',
    kind: 'turn',
    actionTypes: ['repository_read', 'issue_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v-context'],
  },
  {
    id: 'plan',
    kind: 'turn',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v-plan'],
  },
  {
    id: 'plan_validate',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v-plan_scope'],
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
    id: 'edit',
    kind: 'turn',
    actionTypes: ['workspace_apply_patch'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_diff_scope'],
  },
  {
    id: 'focused_tests',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_test_focused'],
  },
  {
    id: 'broad_tests',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_broad'],
  },
  {
    id: 'security',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_sec_scan'],
  },
  {
    id: 'commit_push',
    kind: 'command',
    actionTypes: ['commit_create', 'branch_push'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'open_pr',
    kind: 'published',
    actionTypes: ['pull_request_create'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'remediate',
    kind: 'turn',
    actionTypes: ['workspace_apply_patch'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_review'],
  },
  {
    id: 'remediation_focused_tests',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 600_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_focused'],
  },
  {
    id: 'remediation_broad_tests',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_test_broad'],
  },
  {
    id: 'remediation_security',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_sec_scan'],
  },
  {
    id: 'remediation_commit_push',
    kind: 'command',
    actionTypes: ['commit_create', 'branch_push'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'approve_merge',
    kind: 'approval',
    actionTypes: ['approval_checkpoint_create'],
    maxRetries: 0,
    maxWallMillis: 3600_000,
    failureBehavior: 'stop',
    validatorIds: ['v_merge_gate'],
  },
  {
    id: 'merge',
    kind: 'published',
    actionTypes: ['pull_request_merge'],
    maxRetries: 0,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
];

export const IMPLEMENT_ISSUE_ALLOWED_ACTIONS: readonly string[] = [
  'repository_read',
  'issue_read',
  'branch_create',
  'workspace_apply_patch',
  'sandbox_run_test',
  'sandbox_run_security_scan',
  'commit_create',
  'branch_push',
  'pull_request_create',
  'approval_checkpoint_create',
  'pull_request_merge',
];

export const IMPLEMENT_ISSUE_REQUIRED_CAPABILITIES: readonly string[] = [
  'cap:trueforge_agent',
  'cap:sandbox_exec',
  'cap:github_write',
];
export const IMPLEMENT_ISSUE_ARTIFACTS: readonly string[] = [
  'plan',
  'patch',
  'test_evidence',
  'security_evidence',
];

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

/** Invariant validator: definitions must be bounded and fail-closed. */
export function validateDefinition(): DefinitionValidation {
  if (IMPLEMENT_ISSUE_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of IMPLEMENT_ISSUE_STEPS) {
    if (step.maxRetries < 0 || step.maxRetries > 8)
      return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes) {
      if (!IMPLEMENT_ISSUE_ALLOWED_ACTIONS.includes(action))
        return { ok: false, violation: `unallowed action ${action}` };
    }
  }
  // Merge must be approval-gated.
  if (IMPLEMENT_ISSUE_STEPS.filter((s) => s.id === 'merge').length !== 1 || IMPLEMENT_ISSUE_STEPS[IMPLEMENT_ISSUE_STEPS.length - 2]?.id !== 'approve_merge' || IMPLEMENT_ISSUE_STEPS[IMPLEMENT_ISSUE_STEPS.length - 2]?.kind !== 'approval' || !IMPLEMENT_ISSUE_STEPS[IMPLEMENT_ISSUE_STEPS.length - 2]?.validatorIds.includes('v_merge_gate'))
    return { ok: false, violation: 'missing approval gate' };
  return { ok: true };
}

export const implementIssueDefinition = {
  id: IMPLEMENT_ISSUE_DEFINITION_ID,
  semanticVersion: IMPLEMENT_ISSUE_DEFINITION_VERSION,
  status: 'ACTIVE',
  enabled: true,
  steps: IMPLEMENT_ISSUE_STEPS,
  allowedActionTypes: IMPLEMENT_ISSUE_ALLOWED_ACTIONS,
  requiredCapabilities: IMPLEMENT_ISSUE_REQUIRED_CAPABILITIES,
  artifactDeclarations: IMPLEMENT_ISSUE_ARTIFACTS,
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;
