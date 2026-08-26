/**
 * C008 §22 — Always-run unit tests: scoped key hashing and canonical request
 * fingerprints. No database required.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, idempotencyKeyHash, requestFingerprint } from '@devguard/db';

describe('C008 idempotency key hashing', () => {
  it('is deterministic for identical scope/key pairs', () => {
    expect(idempotencyKeyHash('repo:acme/widget', 'key-123')).toBe(
      idempotencyKeyHash('repo:acme/widget', 'key-123'),
    );
  });

  it('produces lowercase hex sha256 output', () => {
    expect(idempotencyKeyHash('scope', 'key')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isolates scopes: equal keys in different scopes never collide', () => {
    expect(idempotencyKeyHash('scope-a', 'shared-key')).not.toBe(
      idempotencyKeyHash('scope-b', 'shared-key'),
    );
  });

  it('separates scope and key boundaries (no concatenation ambiguity)', () => {
    // ('scope','1key') and ('scope1','key') must not collapse to the same input.
    expect(idempotencyKeyHash('scope', '1key')).not.toBe(idempotencyKeyHash('scope1', 'key'));
  });
});

describe('C008 canonical request fingerprints', () => {
  it('are insensitive to object key order, including nested objects', () => {
    const a = { b: { y: 2, x: 1 }, a: 1 };
    const reordered = { a: 1, b: { x: 1, y: 2 } };
    expect(requestFingerprint(a)).toBe(requestFingerprint(reordered));
    expect(canonicalJsonStringify(a)).toBe('{"a":1,"b":{"x":1,"y":2}}');
  });

  it('treat array order as significant', () => {
    expect(requestFingerprint({ items: [1, 2] })).not.toBe(requestFingerprint({ items: [2, 1] }));
  });

  it('differ when any value differs', () => {
    expect(requestFingerprint({ amount: 1 })).not.toBe(requestFingerprint({ amount: 2 }));
  });

  it('omit undefined-valued properties so absent and undefined match', () => {
    expect(requestFingerprint({ a: 1, b: undefined })).toBe(requestFingerprint({ a: 1 }));
  });

  it('handle primitives and null consistently', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify('x')).toBe('"x"');
    expect(canonicalJsonStringify(7)).toBe('7');
  });
});
