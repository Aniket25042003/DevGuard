/**
 * C024 §8 — exhaustive initial action taxonomy.
 *
 * Every executable operation DevGuard can understand registers here with a
 * stable ID, category, baseline risk, reversibility, privilege flag, default
 * effect and required obligations. Anything unregistered fails closed
 * upstream (UNKNOWN_CAPABILITY). No catch-all/generic action exists by design.
 *
 * Risk values reuse C004's canonical classes:
 *   read | reversible_write | sensitive_write | destructive | external_side_effect
 * (C024/C025 prose equivalents: READ / WRITE_REVERSIBLE / WRITE_SENSITIVE /
 *  DESTRUCTIVE / EXTERNAL_SIDE_EFFECT.)
 */
import type { RiskClass } from '@devguard/contracts';

export const ACTION_CATEGORIES = [
  'repository_read',
  'workspace_write',
  'github_write',
  'collaboration',
  'validation',
  'sandbox',
  'administration',
  'external_effect',
  'destructive',
] as const;

export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/** Execution obligations reference C004's Obligation union shapes. */
export type ExecutionObligation =
  | { kind: 'execution_environment'; environment: 'sandbox_required' | 'devguard_service' }
  | { kind: 'network_policy'; mode: 'default_deny' | 'allowlist'; allowlist?: readonly string[] }
  | { kind: 'timeout_ms'; value: number }
  | { kind: 'resource_ceiling'; cpuCores?: number; memoryMb?: number; diskMb?: number }
  | { kind: 'secret_grant'; names: readonly string[] };

export interface ActionDefinition {
  readonly id: string;
  readonly category: ActionCategory;
  readonly baselineRisk: RiskClass;
  readonly reversible: boolean;
  readonly privileged: boolean;
  readonly defaultEffect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  /** Context fields C025 rules may require before meaningful classification. */
  readonly requiredContext: readonly string[];
  readonly obligations: readonly ExecutionObligation[];
}

const SANDBOX_ONLY: ExecutionObligation = {
  kind: 'execution_environment',
  environment: 'sandbox_required',
};
const NETWORK_DENY: ExecutionObligation = { kind: 'network_policy', mode: 'default_deny' };
const READ_TIMEOUT: ExecutionObligation = { kind: 'timeout_ms', value: 60_000 };
const BUILD_TIMEOUT: ExecutionObligation = { kind: 'timeout_ms', value: 600_000 };
const RESOURCES_DEFAULT: ExecutionObligation = {
  kind: 'resource_ceiling',
  cpuCores: 2,
  memoryMb: 2048,
  diskMb: 8192,
};

const read = (id: string, context: string[]): ActionDefinition =>
  Object.freeze({
    id,
    category: 'repository_read',
    baselineRisk: 'read',
    reversible: true,
    privileged: false,
    defaultEffect: 'ALLOW',
    requiredContext: Object.freeze(context),
    obligations: Object.freeze([NETWORK_DENY, READ_TIMEOUT]),
  });

const workspace = (id: string): ActionDefinition =>
  Object.freeze({
    id,
    category: 'workspace_write',
    baselineRisk: 'reversible_write',
    reversible: true,
    privileged: false,
    defaultEffect: 'ALLOW',
    requiredContext: Object.freeze([]),
    obligations: Object.freeze([SANDBOX_ONLY]),
  });

const gitWrite = (id: string): ActionDefinition =>
  Object.freeze({
    id,
    category: 'github_write',
    baselineRisk: 'reversible_write',
    reversible: true,
    privileged: false,
    defaultEffect: 'ALLOW',
    requiredContext: Object.freeze(['target.ref']),
    obligations: Object.freeze([NETWORK_DENY]),
  });

