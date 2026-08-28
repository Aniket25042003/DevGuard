import { describe, expect, it } from 'vitest';
import {
  allCompatibilityPairs,
  COMPATIBILITY_STATUSES,
  isOperational,
  OPERATIONAL_STATUSES,
  resolveEdge,
  verdictToStatus,
} from './compatibility.js';

describe('C036 compatibility FSM', () => {
  it('allows begin_verify from UNVERIFIED, INCOMPATIBLE, UNAVAILABLE, DEGRADED', () => {
    for (const from of ['UNVERIFIED', 'INCOMPATIBLE', 'UNAVAILABLE', 'DEGRADED'] as const) {
      const verdict = resolveEdge(from, 'begin_verify');
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) expect(verdict.to).toBe('VERIFYING');
    }
  });

  it('refuses begin_verify from VERIFYING, COMPATIBLE', () => {
    for (const from of ['VERIFYING', 'COMPATIBLE'] as const) {
      expect(resolveEdge(from, 'begin_verify').allowed).toBe(false);
    }
  });

  it('requires persisted verification evidence for verified_* transitions', () => {
    const verdict = resolveEdge('VERIFYING', 'verified_compatible');
    expect(verdict.allowed).toBe(false);
    expect(
      resolveEdge('VERIFYING', 'verified_compatible', { verificationRunId: 'a'.repeat(64) })
        .allowed,
    ).toBe(true);
  });

  it('accepts verified outcomes only from VERIFYING', () => {
    const evidence = { verificationRunId: 'a'.repeat(64) };
    for (const status of COMPATIBILITY_STATUSES) {
      if (status === 'VERIFYING') {
        expect(resolveEdge(status, 'verified_compatible', evidence).allowed).toBe(true);
        expect(resolveEdge(status, 'verified_degraded', evidence).allowed).toBe(true);
        expect(resolveEdge(status, 'verified_incompat', evidence).allowed).toBe(true);
      } else {
        expect(resolveEdge(status, 'verified_incompat', evidence).allowed).toBe(false);
      }
    }
  });

  it('maps drift: COMPATIBLE->DEGRADED->INCOMPATIBLE and COMPATIBLE->INCOMPATIBLE', () => {
    const evidence = { verificationRunId: 'a'.repeat(64) };
    const degraded = resolveEdge('COMPATIBLE', 'drift_degraded', evidence);
    expect(degraded.allowed).toBe(true);
    if (degraded.allowed) expect(degraded.to).toBe('DEGRADED');
    const both = resolveEdge('COMPATIBLE', 'drift_incompat', evidence);
    expect(both.allowed).toBe(true);
    if (both.allowed) expect(both.to).toBe('INCOMPATIBLE');
  });

  it('unavailable degrades an operational COMPATIBLE runtime and returns VERIFYING to UNAVAILABLE', () => {
    const evidence = { verificationRunId: 'a'.repeat(64) };
    const verifying = resolveEdge('VERIFYING', 'unavailable', evidence);
    expect(verifying.allowed).toBe(true);
    const compat = resolveEdge('COMPATIBLE', 'unavailable', evidence);
    expect(compat.allowed).toBe(true);
    if (compat.allowed) expect(compat.to).toBe('DEGRADED');
  });

  it('isOperational holds only for COMPATIBLE and DEGRADED', () => {
    for (const status of COMPATIBILITY_STATUSES) {
      expect(isOperational(status)).toBe(OPERATIONAL_STATUSES.includes(status));
    }
    expect(isOperational('COMPATIBLE')).toBe(true);
    expect(isOperational('INCOMPATIBLE')).toBe(false);
  });

  it('maps verdicts to status monotonically', () => {
    expect(verdictToStatus('COMPATIBLE')).toBe('COMPATIBLE');
    expect(verdictToStatus('DEGRADED')).toBe('DEGRADED');
    expect(verdictToStatus('INCOMPATIBLE')).toBe('INCOMPATIBLE');
  });

  it('every status x trigger pair resolves deterministically', () => {
    const seen: string[] = [];
    for (const pair of allCompatibilityPairs()) {
      const verdict = resolveEdge(pair.from, pair.trigger, {
        verificationRunId: 'a'.repeat(64),
      });
      expect(verdict.allowed).toBeTypeOf('boolean');
      seen.push(`${pair.from}:${pair.trigger}`);
    }
    expect(new Set(seen).size).toBe(seen.length);
  });
});
