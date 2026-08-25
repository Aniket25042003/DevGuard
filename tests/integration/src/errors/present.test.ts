import { describe, expect, it } from 'vitest';
import {
  httpStatusForCode,
  normalizeError,
  presentHttpError,
  providerUnavailable,
  repositoryForbidden,
  runJobWithDisposition,
  toErrorEnvelope,
  toJobDisposition,
  toPublicError,
} from '@devguard/errors';

describe('C003 unknown-error normalization', () => {
  it('wraps plain Errors without leaking their message publicly', () => {
    const normalized = normalizeError(new Error('raw database DSN postgres://user:pw@h'));
    expect(normalized.code).toBe('INTERNAL');
    expect(normalized.message).toBe('An unexpected error occurred.');
  });

  it('normalizes primitives, nulls, arrays, objects and symbols safely', () => {
    for (const value of ['str', 42, null, undefined, [1, 2], { a: 1 }, Symbol('s'), () => {}]) {
      const normalized = normalizeError(value);
      expect(normalized.code).toBe('INTERNAL');
      expect(normalized.message).toBe('An unexpected error occurred.');
      const pub = toPublicError(normalized, 'req');
      expect(pub.message).toBe('An unexpected error occurred.');
    }
  });

  it('fuzzes random JSON-shaped values into the generic fallback', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let index = 0; index < 200; index += 1) {
      const value = rand() < 0.5 ? { nested: { data: rand() } } : `payload-${index}`;
      const pub = toPublicError(value, `req-${index}`);
      expect(pub.code).toBe('INTERNAL');
      const serialized = JSON.stringify(pub);
      expect(serialized).not.toContain('payload-');
      expect(serialized).not.toContain('nested');
    }
  });

  it('lets registered DevGuardErrors pass through unchanged', () => {
    const error = providerUnavailable();
    expect(normalizeError(error)).toBe(error);
  });
});

describe('C003 public projections and envelope', () => {
  it('produces the stable envelope with request correlation', () => {
    const envelope = toErrorEnvelope(repositoryForbidden(), 'req-123');
    expect(envelope).toEqual({
      error: {
        code: 'REPOSITORY_FORBIDDEN',
        message: 'You do not have access to this repository.',
        requestId: 'req-123',
        retryable: false,
      },
    });
  });

  it('resists resource enumeration: identical public output regardless of existence', () => {
    const exists = toPublicError(repositoryForbidden(new Error('repo 1 found')), 'r');
    const missing = toPublicError(repositoryForbidden(new Error('repo 2 missing')), 'r');
    expect(exists).toEqual(missing);
  });

  it('maps statuses deterministically; unknown codes fall back to 500', () => {
    expect(httpStatusForCode('VALIDATION_FAILED')).toBe(400);
    expect(httpStatusForCode('RATE_LIMITED')).toBe(429);
    expect(httpStatusForCode('DEPENDENCY_UNAVAILABLE')).toBe(503);
    expect(httpStatusForCode('MADE_UP_CODE')).toBe(500);
  });

  it('presentHttpError returns status plus envelope and never stacks or secrets', () => {
    const boom = presentHttpError(new Error('token=ghp_supersecret'), 'req-9');
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain('ghp_supersecret');
    expect(boom.body.error.requestId).toBe('req-9');
  });
});

describe('C003 job dispositions', () => {
  it('maps every retry class to exactly one action', () => {
    expect(toJobDisposition(providerUnavailable())).toEqual({
      action: 'reconcile_then_retry',
      retryable: true,
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(toJobDisposition(new Error('mystery'))).toEqual({
      action: 'escalate_human',
      retryable: false,
      code: 'INTERNAL',
    });
  });

  it('drives the worker wrapper outcome', async () => {
    const ok = await runJobWithDisposition(async () => 42);
    expect(ok).toEqual({ outcome: 'completed', value: 42 });

    const failed = await runJobWithDisposition(async () => {
      throw providerUnavailable();
    });
    expect(failed.outcome === 'failed' && failed.disposition.action).toBe('reconcile_then_retry');

    const dead = await runJobWithDisposition(async () => {
      throw repositoryForbidden();
    });
    expect(dead.outcome === 'failed' && dead.disposition.action).toBe('dead_letter');
  });
});