const sandboxCmd = (
  id: string,
  baseline: RiskClass,
  obligations: readonly ExecutionObligation[],
): ActionDefinition =>
  Object.freeze({
    id,
    category: 'sandbox',
    baselineRisk: baseline,
    reversible: true,
    privileged: false,
    defaultEffect: 'ALLOW',
    requiredContext: Object.freeze(['command.fingerprint']),
    obligations: Object.freeze([...obligations, SANDBOX_ONLY]),
  });

const sensitive = (id: string, defaultEffect: 'REQUIRE_APPROVAL' | 'DENY'): ActionDefinition =>
  Object.freeze({
    id,
    category: 'administration',
    baselineRisk: defaultEffect === 'DENY' ? 'destructive' : 'sensitive_write',
    reversible: false,
    privileged: true,
    defaultEffect,
    requiredContext: Object.freeze(['target.id']),
    obligations: Object.freeze([NETWORK_DENY]),
  });

const destructive = (id: string, defaultEffect: 'REQUIRE_APPROVAL' | 'DENY'): ActionDefinition =>
  Object.freeze({
    id,
    category: 'destructive',
    baselineRisk: 'destructive',
    reversible: false,
    privileged: true,
    defaultEffect,
    requiredContext: Object.freeze(['target.id']),
    obligations: Object.freeze([NETWORK_DENY]),
  });

const external = (id: string): ActionDefinition =>
  Object.freeze({
    id,
    category: 'external_effect',
    baselineRisk: 'external_side_effect',
    reversible: false,
    privileged: true,
    defaultEffect: 'REQUIRE_APPROVAL',
    requiredContext: Object.freeze(['target.environment']),
    obligations: Object.freeze([NETWORK_DENY]),
  });

const validationAct = (id: string, baseline: RiskClass): ActionDefinition =>
  Object.freeze({
    id,
    category: 'validation',
    baselineRisk: baseline,
    reversible: true,
    privileged: false,
    defaultEffect: 'ALLOW',
    requiredContext: Object.freeze([]),
    // Validation/control actions are classified by concrete metadata downstream;
    // they never self-authorize beyond their declared baseline.
    obligations: Object.freeze([NETWORK_DENY, READ_TIMEOUT]),
  });

