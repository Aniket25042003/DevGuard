/**
 * C055 — `repository_health_check` product workflow definition (Extension).
 *
 * Non-mutating, evidence-backed repository health report over build, tests,
 * coverage (when configured), dependency freshness, security, CI consistency,
 * documentation gaps, flaky-test signals, and dead-code candidates. Advisory by
 * default: it must NEVER convert observations into source/Git mutations — no
 * branch/commit/PR/comment/settings write exists in the allowed-action set, and
 * a post-probe source-immutability gate invalidates any probe that altered
 * source. Missing/unavailable domains surface as unknown/blocked (never "healthy").
 */
import { createHash } from 'node:crypto';
import { findActionDefinition } from '@devguard/policy-engine';

export const REPOSITORY_HEALTH_DEFINITION_ID = 'repository_health_check';
export const REPOSITORY_HEALTH_DEFINITION_VERSION = '1.0.0';

export type HealthDomain =
  | 'build'
  | 'tests'
  | 'coverage'
  | 'dependencies'
  | 'security'
  | 'ci'
  | 'documentation'
  | 'flakiness'
  | 'dead_code';

export interface HealthStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop' | 'repair_turn';
  readonly validatorIds: readonly string[];
}

export const REPOSITORY_HEALTH_STEPS: readonly HealthStep[] = [
  {
    id: 'intake',
    kind: 'turn',
    actionTypes: ['repository_read', 'pull_request_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_provenance'],
  },
  {
    id: 'target',
    kind: 'validator',
    actionTypes: ['branch_read', 'commit_compare', 'repository_metadata_read'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_target_pinned'],
  },
  {
    id: 'profile',
    kind: 'turn',
    actionTypes: ['content_read', 'tree_list', 'repository_metadata_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'stop',
    validatorIds: ['v_profile'],
  },
  {
    id: 'probe_plan',
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
    validatorIds: ['v_workspace_readonly'],
  },
  {
    id: 'probes',
    kind: 'command',
    actionTypes: [
      'sandbox_run_readonly',
      'sandbox_run_build',
      'sandbox_run_dependency_freshness',
      'sandbox_run_test',
      'sandbox_run_security_scan',
      'workflow_logs_read',
      'checks_read',
    ],
    maxRetries: 2,
    maxWallMillis: 900_000,
    failureBehavior: 'repair_turn',
    validatorIds: ['v_probe_collected'],
  },
  {
    id: 'source_immutable',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'stop',
    validatorIds: ['v_source_immutable'],
  },
  {
    id: 'normalize',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_normalized'],
  },
  {
    id: 'security_evidence',
    kind: 'command',
    actionTypes: ['sandbox_run_security_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'stop',
    validatorIds: ['v_security_freshness'],
  },
  {
    id: 'aggregate',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_aggregate_unknown_preserved'],
  },
  {
    id: 'report',
    kind: 'published',
    actionTypes: ['workspace_collect_artifact'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
];

export const REPOSITORY_HEALTH_ALLOWED_ACTIONS: readonly string[] = [
  'repository_read',
  'pull_request_read',
  'tree_list',
  'content_read',
  'branch_read',
  'commit_compare',
  'checks_read',
  'workflow_logs_read',
  'repository_metadata_read',
  'workspace_create',
  'sandbox_run_readonly',
  'sandbox_run_build',
  'sandbox_run_dependency_freshness',
  'sandbox_run_test',
  'sandbox_run_security_scan',
  'workspace_collect_artifact',
  'workspace_destroy',
  'workflow_cancel',
];

/** Any source/Git-mutating or external-effect action is forbidden for an advisory report. */
const MUTATION_ACTIONS: readonly string[] = [
  'branch_create',
  'commit_create',
  'branch_push',
  'pull_request_create',
  'pull_request_update',
  'pull_request_merge',
  'pull_request_comment',
  'review_request',
  'workspace_write_file',
  'workspace_delete_file',
  'workspace_apply_patch',
  'sandbox_install_dependency',
  'sandbox_run_networked',
  'sandbox_run_migration_simulation',
  'protected_branch_write',
  'branch_delete',
  'ci_workflow_modify',
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
  if (REPOSITORY_HEALTH_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of REPOSITORY_HEALTH_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes) {
      if (!REPOSITORY_HEALTH_ALLOWED_ACTIONS.includes(action) || !findActionDefinition(action))
        return { ok: false, violation: `unregistered action ${action}` };
    }
  }
  // Advisory-only: NO source or GitHub mutation may ever be authorized.
  for (const action of REPOSITORY_HEALTH_ALLOWED_ACTIONS)
    if (MUTATION_ACTIONS.includes(action))
      return { ok: false, violation: `mutating action ${action} not allowed` };
  // Missing/unavailable domains must surface honestly, never as healthy.
  if (
    !REPOSITORY_HEALTH_STEPS.some((s) => s.validatorIds.includes('v_aggregate_unknown_preserved'))
  )
    return { ok: false, violation: 'unknown/blocked preservation required' };
  // Post-probe source-mutation gate is mandatory for advisory execution.
  if (!REPOSITORY_HEALTH_STEPS.some((s) => s.validatorIds.includes('v_source_immutable')))
    return { ok: false, violation: 'source immutability gate required' };
  return { ok: true };
}

export const repositoryHealthDefinition = {
  id: REPOSITORY_HEALTH_DEFINITION_ID,
  semanticVersion: REPOSITORY_HEALTH_DEFINITION_VERSION,
  status: 'ACTIVE',
  agentDefinitionId: 'ad:trueforge_agent',
  inputSchemaId: 'schema:repository_health_check_input',
  outputSchemaId: 'schema:repository_health_check_output',
  // Extension: disabled by default; launches only through feature/policy gates.
  enabled: false,
  steps: REPOSITORY_HEALTH_STEPS,
  allowedActionTypes: REPOSITORY_HEALTH_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:sandbox_exec'],
  artifactDeclarations: ['health_report', 'probe_evidence', 'security_evidence'],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
  digest: createHash('sha256')
    .update(
      JSON.stringify({
        id: REPOSITORY_HEALTH_DEFINITION_ID,
        version: REPOSITORY_HEALTH_DEFINITION_VERSION,
        steps: REPOSITORY_HEALTH_STEPS,
        schemaOutput: 'schema:repository_health_check_output',
      }),
    )
    .digest('hex'),
} as const;
