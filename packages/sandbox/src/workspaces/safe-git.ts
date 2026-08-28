/**
 * C041 §15/§16/§17 — safe bootstrap checkout policy.
 *
 * This module produces and validates a provider-neutral CHECKOUT PLAN as
 * DATA. Nothing here spawns processes or touches a filesystem: the plan is
 * handed to the TrueForge workspace port, whose adapter binds these
 * directives to the provider's own Git transport under contract tests. The
 * DevGuard host never checks out a repository (invariant enforced by
 * `assertNoHostCheckout`, which fails closed).
 *
 * Safety surface per §16/§17: allowlisted https transport only (github.com),
 * exact immutable SHA only, hooks/filters/credential helpers/submodules/LFS
 * disabled, credentials are in-memory provider references, and anything else
 * is rejected before provisioning.
 */
import { makeError, validationFailed } from '@devguard/errors';
import { FULL_SHA_PATTERN } from './selector.js';

/** Git -c directives that must be applied to every checkout (empty = disabled). */
export const SAFE_GIT_DIRECTIVES: ReadonlyArray<{ readonly key: string; readonly value: string }> =
  Object.freeze([
    // No hooks may run during fetch/checkout; empty directives disable.
    { key: 'core.hooksPath', value: '' },
    // No external filters (attributes-driven programs) may materialize content.
    { key: 'filter.lfs.required', value: 'false' },
    { key: 'filter.lfs.process', value: '' },
    { key: 'filter.lfs.smudge', value: '' },
    // No credential helpers — credentials arrive as in-memory provider secrets.
    { key: 'credential.helper', value: '' },
    // No recursive submodule fetching; submodules stay blocked for MVP.
    { key: 'submodule.recurse', value: 'false' },
    // Transport allowlist: only https is permitted; everything else is rejected.
    { key: 'protocol.allow', value: 'never' },
    { key: 'protocol.https.allow', value: 'always' },
    // Deterministic checkout output.
    { key: 'core.autocrlf', value: 'false' },
  ]);

/** The only transport/host combination accepted for an execution checkout. */
export const ALLOWED_CHECKOUT_HOST = 'github.com';

export type CheckoutExecution = 'native' | 'sandboxed_git';
export type FetchPolicy = 'exact_sha';
export type SubmodulePolicy = 'blocked';
export type LfsPolicy = 'blocked';

export interface SafeCheckoutPlan {
  readonly repositoryId: string;
  readonly remoteFingerprint: string;
  /** Exact immutable object ID; mutable selectors never reach the plan. */
  readonly sha: string;
  /**
   * How the provider materializes the repository: verified native checkout or
   * Git executed by C042 inside the sandbox under a C043 bootstrap profile.
   * The DevGuard host is never an execution location.
   */
  readonly execution: CheckoutExecution;
  readonly transport: 'https_allowlist';
  readonly credentials: 'in_memory_provider_secret';
  /** Invariant: a host filesystem checkout is structurally impossible. */
  readonly hostFilesystem: false;
  readonly fetchPolicy: FetchPolicy;
  readonly submodulePolicy: SubmodulePolicy;
  readonly lfsPolicy: LfsPolicy;
  readonly directives: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

export interface SafeCheckoutPlanInput {
  readonly repositoryId: string;
  readonly remoteFingerprint: string;
  readonly sha: string;
  readonly execution: CheckoutExecution;
}

const FINGERPRINT_PATTERN = /^github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * Build and validate the checkout plan for a resolved, immutable SHA. Any
 * mutable selector, non-github remote, or unsupported execution mode is
 * rejected here — before any provider call.
 */
export function buildSafeCheckoutPlan(input: SafeCheckoutPlanInput): SafeCheckoutPlan {
  const issues: Array<{ path: string; constraint: string }> = [];
  if (!/^[0-9a-z-]{1,64}$/i.test(input.repositoryId ?? '')) {
    issues.push({ path: 'repositoryId', constraint: 'unexpected repository identity shape' });
  }
  if (!FULL_SHA_PATTERN.test(input.sha ?? '')) {
    issues.push({ path: 'sha', constraint: 'checkout requires a full immutable commit id' });
  }
  if (!FINGERPRINT_PATTERN.test(input.remoteFingerprint ?? '')) {
    issues.push({
      path: 'remoteFingerprint',
      constraint: `only ${ALLOWED_CHECKOUT_HOST} remotes are permitted (https allowlist)`,
    });
  }
  if (input.execution !== 'native' && input.execution !== 'sandboxed_git') {
    issues.push({ path: 'execution', constraint: 'unknown checkout execution mode' });
  }
  if (issues.length > 0) {
    throw validationFailed(issues);
  }
  return Object.freeze({
    repositoryId: input.repositoryId,
    remoteFingerprint: input.remoteFingerprint,
    sha: input.sha,
    execution: input.execution,
    transport: 'https_allowlist',
    credentials: 'in_memory_provider_secret',
    hostFilesystem: false,
    fetchPolicy: 'exact_sha',
    submodulePolicy: 'blocked',
    lfsPolicy: 'blocked',
    directives: SAFE_GIT_DIRECTIVES,
  } satisfies SafeCheckoutPlan);
}

/**
 * Structural invariant guard: any plan that could touch the DevGuard host
 * filesystem is a security event, not an execution fallback (C041 §2/§25).
 */
export function assertNoHostCheckout(plan: SafeCheckoutPlan): void {
  if (plan.hostFilesystem !== false) {
    throw makeError('SANDBOX_HOST_EXECUTION_BLOCKED', {
      details: { operation: 'host checkout' },
    });
  }
}
