/**
 * C027 §8/§9 — GlobalSafetyPolicy and AutonomyProfile catalogs.
 *
 * These are trusted deployed configuration: code-reviewed, hash-bound,
 * NEVER repository-editable. Rules can only restrict — a rule's minimum
 * effect is a floor or ceiling, never a grant. Immutability semantics:
 * catalogs are frozen at module load; "activation" is deployment itself in
 * MVP (C027 §28 open decision on signing beyond build hash).
 */
import type { AutonomyLevel } from '@devguard/contracts';

export const RESTRICTION_SOURCES = [
  'GLOBAL_SAFETY',
  'AUTONOMY_CEILING',
  'REPOSITORY_DENY',
] as const;
export type RestrictionSource = (typeof RESTRICTION_SOURCES)[number];

export interface Restriction {
  readonly source: RestrictionSource;
  readonly minimumEffect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  readonly ruleId: string;
  readonly explanation: string;
  readonly nonOverridable: boolean;
}

export const GLOBAL_SAFETY_VERSION = 'global-safety@1';

/**
 * C027 §8 initial global denies — non-overridable by policy, approval,
 * autonomy level, model output or checkpoints. Matchers receive typed
 * identifiers only; no free-text matching exists.
 */
export interface GlobalRule {
  readonly id: string;
  /** Action IDs this rule unconditionally denies (deny list wins over floors). */
  readonly denyActions?: readonly string[];
  /** Action IDs that carry a hard non-overridable approval floor at most. */
  readonly approvalFloorActions?: readonly string[];
  readonly explanation: string;
}

const DENY_ALL_LEVELS_ACTIONS = Object.freeze([
  'repository_delete',
  'repository_content_permanent_delete',
  'credential_rotate_or_remove',
  'destructive_migration',
  'default_branch_history_rewrite',
  'repository_settings_modify',
  'secret_config_modify',
]);

/** Approval-floor actions from C027 §8's initial floor list. */
const APPROVAL_FLOOR_ACTIONS = Object.freeze([
  'pull_request_merge', // includes protected/default-branch merge per C016 facts
  'protected_branch_write',
  'ci_workflow_modify',
  'branch_delete',
  'issue_destructive_close',
  'production_deploy',
  'production_settings_modify',
  'billing_resource_create',
]);

export const GLOBAL_RULES: readonly GlobalRule[] = Object.freeze([
  {
    id: 'global-deny-destructive-administration',
    denyActions: DENY_ALL_LEVELS_ACTIONS,
    explanation:
      'repository deletion, irreversible content/history operations, credential and settings administration are globally denied in MVP',
  },
  {
    id: 'global-approval-floor-privileged',
    approvalFloorActions: APPROVAL_FLOOR_ACTIONS,
    explanation:
      'privileged merge/protected/external actions require exact durable human approval even under autonomous autonomy',
  },
]);

export interface SafetyCatalogSnapshot {
  readonly globalSafetyVersionId: string;
  readonly catalogHash: string;
}

// ---------------------------------------------------------------------------
// Autonomy ceilings (C027 §4/§8)
// ---------------------------------------------------------------------------

export interface AutonomyProfile {
  readonly level: AutonomyLevel;
  /** Actions the level may perform automatically when workflow permits. */
  readonly automaticActions: ReadonlySet<string>;
  /** Actions requiring approval regardless of repository grant style. */
  readonly approvalRequiredActions: ReadonlySet<string>;
  /** Actions unconditionally above the ceiling (DENY at this level). */
  readonly deniedActions: ReadonlySet<string>;
}

function set(values: readonly string[]): ReadonlySet<string> {
  const valuesSet = new Set(values);
  Object.defineProperties(valuesSet, {
    add: {
      value: () => {
        throw new TypeError('immutable safety profile');
      },
    },
    delete: {
      value: () => {
        throw new TypeError('immutable safety profile');
      },
    },
    clear: {
      value: () => {
        throw new TypeError('immutable safety profile');
      },
    },
  });
  return Object.freeze(valuesSet);
}

