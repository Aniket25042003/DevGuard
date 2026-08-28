/**
 * C054 — `review_remediation` product workflow definition.
 *
 * Ingest generic GitHub reviews/review threads/comments/check results for a PR
 * head SHA; preserve authentic source provenance (Qodo labelled only when GitHub
 * metadata proves that actor); classify and disposition each stable finding
 * (accepted/fixed/not_applicable/disputed/needs_human/superseded/unresolved);
 * remediate applicable findings bounded by a cycle budget (never endless loops);
 * validate and push idempotently; and explicitly retain unresolved/disputed
 * findings without fabrication or auto-dismissal.
 */
import { findActionDefinition } from '@devguard/policy-engine';

export const REVIEW_REMEDIATION_DEFINITION_ID = 'review_remediation';
export const REVIEW_REMEDIATION_DEFINITION_VERSION = '1.0.0';

export interface ReviewStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const REVIEW_REMEDIATION_STEPS: readonly ReviewStep[] = [
  {
    id: 'ingest',
    kind: 'turn',
    actionTypes: ['pull_request_read', 'review_read', 'issue_comments_read', 'checks_read'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_provenance'],
  },
  {
    id: 'normalize',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_finding_normalize'],
  },
  {
    id: 'classify',
    kind: 'turn',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_classification'],
  },
  {
    id: 'disposition',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_disposition'],
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
    id: 'validate',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_test_focused', 'v_security'],
  },
  {
    id: 'push',
    kind: 'published',
    actionTypes: ['commit_create', 'branch_push'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
  {
    id: 'rereview',
    kind: 'published',
    actionTypes: ['review_request'],
    maxRetries: 0,
    maxWallMillis: 60_000,
    failureBehavior: 'stop',
    validatorIds: [],
  },
];

export const REVIEW_REMEDIATION_ALLOWED_ACTIONS: readonly string[] = [
  'pull_request_read',
  'review_read',
  'issue_comments_read',
  'checks_read',
  'workspace_apply_patch',
  'sandbox_run_test',
  'commit_create',
  'branch_push',
  'review_request',
];

export const REVIEW_REMEDIATION_CYCLE_BUDGET = 2;

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

export function validateDefinition(): DefinitionValidation {
  if (REVIEW_REMEDIATION_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of REVIEW_REMEDIATION_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes) {
      if (!REVIEW_REMEDIATION_ALLOWED_ACTIONS.includes(action) || !findActionDefinition(action))
        return { ok: false, violation: `unregistered action ${action}` };
    }
  }
  // Remediation must be bounded (never endless re-review loops).
  if (REVIEW_REMEDIATION_CYCLE_BUDGET <= 0)
    return { ok: false, violation: 'cycle budget must be positive' };
  return { ok: true };
}

export const reviewRemediationDefinition = {
  id: REVIEW_REMEDIATION_DEFINITION_ID,
  semanticVersion: REVIEW_REMEDIATION_DEFINITION_VERSION,
  status: 'ACTIVE',
  enabled: true,
  steps: REVIEW_REMEDIATION_STEPS,
  allowedActionTypes: REVIEW_REMEDIATION_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:github_write'],
  artifactDeclarations: ['findings', 'patch', 'test_evidence'],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;
