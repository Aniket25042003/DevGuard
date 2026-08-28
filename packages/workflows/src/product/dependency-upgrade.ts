/**
 * C053 — `dependency_upgrade` product workflow definition (Extension).
 *
 * Upgrade a targeted vulnerable/outdated dependency to a repository-compatible
 * version in an isolated TrueForge sandbox: detect package manager + lockfile
 * from repository evidence, resolve compatible candidates with rejection
 * reasons (never a blind "latest"), validate the plan before any write/network,
 * install through a contained registry allowlist, prove a bounded manifest/
 * lockfile/tree diff, run focused + broad validators and a comparable security
 * re-scan (a version bump alone does NOT prove advisory remediation), and
 * publish before/after evidence on a workflow-owned PR. Merge stays outside.
 *
 * Extension: disabled by default (feature/policy gated) per C053 acceptance.
 */
import { findActionDefinition } from '@devguard/policy-engine';
import { canonicalDigest } from '../definitions/registry.js';
import type { WorkflowDefinition } from '../definitions/contracts.js';

const DEPENDENCY_UPGRADE_AGENT_ID = 'agent:dependency-upgrade';
const DEPENDENCY_UPGRADE_INPUT_SCHEMA_ID = 'schema:dependency-upgrade-input@1';
const DEPENDENCY_UPGRADE_OUTPUT_SCHEMA_ID = 'schema:dependency-upgrade-output@1';

// Candidate identity is persisted by the run orchestrator; it is not an attempt count.
export const DEPENDENCY_UPGRADE_CANDIDATE_STATE_KEY = 'dependency_upgrade.candidates';
export const DEPENDENCY_UPGRADE_CANDIDATE_BUDGET = 2;

export const DEPENDENCY_UPGRADE_DEFINITION_ID = 'dependency_upgrade';
export const DEPENDENCY_UPGRADE_DEFINITION_VERSION = '1.0.0';

export interface UpgradeStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const DEPENDENCY_UPGRADE_STEPS: readonly UpgradeStep[] = [
  {
    id: 'intake',
    kind: 'turn',
    actionTypes: ['repository_read', 'issue_read', 'pull_request_read', 'checks_read'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_provenance'],
  },
  {
    id: 'baseline',
    kind: 'validator',
    actionTypes: ['content_read', 'tree_list', 'repository_metadata_read'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_baseline_immutable'],
  },
  {
    id: 'candidates',
    kind: 'turn',
    actionTypes: ['repository_metadata_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_candidate_set'],
  },
  {
    id: 'plan',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_plan_validated'],
  },
  {
    id: 'workspace',
    kind: 'command',
    actionTypes: ['workspace_create', 'tree_list', 'content_read'],
    maxRetries: 2,
    maxWallMillis: 300_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_workspace_owned'],
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
    id: 'install',
    kind: 'command',
    actionTypes: ['sandbox_install_dependency'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_install_contained'],
  },
  {
    id: 'diff_tree',
    kind: 'validator',
    actionTypes: ['commit_compare'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_diff_bounded'],
  },
  {
    id: 'focused',
    kind: 'command',
    actionTypes: ['sandbox_run_test'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_test_focused'],
  },
  {
    id: 'broad',
    kind: 'command',
    actionTypes: ['sandbox_run_build', 'sandbox_run_typecheck'],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_broad'],
  },
  {
    id: 'rescan',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_rescan_comparable'],
  },
  {
    id: 'publish',
    kind: 'published',
    actionTypes: ['commit_create', 'branch_push', 'pull_request_create'],
    maxRetries: 2,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_current_head_evidence', 'v_branch_ownership'],
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

export const DEPENDENCY_UPGRADE_ALLOWED_ACTIONS: readonly string[] = [
  'repository_read',
  'issue_read',
  'pull_request_read',
  'checks_read',
  'content_read',
  'tree_list',
  'repository_metadata_read',
  'commit_compare',
  'workspace_create',
  'sandbox_install_dependency',
  'sandbox_run_test',
  'sandbox_run_build',
  'sandbox_run_typecheck',
  'sandbox_run_security_scan',
  'branch_create',
  'commit_create',
  'branch_push',
  'pull_request_create',
  'pull_request_update',
];

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

export function validateDefinition(): DefinitionValidation {
  if (DEPENDENCY_UPGRADE_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of DEPENDENCY_UPGRADE_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes) {
      if (!DEPENDENCY_UPGRADE_ALLOWED_ACTIONS.includes(action) || !findActionDefinition(action))
        return { ok: false, violation: `unregistered action ${action}` };
    }
  }
  // Candidate rework must be bounded (never a blind/no-limit upgrade loop).
  if (DEPENDENCY_UPGRADE_CANDIDATE_BUDGET <= 0)
    return { ok: false, violation: 'candidate budget must be positive' };
  // Installs must run only in a contained sandbox.
  if (!DEPENDENCY_UPGRADE_STEPS.some((s) => s.actionTypes.includes('sandbox_install_dependency')))
    return { ok: false, violation: 'sandbox install required' };
  // A version bump alone does not prove remediation: a comparable re-scan is required.
  if (!DEPENDENCY_UPGRADE_STEPS.some((s) => s.validatorIds.includes('v_rescan_comparable')))
    return { ok: false, violation: 'comparable security re-scan required' };
  // Merge is outside this workflow.
  if (DEPENDENCY_UPGRADE_ALLOWED_ACTIONS.includes('pull_request_merge'))
    return { ok: false, violation: 'merge not allowed' };
  return { ok: true };
}

const dependencyUpgradeDefinitionWithoutDigest = {
  id: DEPENDENCY_UPGRADE_DEFINITION_ID,
  semanticVersion: DEPENDENCY_UPGRADE_DEFINITION_VERSION,
  status: 'ACTIVE' as const,
  // Extension: disabled by default; launches only through feature/policy gates.
  enabled: false,
  agentDefinitionId: DEPENDENCY_UPGRADE_AGENT_ID,
  inputSchemaId: DEPENDENCY_UPGRADE_INPUT_SCHEMA_ID,
  outputSchemaId: DEPENDENCY_UPGRADE_OUTPUT_SCHEMA_ID,
  steps: DEPENDENCY_UPGRADE_STEPS,
  allowedActionTypes: DEPENDENCY_UPGRADE_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:sandbox_exec', 'cap:github_write'],
  artifactDeclarations: [
    'baseline',
    'upgrade_plan',
    'manifest_diff',
    'lockfile_diff',
    'validation_evidence',
    'security_evidence',
  ],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;

export const dependencyUpgradeDefinition = {
  ...dependencyUpgradeDefinitionWithoutDigest,
  digest: canonicalDigest(dependencyUpgradeDefinitionWithoutDigest as unknown as WorkflowDefinition),
} as const;
