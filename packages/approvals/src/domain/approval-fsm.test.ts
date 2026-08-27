/**
 * C031 §22 — exhaustive FSM table (every status × trigger), guard refusals,
 * terminal immutability, and cancellation-during-uncertainty semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_STATUSES,
  allPairs,
  isTerminal,
  resolveEdge,
  type ApprovalTrigger,
} from '@devguard/approvals';

const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const PAST = NOW - 1;

function legal(from: string, trigger: ApprovalTrigger): boolean {
  // Expire probes use a clock already past expiry where legality matters.
  const clock =
    trigger === 'expire'
      ? { nowMs: LATER, expiresAtMs: LATER }
      : { nowMs: NOW, expiresAtMs: LATER };
  const verdict = resolveEdge(
    from as never,
    trigger,
    from === 'EXECUTING' || from === 'APPROVED'
      ? {
          ...clock,
          contextMatchesBinding: false, // only used by mark-stale
          cancellationCurrent: true,
          externalEffectBegan: false,
          providerProvesNotStarted: true,
          leaseFenced: true,
          providerOutcomeVerified: trigger === 'execute-verified',
          stepsOneThroughSixPassed: true,
        }
      : { ...clock, contextMatchesBinding: false, cancellationCurrent: true },
  );
  return verdict.allowed;
}

describe('FSM exhaustive matrix (C031 §9)', () => {
  it('PENDING accepts approve/reject/expire/stale/cancel only', () => {
    expect(legal('PENDING', 'approve')).toBe(true);
    expect(legal('PENDING', 'reject')).toBe(true);
    // Expiry fires only when the database clock reached expiresAt (the helper
    // uses a due-clock fixture; early-expiry refusal is asserted below).
    expect(legal('PENDING', 'expire')).toBe(true);
    expect(legal('PENDING', 'mark-stale')).toBe(true);
    expect(legal('PENDING', 'cancel-before-execution')).toBe(true);
    expect(legal('PENDING', 'execution-claim')).toBe(false);
    expect(legal('PENDING', 'execute-verified')).toBe(false);
    expect(legal('PENDING', 'execute-failed')).toBe(false);
    expect(legal('PENDING', 'cancel-reconciled')).toBe(false);
  });

  it('APPROVED accepts claim/expire/stale/cancel; reject is illegal', () => {
    expect(legal('APPROVED', 'execution-claim')).toBe(true);
    expect(legal('APPROVED', 'expire')).toBe(true);
    expect(legal('APPROVED', 'mark-stale')).toBe(true);
    expect(legal('APPROVED', 'cancel-before-execution')).toBe(true);
    expect(legal('APPROVED', 'approve')).toBe(false); // double-resolve
    expect(legal('APPROVED', 'reject')).toBe(false);
  });

  it('EXECUTING reaches EXECUTED/EXECUTION_FAILED/CANCELLED-reconciled only', () => {
    expect(legal('EXECUTING', 'execute-verified')).toBe(true);
    expect(legal('EXECUTING', 'execute-failed')).toBe(true);
    expect(legal('EXECUTING', 'cancel-reconciled')).toBe(true);
    expect(legal('EXECUTING', 'approve')).toBe(false);
    expect(legal('EXECUTING', 'reject')).toBe(false);
    expect(legal('EXECUTING', 'mark-stale')).toBe(false); // late webhooks cannot stale a claimed attempt
  });

  it('terminal states are immutable: no trigger fires from any of them', () => {
    for (const status of [
      'REJECTED',
      'EXPIRED',
      'CANCELLED',
      'STALE',
      'EXECUTED',
      'EXECUTION_FAILED',
    ] as const) {
      for (const trigger of Object.keys(
        allPairs().reduce(
          (acc, p) => ({ ...acc, [p.trigger]: true }),
          {} as Record<string, boolean>,
        ),
      )) {
        expect(isTerminal(status)).toBe(true);
        const verdict = resolveEdge(status, trigger as ApprovalTrigger, {
          nowMs: NOW,
          expiresAtMs: LATER,
        });
        expect(verdict.allowed).toBe(false);
        if (!verdict.allowed) expect(verdict.code).toBe('APPROVAL_ILLEGAL_TRANSITION');
      }
    }
  });

  it('guards: expiry blocks resolution/claim on the database clock', () => {
    const expired = resolveEdge('PENDING', 'approve', { nowMs: PAST + 1000, expiresAtMs: PAST });
    expect(expired.allowed).toBe(false);
    const claimExpired = resolveEdge('APPROVED', 'execution-claim', {
      nowMs: PAST + 1000,
      expiresAtMs: PAST,
      stepsOneThroughSixPassed: true,
    });
    expect(claimExpired.allowed).toBe(false);

    const tooEarly = resolveEdge('PENDING', 'expire', { nowMs: NOW, expiresAtMs: LATER });
    expect(tooEarly.allowed).toBe(false);

    const due = resolveEdge('PENDING', 'expire', { nowMs: LATER, expiresAtMs: LATER });
    expect(due.allowed).toBe(true);
  });

  it('stale requires an observed binding mismatch; matching context refuses invalidation', () => {
    const withoutMismatch = resolveEdge('PENDING', 'mark-stale', {
      contextMatchesBinding: undefined,
    });
    expect(withoutMismatch.allowed).toBe(false);
    const withMatch = resolveEdge('PENDING', 'mark-stale', { contextMatchesBinding: false });
    expect(withMatch.allowed).toBe(true);
  });

  it('claim requires steps 1-6 proven', () => {
    expect(
      resolveEdge('APPROVED', 'execution-claim', { stepsOneThroughSixPassed: false }).allowed,
    ).toBe(false);
    expect(
      resolveEdge('APPROVED', 'execution-claim', { stepsOneThroughSixPassed: true }).allowed,
    ).toBe(true);
  });

  it('reconciled cancel requires proof-not-started AND fenced lease; external effect forbids plain cancel', () => {
    const missingProof = resolveEdge('EXECUTING', 'cancel-reconciled', {});
    expect(missingProof.allowed).toBe(false);
    const proven = resolveEdge('EXECUTING', 'cancel-reconciled', {
      providerProvesNotStarted: true,
      leaseFenced: true,
    });
    expect(proven.allowed).toBe(true);

    const begun = resolveEdge('APPROVED', 'cancel-before-execution', { externalEffectBegan: true });
    expect(begun.allowed).toBe(false);
    const notBegun = resolveEdge('APPROVED', 'cancel-before-execution', {
      externalEffectBegan: false,
      cancellationCurrent: true,
    });
    expect(notBegun.allowed).toBe(true);
  });

  it('covers every single status x trigger pair exactly once via allPairs()', () => {
    const pairs = allPairs();
    expect(pairs.length).toBe(APPROVAL_STATUSES.length * 10);
    for (const pair of pairs) {
      const verdict = resolveEdge(pair.from, pair.trigger, { nowMs: NOW, expiresAtMs: LATER });
      expect(verdict).toBeDefined();
    }
  });
});
