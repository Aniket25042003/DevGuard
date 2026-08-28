/**
 * C014 §22 — pure health/readiness state-machine tests.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateHealthTransition,
  evaluateReadiness,
  type HealthTransitionEvidence,
} from './state-machine.js';

function evidence(overrides: Partial<HealthTransitionEvidence> = {}): HealthTransitionEvidence {
  return {
    lifecycleConnected: false,
    lifecycleDegraded: false,
    lifecycleDisconnected: false,
    requiredPermissionsMet: false,
    defaultBranchResolved: false,
    criticalMetadataFresh: false,
    providerReachable: false,
    providerUnreachable: false,
    ...overrides,
  };
}

const fullyHealthy: HealthTransitionEvidence = evidence({
  lifecycleConnected: true,
  requiredPermissionsMet: true,
  defaultBranchResolved: true,
  criticalMetadataFresh: true,
  providerReachable: true,
});

describe('evaluateHealthTransition (C014 §9)', () => {
  it('allows healthy only when every C014 guard is met', () => {
    expect(evaluateHealthTransition('healthy', fullyHealthy)).toEqual({
      allowed: true,
      target: 'healthy',
    });
  });

  it('rejects healthy when a hard guard is unmet (never invents health)', () => {
    expect(evaluateHealthTransition('healthy', evidence({ lifecycleConnected: true }))).toEqual({
      allowed: false,
      reason: 'GUARD_UNMET',
    });
    expect(
      evaluateHealthTransition('healthy', { ...fullyHealthy, requiredPermissionsMet: false }),
    ).toEqual({ allowed: false, reason: 'GUARD_UNMET' });
  });

  it('allows unavailable only on provider-unreachable or disconnected lifecycle', () => {
    expect(
      evaluateHealthTransition('unavailable', evidence({ providerUnreachable: true })),
    ).toEqual({ allowed: true, target: 'unavailable' });
    expect(
      evaluateHealthTransition('unavailable', evidence({ lifecycleDisconnected: true })),
    ).toEqual({ allowed: true, target: 'unavailable' });
    expect(evaluateHealthTransition('unavailable', evidence())).toEqual({
      allowed: false,
      reason: 'GUARD_UNMET',
    });
  });

  it('allows degraded on any observable provider reach or degraded lifecycle', () => {
    expect(evaluateHealthTransition('degraded', evidence({ providerReachable: true }))).toEqual({
      allowed: true,
      target: 'degraded',
    });
    expect(evaluateHealthTransition('degraded', evidence({ lifecycleDegraded: true }))).toEqual({
      allowed: true,
      target: 'degraded',
    });
    expect(evaluateHealthTransition('degraded', evidence())).toEqual({
      allowed: false,
      reason: 'NO_EVIDENCE',
    });
  });

  it('allows unknown only while no evidence exists', () => {
    expect(evaluateHealthTransition('unknown', evidence())).toEqual({
      allowed: true,
      target: 'unknown',
    });
    expect(evaluateHealthTransition('unknown', evidence({ providerReachable: true }))).toEqual({
      allowed: false,
      reason: 'CONTRADICTS_EVIDENCE',
    });
  });
});

describe('evaluateReadiness (C014 §9)', () => {
  it('maps unknown and unavailable to blocked', () => {
    expect(evaluateReadiness('unknown', evidence())).toBe('blocked');
    expect(evaluateReadiness('unavailable', evidence({ providerUnreachable: true }))).toBe(
      'blocked',
    );
  });

  it('maps degraded to read_only (advisory reads allowed)', () => {
    expect(evaluateReadiness('degraded', evidence({ providerReachable: true }))).toBe('read_only');
  });

  it('maps healthy to ready only when read/mutation prerequisites hold', () => {
    expect(evaluateReadiness('healthy', fullyHealthy)).toBe('ready');
    expect(evaluateReadiness('healthy', { ...fullyHealthy, criticalMetadataFresh: false })).toBe(
      'read_only',
    );
    expect(evaluateReadiness('healthy', { ...fullyHealthy, defaultBranchResolved: false })).toBe(
      'blocked',
    );
  });
});
