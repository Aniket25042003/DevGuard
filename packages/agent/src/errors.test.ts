import { describe, expect, it } from 'vitest';
import { assertRegistryIntegrity, getErrorDescriptor } from '@devguard/errors';
import './errors.js';

describe('C036 error registry', () => {
  it('registers every agent error descriptor without integrity violations', () => {
    // Runs after the import above has registered the agent codes.
    expect(() => assertRegistryIntegrity()).not.toThrow();
  });

  it('registers the runtime capability contract code', () => {
    const descriptor = getErrorDescriptor('RUNTIME_CAPABILITY_UNAVAILABLE');
    expect(descriptor).toBeDefined();
    expect(descriptor?.httpStatus).toBe(501);
    expect(descriptor?.retryClass).toBe('human_intervention');
  });

  it('registers the compatibility FSM transition code', () => {
    const descriptor = getErrorDescriptor('AGENT_COMPATIBILITY_ILLEGAL_TRANSITION');
    expect(descriptor?.httpStatus).toBe(409);
    expect(descriptor?.retryClass).toBe('no_retry');
  });

  it('registers the contract-incompatible fail-closed code', () => {
    const descriptor = getErrorDescriptor('AGENT_CONTRACT_INCOMPATIBLE');
    expect(descriptor?.httpStatus).toBe(501);
  });
});