const READ_ACTIONS = set([
  'repository_read',
  'issue_read',
  'issue_comments_read',
  'content_read',
  'tree_list',
  'branch_read',
  'commit_compare',
  'pull_request_read',
  'review_read',
  'checks_read',
  'workflow_logs_read',
  'repository_metadata_read',
]);

const SANDBOX_ACTIONS = set([
  'workspace_create',
  'workspace_write_file',
  'workspace_delete_file',
  'workspace_apply_patch',
  'workspace_collect_artifact',
  'workspace_destroy',
  'sandbox_run_readonly',
  'sandbox_run_dependency_freshness',
  'sandbox_run_build',
  'sandbox_run_test',
  'sandbox_run_lint',
  'sandbox_run_typecheck',
  'sandbox_run_security_scan',
  'sandbox_run_migration_simulation',
  'validation_run',
  'security_finding_record',
  'workflow_cancel',
  'approval_checkpoint_create',
]);

const REVERSIBLE_GIT_WRITES = set([
  'branch_create',
  'commit_create',
  'branch_push',
  'pull_request_create',
  'pull_request_update',
  'pull_request_comment',
  'review_request',
  'sandbox_install_dependency',
  'sandbox_run_networked',
]);

/**
 * The four profiles per C027 §22 matrix:
 * - assist: reads + sandbox only
 * - developer: + reversible git writes
 * - trusted: developer + remediation automation bits (same writes)
 * - autonomous: everything explicitly registered EXCEPT globally denied
 *   (global rules still apply downstream of these ceilings)
 */
export const AUTONOMY_PROFILES: Readonly<Record<AutonomyLevel, AutonomyProfile>> = Object.freeze({
  assist: Object.freeze({
    level: 'assist',
    automaticActions: new Set([...READ_ACTIONS, ...SANDBOX_ACTIONS]),
    approvalRequiredActions: set([]),
    // Assist may not touch GitHub writes or ANY external effect (C027 §4.1).
    deniedActions: set([
      ...REVERSIBLE_GIT_WRITES,
      ...APPROVAL_FLOOR_ACTIONS,
      'external_notification_send',
      'production_deploy',
      'billing_resource_create',
      ...DENY_ALL_LEVELS_ACTIONS,
    ]),
  }),
  developer: Object.freeze({
    level: 'developer',
    automaticActions: new Set([...READ_ACTIONS, ...SANDBOX_ACTIONS, ...REVERSIBLE_GIT_WRITES]),
    // C027 §22: protected/default branch write and merge pause for humans;
    // external side effects carry the same floor (§8 external category).
    approvalRequiredActions: set([...APPROVAL_FLOOR_ACTIONS, 'external_notification_send']),
    deniedActions: set(DENY_ALL_LEVELS_ACTIONS),
  }),
  trusted: Object.freeze({
    level: 'trusted',
    automaticActions: new Set([...READ_ACTIONS, ...SANDBOX_ACTIONS, ...REVERSIBLE_GIT_WRITES]),
    approvalRequiredActions: set([...APPROVAL_FLOOR_ACTIONS, 'external_notification_send']),
    deniedActions: set(DENY_ALL_LEVELS_ACTIONS),
  }),
  autonomous: Object.freeze({
    level: 'autonomous',
    automaticActions: new Set([...READ_ACTIONS, ...SANDBOX_ACTIONS, ...REVERSIBLE_GIT_WRITES]),
    // Floors remain floors: autonomous is not unlimited (C027 §25).
    approvalRequiredActions: set([...APPROVAL_FLOOR_ACTIONS, 'external_notification_send']),
    deniedActions: set(DENY_ALL_LEVELS_ACTIONS),
  }),
});

/** Compile/exhaustive guard input for registry coverage tests (C024 fallback). */
export function profileForLevel(level: AutonomyLevel): AutonomyProfile {
  return AUTONOMY_PROFILES[level];
}