/** The complete initial taxonomy from C024 §8. Order: stable, review-locked. */
export const ACTION_DEFINITIONS: readonly ActionDefinition[] = Object.freeze([
  // Reads
  read('repository_read', []),
  read('issue_read', []),
  read('issue_comments_read', []),
  read('content_read', ['target.ref']),
  read('tree_list', ['target.ref']),
  read('branch_read', []),
  read('commit_compare', ['operation.baseSha', 'operation.headSha']),
  read('pull_request_read', []),
  read('review_read', []),
  read('checks_read', []),
  read('workflow_logs_read', []),
  read('repository_metadata_read', []),

  // Workspace reversible writes
  workspace('workspace_create'),
  workspace('workspace_write_file'),
  workspace('workspace_delete_file'),
  workspace('workspace_apply_patch'),
  workspace('workspace_collect_artifact'),
  workspace('workspace_destroy'),

  // Sandbox commands
  sandboxCmd('sandbox_run_readonly', 'read', [NETWORK_DENY, READ_TIMEOUT, RESOURCES_DEFAULT]),
  sandboxCmd('sandbox_run_dependency_freshness', 'read', [
    {
      kind: 'network_policy',
      mode: 'allowlist',
      allowlist: Object.freeze(['registry.npmjs.org', 'registry.yarnpkg.com', 'pypi.org']),
    },
    BUILD_TIMEOUT,
    RESOURCES_DEFAULT,
  ]),
  sandboxCmd('sandbox_run_build', 'reversible_write', [
    NETWORK_DENY,
    BUILD_TIMEOUT,
    RESOURCES_DEFAULT,
  ]),
  sandboxCmd('sandbox_run_test', 'reversible_write', [
    NETWORK_DENY,
    BUILD_TIMEOUT,
    RESOURCES_DEFAULT,
  ]),
  sandboxCmd('sandbox_run_lint', 'read', [NETWORK_DENY, READ_TIMEOUT, RESOURCES_DEFAULT]),
  sandboxCmd('sandbox_run_typecheck', 'read', [NETWORK_DENY, READ_TIMEOUT, RESOURCES_DEFAULT]),
  sandboxCmd('sandbox_run_security_scan', 'read', [
    { kind: 'network_policy', mode: 'allowlist', allowlist: Object.freeze(['api.github.com']) },
    BUILD_TIMEOUT,
    RESOURCES_DEFAULT,
  ]),
  sandboxCmd('sandbox_install_dependency', 'reversible_write', [
    { kind: 'network_policy', mode: 'allowlist', allowlist: Object.freeze(['registry.npmjs.org']) },
    BUILD_TIMEOUT,
    RESOURCES_DEFAULT,
  ]),
  sandboxCmd('sandbox_run_networked', 'reversible_write', [BUILD_TIMEOUT, RESOURCES_DEFAULT]),
  sandboxCmd('sandbox_run_migration_simulation', 'sensitive_write', [
    NETWORK_DENY,
    BUILD_TIMEOUT,
    RESOURCES_DEFAULT,
  ]),

  // Git writes
  gitWrite('branch_create'),
  gitWrite('commit_create'),
  gitWrite('branch_push'),
  gitWrite('pull_request_create'),
  gitWrite('pull_request_update'),
  gitWrite('pull_request_comment'),
  gitWrite('review_request'),

  // Sensitive Git/admin
  sensitive('protected_branch_write', 'REQUIRE_APPROVAL'),
  sensitive('ci_workflow_modify', 'REQUIRE_APPROVAL'),
  sensitive('branch_delete', 'REQUIRE_APPROVAL'),
  sensitive('repository_settings_modify', 'DENY'),
  sensitive('secret_config_modify', 'DENY'),
  destructive('default_branch_history_rewrite', 'DENY'),

  // Destructive
  destructive('pull_request_merge', 'REQUIRE_APPROVAL'),
  destructive('repository_delete', 'DENY'),
  destructive('repository_content_permanent_delete', 'DENY'),
  destructive('credential_rotate_or_remove', 'DENY'),
  destructive('destructive_migration', 'DENY'),
  destructive('issue_destructive_close', 'REQUIRE_APPROVAL'),

  // External
  external('production_deploy'),
  external('external_notification_send'),
  external('billing_resource_create'),
  external('production_settings_modify'),

  // Validation/control
  validationAct('validation_run', 'read'),
  validationAct('security_finding_record', 'reversible_write'),
  validationAct('workflow_cancel', 'reversible_write'),
  validationAct('approval_checkpoint_create', 'reversible_write'),
]);

export type CanonicalActionId = (typeof ACTION_DEFINITIONS)[number]['id'];

const BY_ID: ReadonlyMap<string, ActionDefinition> = new Map(
  ACTION_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/** Unknown IDs return undefined — callers must fail closed, never guess. */
export function findActionDefinition(id: string): ActionDefinition | undefined {
  return BY_ID.get(id);
}

/** Registry-build-time validation: duplicate/empty/conflicting definitions stop publication. */
export function validateCatalog(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of ACTION_DEFINITIONS) {
    if (!/^[a-z][a-z0-9_]*$/.test(definition.id)) {
      problems.push(`action '${definition.id}' violates ID grammar`);
    }
    if (seen.has(definition.id)) problems.push(`duplicate action '${definition.id}'`);
    seen.add(definition.id);
    if (definition.defaultEffect === 'ALLOW' && (definition.privileged || !definition.reversible)) {
      problems.push(
        `action '${definition.id}' defaults ALLOW while privileged=${definition.privileged} reversible=${definition.reversible}`,
      );
    }
    if (definition.baselineRisk === 'destructive' && definition.reversible) {
      problems.push(`action '${definition.id}' destructive but flagged reversible`);
    }
  }
  return problems;
}
