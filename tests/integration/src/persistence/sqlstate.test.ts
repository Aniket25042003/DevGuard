/**
 * C007 §22 — Always-run unit tests: SQLSTATE retry classifier. No database.
 */
import { describe, expect, it } from 'vitest';
import { classifySqlState, sqlStateOf } from '@devguard/db';

describe('C007 SQLSTATE classification', () => {
  it('maps serialization failure (40001) to retry', () => {
    expect(classifySqlState('40001')).toBe('retry');
  });

  it('maps deadlock detection (40P01) to retry', () => {
    expect(classifySqlState('40P01')).toBe('retry');
  });

  it('maps every other SQLSTATE to no_retry', () => {
    expect(classifySqlState('23505')).toBe('no_retry'); // unique_violation
    expect(classifySqlState('40000')).toBe('no_retry');
    expect(classifySqlState('42P01')).toBe('no_retry'); // undefined_table
    expect(classifySqlState('08006')).toBe('no_retry'); // connection_failure
    expect(classifySqlState('ECONNREFUSED')).toBe('no_retry');
  });

  it('treats missing state as no_retry', () => {
    expect(classifySqlState(undefined)).toBe('no_retry');
    expect(classifySqlState(null)).toBe('no_retry');
    expect(classifySqlState('')).toBe('no_retry');
  });
});

describe('C007 SQLSTATE extraction from pg-style errors', () => {
  it('reads error.code when present', () => {
    expect(sqlStateOf({ code: '40001' })).toBe('40001');
  });

  it('returns undefined for non-pg errors and non-string codes', () => {
    expect(sqlStateOf(new Error('boom'))).toBeUndefined();
    expect(sqlStateOf({ code: 42 })).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
    expect(sqlStateOf('oops')).toBeUndefined();
  });
});
