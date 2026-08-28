/**
 * C041 §22 — exhaustive FSM tests for the workspace lifecycle.
 *
 * Verifies every legal (from, trigger) edge, that missing/absent guards fail
 * closed, that terminal states reject all transitions, and that unknown edges
 * are rejected rather than silently tolerated.
 */
import { describe, expect, it } from 'vitest';
import {
  isTerminalWorkspace,
  resolveWorkspaceEdge,
  transitionWorkspace,
  workspaceCleanupRequired,
  WORKSPACE_STATUSES,
  WORKSPACE_TERMINAL_STATUSES,
  type WorkspaceStatus,
  type WorkspaceTransitionGuards,
  type WorkspaceTrigger,
} from './fsm.js';

type Cell = {
  readonly from: WorkspaceStatus;
  readonly trigger: WorkspaceTrigger;
  readonly guards: WorkspaceTransitionGuards;
  readonly to: WorkspaceStatus;
};

const fullGuards: WorkspaceTransitionGuards = {
  fenceValid: true,
  capabilitiesVerified: true,
  providerWorkspaceCreated: true,
  safeCheckoutApplied: true,
  headMatchesResolvedSha: true,
  remoteIdentityVerified: true,
  attestationComplete: true,
  verificationFailed: true,
  failureKnown: true,
  providerAmbiguity: true,
  providerProvesDestroyed: true,
  cleanupAttemptsExhausted: true,
};

describe('workspace FSM legal edges (C041 §9)', () => {
  const legal: Cell[] = [
    {
      from: 'REQUESTED',
      trigger: 'begin-provisioning',
      guards: { fenceValid: true, capabilitiesVerified: true },
      to: 'PROVISIONING',
    },
    {
      from: 'PROVISIONING',
      trigger: 'provision-complete',
      guards: { fenceValid: true, providerWorkspaceCreated: true },
      to: 'CHECKING_OUT',
    },
    {
      from: 'CHECKING_OUT',
      trigger: 'checkout-complete',
      guards: { fenceValid: true, safeCheckoutApplied: true },
      to: 'VERIFYING',
    },
    {
      from: 'VERIFYING',
      trigger: 'verify-ok',
      guards: {
        fenceValid: true,
        headMatchesResolvedSha: true,
        remoteIdentityVerified: true,
        attestationComplete: true,
      },
      to: 'READY',
    },
    {
      from: 'VERIFYING',
      trigger: 'verify-fail',
      guards: { verificationFailed: true },
      to: 'QUARANTINED',
    },
    {
      from: 'REQUESTED',
      trigger: 'fail',
      guards: { failureKnown: true, fenceValid: true },
      to: 'FAILED',
    },
    {
      from: 'PROVISIONING',
      trigger: 'fail',
      guards: { cancellationRequested: true, failureKnown: true },
      to: 'FAILED',
    },
    {
      from: 'CHECKING_OUT',
      trigger: 'fail',
      guards: { failureKnown: true, fenceValid: true },
      to: 'FAILED',
    },
    {
      from: 'VERIFYING',
      trigger: 'fail',
      guards: { failureKnown: true, fenceValid: true },
      to: 'FAILED',
    },
    {
      from: 'PROVISIONING',
      trigger: 'quarantine',
      guards: { providerAmbiguity: true },
      to: 'QUARANTINED',
    },
    {
      from: 'CHECKING_OUT',
      trigger: 'quarantine',
      guards: { providerAmbiguity: true },
      to: 'QUARANTINED',
    },
    {
      from: 'VERIFYING',
      trigger: 'quarantine',
      guards: { providerAmbiguity: true },
      to: 'QUARANTINED',
    },
    {
      from: 'DESTROYING',
      trigger: 'quarantine',
      guards: { providerAmbiguity: true, cleanupAttemptsExhausted: true },
      to: 'QUARANTINED',
    },
    { from: 'REQUESTED', trigger: 'begin-destroy', guards: { fenceValid: true }, to: 'DESTROYING' },
    {
      from: 'READY',
      trigger: 'begin-destroy',
      guards: { cancellationRequested: true },
      to: 'DESTROYING',
    },
    { from: 'FAILED', trigger: 'begin-destroy', guards: { fenceValid: true }, to: 'DESTROYING' },
    {
      from: 'QUARANTINED',
      trigger: 'begin-destroy',
      guards: { cancellationRequested: true },
      to: 'DESTROYING',
    },
    {
      from: 'DESTROYING',
      trigger: 'destroy-confirmed',
      guards: { providerProvesDestroyed: true },
      to: 'DESTROYED',
    },
    {
      from: 'DESTROYING',
      trigger: 'destroy-uncertain',
      guards: { cleanupAttemptsExhausted: true },
      to: 'QUARANTINED',
    },
  ];

  it.each(legal)('allows $from --$trigger--> $to', ({ from, trigger, guards, to }) => {
    const verdict = resolveWorkspaceEdge(from, trigger, guards);
    expect(verdict.allowed).toBe(true);
    expect(verdict.to).toBe(to);
    expect(transitionWorkspace(from, trigger, guards)).toBe(to);
  });

  it('covers at least one edge for every non-terminal status', () => {
    const covered = new Set(WORKSPACE_STATUSES.filter((s) => !isTerminalWorkspace(s)));
    for (const { from } of legal) covered.delete(from);
    expect([...covered]).toEqual([]);
  });
});

