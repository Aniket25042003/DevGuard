import { describe, expect, it } from 'vitest';
import '../errors.js';
import { AgentSessionService } from './agent-session-service.js';
import { InMemoryAgentRuntimePort } from './agent-runtime-port.js';
import { InMemorySessionStore, InMemoryTurnStore, sessionIdForCommand } from './repos.js';
import { resolveSessionEdge, resolveTurnEdge, isTerminalTurn, isTerminalSession } from './fsm.js';
import { TurnEventNormalizer } from './event-normalizer.js';
import {
  buildContext,
  nextCancellationGeneration,
  submitSubAgentTurns,
} from './context-cancellation.js';

const INIT = '2026-08-28T00:00:00.000Z';
const RUN = '9b5d2b1c-1122-4433-a5de-0f0f0f0f0f0f';
const SHA = 'a'.repeat(64);

function setup() {
  const runtime = new InMemoryAgentRuntimePort();
  const sessions = new InMemorySessionStore();
  const turns = new InMemoryTurnStore();
  const service = new AgentSessionService({
    runtime,
    sessions,
    turns,
    agentVersion: '1.0.0',
    clock: { nowIso: () => INIT },
  });
  return { runtime, sessions, turns, service };
}

function ensure(service: AgentSessionService, commandKey = 'cmd-ensure-1') {
  return service.ensureSession({
    workflowRunId: RUN,
    repositoryId: 'repo-1',
    agentDefinitionId: 'ad-1',
    agentVersion: '1.0.0',
    contractSnapshotDigest: SHA,
    commandKey,
  });
}

function turnInput(sessionId: string, commandId = 'cmd-turn-1') {
  return {
    sessionId,
    commandId,
    purpose: 'WORKFLOW' as const,
    workflowObjectiveRef: 'obj-1',
    workflowDefinitionVersion: '1',
    policySnapshotRef: 'pol-1',
    trustContextSnapshotRef: 'trust-1',
    toolProfileId: 'profile-1',
    contextDigest: SHA,
    expectedVersion: 0,
    expectedCancellationGeneration: 0,
  };
}

describe('C037 session/turn FSMs', () => {
  it('follows the session lifecycle and cancels from active states', () => {
    expect(resolveSessionEdge('CREATING', 'ready').allowed).toBe(true);
    expect(resolveSessionEdge('READY', 'turn_active').allowed).toBe(true);
    expect(resolveSessionEdge('TURN_ACTIVE', 'idle').allowed).toBe(true);
    expect(resolveSessionEdge('TURN_ACTIVE', 'cancel').allowed).toBe(true);
    expect(resolveSessionEdge('CANCELLING', 'cancelled').allowed).toBe(true);
    expect(resolveSessionEdge('COMPLETED', 'turn_active').allowed).toBe(false);
    expect(isTerminalSession('CANCELLED')).toBe(true);
  });

  it('follows turn lifecycle with one-active-turn and immutable terminals', () => {
    expect(resolveTurnEdge('REQUESTED', 'submit').allowed).toBe(true);
    expect(resolveTurnEdge('RUNNING', 'pause').allowed).toBe(true);
    expect(resolveTurnEdge('PAUSED', 'resume').allowed).toBe(true);
    expect(resolveTurnEdge('RUNNING', 'succeed').allowed).toBe(true);
    expect(resolveTurnEdge('SUCCEEDED', 'resume').allowed).toBe(false);
    expect(isTerminalTurn('FAILED')).toBe(true);
  });
});

