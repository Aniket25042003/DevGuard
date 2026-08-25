import { describe, expect, it } from 'vitest';
import {
  assertRegistryIntegrity,
  configurationInvalid,
  DevGuardError,
  FOUNDATION_ERROR_DESCRIPTORS,
  getErrorDescriptor,
  internalError,
  listErrorDescriptors,
  makeError,
  registerError,
  versionConflict,
} from '@devguard/errors';

describe('C003 error registry', () => {
  it('registers foundation descriptors with unique codes', () => {
    const codes = FOUNDATION_ERROR_DESCRIPTORS.map((descriptor) => descriptor.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('passes integrity assertion', () => {
    expect(() => assertRegistryIntegrity()).not.toThrow();
  });

  it('rejects duplicate registration with a conflicting descriptor', () => {
    expect(() =>
      registerError({
        code: 'INTERNAL',
        category: 'application',
        httpStatus: 503,
        retryClass: 'safe_retry',
        safeMessage: 'An unexpected error occurred.',
      }),
    ).toThrowError(/already registered/);
  });

  it('accepts identical re-registration as a no-op', () => {
    const descriptor = getErrorDescriptor('NOT_FOUND');
    expect(descriptor).toBeDefined();
    if (!descriptor) throw new Error('unreachable');
    expect(registerError({ ...descriptor }).created).toBe(false);
  });

  it('exposes descriptors sorted by code for deterministic consumers', () => {
    const codes = listErrorDescriptors().map((d) => d.code);
    const sorted = [...codes].sort((a, b) => a.localeCompare(b));
    expect(codes).toEqual(sorted);
  });
});

describe('C003 descriptor structure rules', () => {
  it('uses SCREAMING_SNAKE_CASE codes with mapped HTTP statuses and fixed messages', () => {
    for (const descriptor of listErrorDescriptors()) {
      expect(descriptor.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect([400, 401, 403, 404, 409, 422, 429, 500, 501, 503]).toContain(descriptor.httpStatus);
      expect(descriptor.safeMessage.length).toBeGreaterThanOrEqual(8);
      // Fixed messages never embed dynamic input.
      expect(descriptor.safeMessage).not.toMatch(/\{|\}/);
    }
  });

  it('covers every retry class across the registry', () => {
    const classes = new Set(listErrorDescriptors().map((d) => d.retryClass));
    expect([...classes].sort()).toEqual([
      'human_intervention',
      'no_retry',
      'reconcile_then_retry',
      'safe_retry',
    ]);
  });
});

describe('C003 DevGuardError behavior', () => {
  it('keeps the fixed safe message and rejects unregistered codes', () => {
    const error = versionConflict(3, 7);
    expect(error.message).toBe('The resource changed concurrently; reload and try again.');
    expect(error.safeDetails).toEqual({ expectedVersion: 3, currentVersion: 7 });
    expect(() => makeError('TOTALLY_UNKNOWN')).toThrowError(/Unregistered error code/);
  });

  it('fails closed when details are supplied for a code without a detail schema', () => {
    expect(() => internalError(undefined)).not.toThrow();
    expect(() => makeError('UNAUTHENTICATED', { details: { leak: true } })).toThrowError(
      /does not permit public details/,
    );
  });

  it('rejects detail payloads violating the code schema instead of sanitizing silently', () => {
    expect(() => configurationInvalid([{ path: '', constraint: '' }])).toThrowError(
      /Safe details rejected/,
    );
  });

  it('hides cause and stack from serialization and enumeration', () => {
    const original = new Error('secret-internal-detail');
    const error = internalError(original);
    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toContain('secret-internal-detail');
    expect(json).toHaveProperty('code', 'INTERNAL');
    expect(json['stack']).toBeUndefined();
    expect(json['cause']).toBeUndefined();
    // Internal access still works for redacting log tooling.
    expect((error as unknown as { cause: unknown }).cause).toBe(original);
    expect(error instanceof DevGuardError).toBe(true);
  });

  it('exposes safe log fields only', () => {
    const fields = configurationInvalid([
      { path: 'database.url', constraint: 'required' },
    ]).toSafeLogFields();
    expect(fields).toMatchObject({
      code: 'CONFIGURATION_INVALID',
      retryClass: 'no_retry',
    });
  });
});
