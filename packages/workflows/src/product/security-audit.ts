/**
 * C051 — `security_audit` product workflow definition.
 *
 * Provider-neutral, NON-MUTATING security assessment against an immutable
 * repository ref in a TrueForge sandbox, with reproducible provenance and a
 * truthful report suitable for the later C052 patch workflow. No code
 * mutation/merge/finding-dismissal; never claims coverage a scanner did not
 * provide. Findings are untrusted provider output requiring schema/path/output
 * validation.
 */
export const SECURITY_AUDIT_DEFINITION_ID = 'security_audit';
export const SECURITY_AUDIT_DEFINITION_VERSION = '1.0.0';

export interface AuditStep {
  readonly id: string;
  readonly kind: 'turn' | 'validator' | 'command' | 'published';
  readonly actionTypes: readonly string[];
  readonly maxRetries: number;
  readonly maxWallMillis: number;
  readonly failureBehavior: 'fail_run' | 'stop';
  readonly validatorIds: readonly string[];
}

export const SECURITY_AUDIT_STEPS: readonly AuditStep[] = [
  {
    id: 'resolve_ref',
    kind: 'turn',
    actionTypes: ['action:repo_read'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_immutable_ref'],
  },
  {
    id: 'security_profile',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_profile'],
  },
  {
    id: 'select_scanners',
    kind: 'turn',
    actionTypes: ['action:scanner_select'],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'stop',
    validatorIds: ['v_scanner_eligibility'],
  },
  {
    id: 'scan',
    kind: 'command',
    actionTypes: ['action:sandbox_scan'],
    maxRetries: 1,
    maxWallMillis: 900_000,
    failureBehavior: 'stop',
    validatorIds: ['v_scan_coverage'],
  },
  {
    id: 'normalize',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_finding_normalize'],
  },
  {
    id: 'finding_identity',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_finding_dedupe'],
  },
  {
    id: 'baseline_compare',
    kind: 'validator',
    actionTypes: [],
    maxRetries: 1,
    maxWallMillis: 60_000,
    failureBehavior: 'fail_run',
    validatorIds: ['v_baseline'],
  },
  {
    id: 'report',
    kind: 'published',
    actionTypes: ['action:report_publish'],
    maxRetries: 1,
    maxWallMillis: 120_000,
    failureBehavior: 'fail_run',
    validatorIds: [],
  },
];

export const SECURITY_AUDIT_ALLOWED_ACTIONS: readonly string[] = [
  'action:repo_read',
  'action:scanner_select',
  'action:sandbox_scan',
  'action:report_publish',
];

export type DefinitionValidation =
  { readonly ok: true } | { readonly ok: false; readonly violation: string };

export function validateDefinition(): DefinitionValidation {
  if (SECURITY_AUDIT_STEPS.length === 0) return { ok: false, violation: 'empty steps' };
  for (const step of SECURITY_AUDIT_STEPS) {
    if (step.maxRetries > 8) return { ok: false, violation: `retries ${step.id}` };
    if (step.maxWallMillis <= 0 || step.maxWallMillis > 24 * 60 * 60_000)
      return { ok: false, violation: `wall ${step.id}` };
    for (const action of step.actionTypes)
      if (!SECURITY_AUDIT_ALLOWED_ACTIONS.includes(action))
        return { ok: false, violation: `unallowed action ${action}` };
  }
  // Non-mutating: report publish is the ONLY published step and no mutative
  // action type (commit/push/merge) is allowed.
  if (
    !SECURITY_AUDIT_ALLOWED_ACTIONS.every(
      (a) => a !== 'action:commit' && a !== 'action:push_branch' && a !== 'action:merge_pr',
    )
  ) {
    return { ok: false, violation: 'audit must be non-mutating' };
  }
  return { ok: true };
}

export const securityAuditDefinition = {
  id: SECURITY_AUDIT_DEFINITION_ID,
  semanticVersion: SECURITY_AUDIT_DEFINITION_VERSION,
  status: 'ACTIVE',
  enabled: true,
  steps: SECURITY_AUDIT_STEPS,
  allowedActionTypes: SECURITY_AUDIT_ALLOWED_ACTIONS,
  requiredCapabilities: ['cap:trueforge_agent', 'cap:sandbox_exec'],
  artifactDeclarations: ['findings', 'audit_report'],
  skillBundleRefs: ['skill:core@1'],
  compatibilityRange: '>=1.0.0',
} as const;