describe('C037 AgentSessionService', () => {
  it('ensures a session idempotently by command key', async () => {
    const { runtime, service } = setup();
    const first = await ensure(service);
    expect(first.providerSessionId).toBe('pf-s1');
    const second = await ensure(service);
    expect(second.sessionId).toBe(first.sessionId);
    expect(runtime.requests).toBe(1);
  });

  it('submits a turn and enforces exactly one active turn per session', async () => {
    const { service } = setup();
    const session = await ensure(service);
    await service.submitTurn(turnInput(session.sessionId, 'cmd-a'));
    await expect(service.submitTurn(turnInput(session.sessionId, 'cmd-b'))).rejects.toMatchObject({
      code: 'SESSION_TURN_ACTIVE',
    });
  });

  it('rejects stale cancellation generations', async () => {
    const { service } = setup();
    const session = await ensure(service);
    await expect(
      service.submitTurn({
        ...turnInput(session.sessionId, 'cmd-x'),
        expectedCancellationGeneration: 5,
      }),
    ).rejects.toMatchObject({ code: 'TURN_GENERATION_STALE' });
  });

  it('replays the same command id idempotently and conflicts on digest mismatch', async () => {
    const { service } = setup();
    const session = await ensure(service);
    const one = await service.submitTurn(turnInput(session.sessionId, 'cmd-idem'));
    const two = await service.submitTurn(turnInput(session.sessionId, 'cmd-idem'));
    expect(two.turnId).toBe(one.turnId);
    await expect(
      service.submitTurn({
        ...turnInput(session.sessionId, 'cmd-idem'),
        contextDigest: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'TURN_COMMAND_DIGEST_CONFLICT' });
  });

  it('requires a linked paused turn for required-action results', async () => {
    const { service } = setup();
    const session = await ensure(service);
    await expect(
      service.submitTurn({
        ...turnInput(session.sessionId, 'cmd-ra'),
        purpose: 'REQUIRED_ACTION_RESULT',
      }),
    ).rejects.toMatchObject({ code: 'REQUIRED_ACTION_RESULT_LINK_REQUIRED' });
  });

  it('observes a terminal/paused turn and reconciles a nonterminal session', async () => {
    const { service, sessions } = setup();
    const session = await ensure(service);
    const turn = await service.submitTurn(turnInput(session.sessionId, 'cmd-obs'));
    const obs = await service.observeTurn({ turnId: turn.turnId });
    expect(obs.observation).toBe('running');
    const reconciled = await service.reconcileSession({ sessionId: session.sessionId });
    expect(reconciled.status).toBe('RECONCILING');
    expect((await sessions.get(session.sessionId))?.status).toBe('RECONCILING');
  });

  it('cancels provider work and fences the active turn', async () => {
    const { service, sessions, turns } = setup();
    const session = await ensure(service);
    const turn = await service.submitTurn(turnInput(session.sessionId, 'cmd-cancel'));
    const current = await sessions.get(session.sessionId);
    expect(current).toBeDefined();
    const cancelled = await service.cancelSession({
      sessionId: session.sessionId,
      expectedVersion: current?.version ?? 0,
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect((await sessions.get(session.sessionId))?.cancellationGeneration).toBe(1);
    expect((await turns.get(turn.turnId))?.status).toBe('CANCELLED');
  });
});

describe('C038 event normalization', () => {
  it('maps known sources to typed turn events and dedupes cursors', async () => {
    const normalizer = new TurnEventNormalizer(new Set(), async () => 0);
    const first = await normalizer.normalize(
      { cursor: 'c1', sourceType: 'delta', status: 'live', text: 'hello', occurredAtIso: INIT },
      'turn-1',
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.event.type).toBe('turn.delta.v1');
    expect(first.event.textDigest).toBeDefined();
    const dup = await normalizer.normalize(
      { cursor: 'c1', sourceType: 'delta', status: 'live', occurredAtIso: INIT },
      'turn-1',
    );
    expect(dup.ok).toBe(false);
    const unknown = await normalizer.normalize(
      { cursor: 'c2', sourceType: 'weird_source', status: 'x', occurredAtIso: INIT },
      'turn-1',
    );
    expect(unknown.reason).toBe('UNKNOWN_SOURCE');
  });
});

describe('C040 context / cancellation / subagents', () => {
  it('assembles context only from trust-labelled refs and fences cancellation generation', () => {
    const context = buildContext([
      { ref: 'r1', digest: SHA, category: 'policy', capturedAtIso: INIT },
      { ref: 'r2', digest: SHA, category: 'repository_instruction', capturedAtIso: INIT },
    ]);
    expect(context.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(nextCancellationGeneration(0)).toBe(1);
    expect(
      submitSubAgentTurns({
        parentSessionId: 's',
        boundaryDigest: SHA,
        toolProfileId: 'p',
        count: 100,
      }),
    ).toBeLessThanOrEqual(8);
  });
});

void sessionIdForCommand;
