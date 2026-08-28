import { describe, expect, it } from 'vitest';
import {
  agentSessionRefSchema,
  agentTurnRefSchema,
  createAgentSessionInputSchema,
  createAgentTurnInputSchema,
  requiredActionResultSchema,
  cancelRuntimeWorkSchema,
  runtimeEventKindSchema,
  KNOWN_PROVIDERS,
  isKnownProvider,
} from './contracts.js';

const SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const TURN_ID = '9d5b2b1c-1122-4433-a5de-0f0f0f0f0f0f';
const OPERATION_KEY = 'e1f2a3b4-0000-4000-8000-123456789abc';
const PROVIDER_SESSION = 'tf_node_abc123';
const PROVIDER_TURN = 'tf_turn_xyz789';

function sessionRef(): Record<string, unknown> {
  return {
    provider: 'trueforge',
    sessionId: SESSION_ID,
    providerSessionId: PROVIDER_SESSION,
    version: 0,
  };
}

function turnRef(): Record<string, unknown> {
  return {
    provider: 'trueforge',
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    providerTurnId: PROVIDER_TURN,
    version: 0,
  };
}

describe('C036 runtime contract schemas', () => {
  it('accepts a well-formed session ref', () => {
    const parsed = agentSessionRefSchema.parse(sessionRef());
    expect(parsed.version).toBe(0);
    expect(parsed.provider).toBe('trueforge');
  });

  it('rejects an unknown provider label', () => {
    expect(() =>
      agentSessionRefSchema.parse({ ...sessionRef(), provider: 'notatrueforge' }),
    ).toThrow();
  });

  it('rejects extra keys on refs (strict boundary)', () => {
    expect(() => agentSessionRefSchema.parse({ ...sessionRef(), extra: true })).toThrow();
    expect(() => agentTurnRefSchema.parse({ ...turnRef(), extra: true })).toThrow();
  });

  it('accepts a well-formed create turn input and rejects unknown keys', () => {
    const good = {
      operationKey: OPERATION_KEY,
      sessionRef: sessionRef(),
      deadlineMs: 30_000,
    };
    expect(createAgentTurnInputSchema.parse(good).deadlineMs).toBe(30_000);
    expect(() => createAgentTurnInputSchema.parse({ ...good, nope: 1 })).toThrow();
    expect(() => createAgentTurnInputSchema.parse({ ...good, deadlineMs: 0 })).toThrow();
  });

  it('accepts create session input and binds operation key', () => {
    const good = {
      operationKey: OPERATION_KEY,
      deadlineMs: 45_000,
    };
    expect(createAgentSessionInputSchema.parse(good).operationKey).toBe(OPERATION_KEY);
  });

  it('validates required action results and rejects invalid outcomes', () => {
    const good = {
      turnRef: turnRef(),
      requiredActionId: 'a1b2c3d4-0000-4000-8000-000000000001',
      outcome: 'approved' as const,
      operationKey: OPERATION_KEY,
      decisionId: 'decision-1',
    };
    expect(requiredActionResultSchema.parse(good).outcome).toBe('approved');
    expect(() => requiredActionResultSchema.parse({ ...good, outcome: 'maybe' })).toThrow();
    expect(() => requiredActionResultSchema.parse({ ...good, decisionId: 42 })).toThrow();
  });

  it('validates cancellation levels', () => {
    const good = {
      turnRef: turnRef(),
      cancellationLevel: 'graceful' as const,
      operationKey: OPERATION_KEY,
    };
    expect(cancelRuntimeWorkSchema.parse(good).cancellationLevel).toBe('graceful');
    expect(() =>
      cancelRuntimeWorkSchema.parse({ ...good, cancellationLevel: 'nuclear' }),
    ).toThrow();
  });

  it('has a bounded runtime event kind union including an unknown safety valve', () => {
    expect(runtimeEventKindSchema.parse('required_action')).toBe('required_action');
    expect(runtimeEventKindSchema.parse('unknown')).toBe('unknown');
    expect(() => runtimeEventKindSchema.parse('spontaneously_generated')).toThrow();
  });

  it('recognizes known providers only', () => {
    expect(KNOWN_PROVIDERS).toContain('trueforge');
    expect(isKnownProvider('trueforge')).toBe(true);
    expect(isKnownProvider('anonymous')).toBe(false);
  });
});
