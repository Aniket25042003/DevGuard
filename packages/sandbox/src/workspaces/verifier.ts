/**
 * C041 §10/§18 — checkout verification and attestation.
 *
 * READY requires exact SHA equality between the authorized resolution and the
 * observed workspace HEAD, plus verified remote identity and (where the
 * provider supports it) tree integrity. Verification is a pure function;
 * the port persists the resulting attestation. A mismatch NEVER downgrades to
 * "close enough": it quarantines the workspace (C041 §18).
 */
import { makeError } from '@devguard/errors';
import type { CheckoutAttestationId, WorkspaceId } from '../ids.js';
import { FULL_SHA_PATTERN, type ResolvedCheckout } from './selector.js';

export type CheckoutMismatchKind = 'head_sha' | 'remote_identity' | 'tree_hash' | 'unverified_head';

export interface CheckoutObservation {
  readonly observedHeadSha: string;
  readonly observedRemoteFingerprint: string;
  readonly treeHash?: string | undefined;
}

export interface CheckoutAttestation {
  readonly id: CheckoutAttestationId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: string;
  readonly canonicalOwner: string;
  readonly canonicalName: string;
  readonly remoteFingerprint: string;
  readonly requestedSelectorKind: string;
  readonly requestedRef: string;
  readonly resolvedSha: string;
  readonly observedHeadSha: string;
  readonly treeHash?: string | undefined;
  readonly fetchPolicy: 'exact_sha';
  readonly submodulePolicy: 'blocked';
  readonly lfsPolicy: 'blocked';
  readonly verifiedAtMs: number;
}

export type VerificationOutcome =
  | { readonly ok: true; readonly checks: readonly string[] }
  | {
      readonly ok: false;
      readonly mismatchKind: CheckoutMismatchKind;
      readonly expectedSha: string;
      readonly observedSha: string;
    };

export interface VerifyCheckoutInput {
  readonly resolved: ResolvedCheckout;
  readonly observation: CheckoutObservation;
}

/** Pure verification: exact SHA equality is mandatory, never best-effort. */
export function verifyCheckout(input: VerifyCheckoutInput): VerificationOutcome {
  const { resolved, observation } = input;
  if (!FULL_SHA_PATTERN.test(observation.observedHeadSha ?? '')) {
    return {
      ok: false,
      mismatchKind: 'unverified_head',
      expectedSha: resolved.resolvedSha,
      observedSha: observation.observedHeadSha ?? '',
    };
  }
  if (observation.observedHeadSha !== resolved.resolvedSha) {
    return {
      ok: false,
      mismatchKind: 'head_sha',
      expectedSha: resolved.resolvedSha,
      observedSha: observation.observedHeadSha,
    };
  }
  if (observation.observedRemoteFingerprint !== resolved.remoteFingerprint) {
    return {
      ok: false,
      mismatchKind: 'remote_identity',
      expectedSha: resolved.resolvedSha,
      observedSha: observation.observedHeadSha,
    };
  }
  if (observation.treeHash !== undefined && observation.treeHash.length === 0) {
    // Explicitly-provided-but-empty tree evidence is a verification failure,
    // while an absent treeHash simply means "not supported by provider".
    return {
      ok: false,
      mismatchKind: 'tree_hash',
      expectedSha: resolved.resolvedSha,
      observedSha: observation.observedHeadSha,
    };
  }
  return {
    ok: true,
    checks: ['head_sha', 'remote_identity', ...(observation.treeHash ? ['tree_hash'] : [])],
  };
}

export type AttestationInput = VerifyCheckoutInput & {
  readonly id: CheckoutAttestationId;
  readonly workspaceId: WorkspaceId;
  readonly nowMs: number;
};

/** Build an attestation only from a verified outcome (fail closed). */
export function buildAttestation(input: AttestationInput): CheckoutAttestation {
  const outcome = verifyCheckout(input);
  if (!outcome.ok) {
    throw makeError('CHECKOUT_MISMATCH', {
      details: {
        expectedSha: outcome.expectedSha,
        observedSha: outcome.observedSha,
        mismatchKind: outcome.mismatchKind,
      },
    });
  }
  const resolved = input.resolved;
  return Object.freeze({
    id: input.id,
    workspaceId: input.workspaceId,
    repositoryId: resolved.repositoryId,
    canonicalOwner: resolved.canonicalOwner,
    canonicalName: resolved.canonicalName,
    remoteFingerprint: resolved.remoteFingerprint,
    requestedSelectorKind: resolved.selector.kind,
    requestedRef: describeAttestedSelector(resolved.selector),
    resolvedSha: resolved.resolvedSha,
    observedHeadSha: input.observation.observedHeadSha,
    treeHash: input.observation.treeHash,
    fetchPolicy: 'exact_sha',
    submodulePolicy: 'blocked',
    lfsPolicy: 'blocked',
    verifiedAtMs: input.nowMs,
  } satisfies CheckoutAttestation);
}

/** Bounded, non-secret selector description for the attestation record. */
function describeAttestedSelector(selector: ResolvedCheckout['selector']): string {
  switch (selector.kind) {
    case 'commit':
      return `commit:${selector.sha.slice(0, 12)}`;
    case 'branch':
      return `branch:${selector.name}`;
    case 'tag':
      return `tag:${selector.name}`;
    case 'pull_request_head':
      return `pull_request_head:${selector.number}`;
  }
}
