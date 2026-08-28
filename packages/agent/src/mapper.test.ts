import { describe, expect, it } from 'vitest';
import { classifyProviderError, normalizeProbeResult } from './mapper.js';
import { redactProviderPayload, REDACTION_MASK } from './redact.js';

describe('C036 provider redaction', () => {
  it('masks secret-bearing keys and preserves safe fields', () => {
    const redacted = redactProviderPayload({
      provider: 'trueforge',
      serverVersion: '2026.08.1',
      authorization: 'Bearer sekret',
      x_api_key: 'k123',
      access_token: 't456',
      nested: { apiKey: 'nope', safe: 'yes' },
      list: ['authorization', 'plain'],
    });
    expect(redacted).toEqual({
      provider: 'trueforge',
      serverVersion: '2026.08.1',
      authorization: REDACTION_MASK,
      x_api_key: REDACTION_MASK,
      access_token: REDACTION_MASK,
      nested: { apiKey: REDACTION_MASK, safe: 'yes' },
      list: ['authorization', 'plain'], // array slots are scalars, not matched keys
    });
    expect(JSON.stringify(redacted)).not.toMatch(/sekret|k123|t456|nope/);
  });

  it('caps recursion depth and node budget against hostile payloads', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'boom' } } } } } } } } };
    const redacted = redactProviderPayload(deep);
    expect(JSON.stringify(redacted)).not.toContain('boom');
  });
});

describe('C036 provider payload mapping', () => {
  it('normalizes a valid probe result and confines capability names', () => {
    const normalized = normalizeProbeResult({
      ok: true,
      verifiedCapabilities: ['turn_create', 'Bad-Name!', '123start', 'valid_name2'],
    });
    expect(normalized.probeOk).toBe(true);
    expect(normalized.verifiedCapabilities).toEqual(['turn_create', 'valid_name2']);
  });

  it('rejects probe results whose capability names exceed the bound (fail closed)', () => {
    expect(() =>
      normalizeProbeResult({ ok: true, verifiedCapabilities: ['x'.repeat(100)] }),
    ).toThrow(/AGENT_RESPONSE_SCHEMA_REJECTED/);
  });

  it('rejects malformed probe results as a schema violation', () => {
    expect(() => normalizeProbeResult({ ok: 'yes' })).toThrow(/AGENT_RESPONSE_SCHEMA_REJECTED/);
    expect(() => normalizeProbeResult(null)).toThrow(/AGENT_RESPONSE_SCHEMA_REJECTED/);
  });

  it('classifies auth denials as AGENT_AUTH_DENIED (no retry)', () => {
    const cls = classifyProviderError(new Error('401 unauthorized'));
    expect(cls.code).toBe('AGENT_AUTH_DENIED');
    expect(cls.retryClass).toBe('no_retry');
  });

  it('classifies rate limits as PROVIDER_RATE_LIMITED', () => {
    const cls = classifyProviderError(new Error('429 too many requests'));
    expect(cls.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('classifies timeouts as PROVIDER_UNAVAILABLE (safe retry)', () => {
    const cls = classifyProviderError(new Error('fetch failed: network timeout'));
    expect(cls.code).toBe('PROVIDER_UNAVAILABLE');
    expect(cls.retryClass).toBe('safe_retry');
  });

  it('classifies schema-violation text as AGENT_RESPONSE_SCHEMA_REJECTED', () => {
    const cls = classifyProviderError(new Error('unexpected field validation failed'));
    expect(cls.code).toBe('AGENT_RESPONSE_SCHEMA_REJECTED');
  });

  it('classifies unknown errors as DEPENDENCY_UNAVAILABLE (reconcile first)', () => {
    const cls = classifyProviderError(new Error('something weird happened'));
    expect(cls.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(cls.retryClass).toBe('reconcile_then_retry');
  });

  it('never surfaces raw error text containing secrets', () => {
    const cls = classifyProviderError(new Error('props access_token="super-secret-value" failed'));
    expect(cls.causeSanitized).not.toContain('super-secret-value');
  });
});