describe('workspace FSM fails closed on missing guards (C041 §9)', () => {
  it.each([
    ['begin-provisioning', 'REQUESTED', {}],
    ['begin-provisioning', 'REQUESTED', { fenceValid: true }], // no capability proof
    ['provision-complete', 'PROVISIONING', { fenceValid: true }], // no creation proof
    ['verify-ok', 'VERIFYING', {}], // READY must not occur without every guard
    ['verify-ok', 'VERIFYING', { headMatchesResolvedSha: true }], // partial evidence insufficient
    ['destroy-confirmed', 'DESTROYING', {}], // provider must prove absence
  ] as Array<[WorkspaceTrigger, WorkspaceStatus, WorkspaceTransitionGuards]>)(
    'rejects %s from %s when guards are missing',
    (trigger, from, guards) => {
      const verdict = resolveWorkspaceEdge(from, trigger, guards);
      expect(verdict.allowed).toBe(false);
      expect(() => transitionWorkspace(from, trigger, guards)).toThrowError(
        /WORKSPACE_ILLEGAL_TRANSITION/,
      );
    },
  );
});

describe('workspace FSM rejects unknown/illegal edges (C041 §9)', () => {
  it.each([
    ['READY', 'fail'],
    ['READY', 'verify-ok'],
    ['DESTROYED', 'begin-destroy'],
    ['REQUESTED', 'destroy-confirmed'],
    ['VERIFYING', 'provision-complete'],
  ] as Array<[WorkspaceStatus, WorkspaceTrigger]>)(
    'rejects illegal %s --%s-->',
    (from, trigger) => {
      const verdict = resolveWorkspaceEdge(from, trigger, fullGuards);
      expect(verdict.allowed).toBe(false);
      expect(() => transitionWorkspace(from, trigger, fullGuards)).toThrowError(
        /WORKSPACE_ILLEGAL_TRANSITION/,
      );
    },
  );
});

describe('workspace terminal & cleanup semantics (C041 §9)', () => {
  it('DESTROYED is the only terminal status', () => {
    expect(WORKSPACE_TERMINAL_STATUSES).toEqual(['DESTROYED']);
    for (const status of WORKSPACE_STATUSES) {
      expect(isTerminalWorkspace(status)).toBe(status === 'DESTROYED');
    }
  });

  it('FAILED and QUARANTINED require durable cleanup; DESTROYED does not', () => {
    expect(workspaceCleanupRequired('FAILED')).toBe(true);
    expect(workspaceCleanupRequired('QUARANTINED')).toBe(true);
    expect(workspaceCleanupRequired('DESTROYED')).toBe(false);
    expect(workspaceCleanupRequired('READY')).toBe(false);
  });
});
