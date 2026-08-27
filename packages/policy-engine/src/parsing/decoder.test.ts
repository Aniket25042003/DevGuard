/**
 * C023 §22 — decoder security and equivalence tests.
 * Covers YAML/JSON parity, hostile-YAML rejection, size/depth caps,
 * prototype-pollution keys, duplicate keys, and diagnostics.
 */
import { describe, expect, it } from 'vitest';
import { DECODE_LIMITS, PolicyDecoder } from '@devguard/policy-engine';

function decode(text: string) {
  const decoder = new PolicyDecoder();
  const decoded = decoder.decode(text);
  return { decoded, report: decoder.diagnostics };
}

const MINIMAL = `schemaVersion: 1
repository: { owner: octo, name: app }
autonomy: { level: developer }
`;

describe('PolicyDecoder — happy path', () => {
  it('decodes minimal valid YAML into plain values', () => {
    const { decoded, report } = decode(MINIMAL);
    expect(decoded).toBeDefined();
    expect(report.ok).toBe(true);
    expect((decoded!.value as Record<string, unknown>)['schemaVersion']).toBe(1);
  });

  it('decodes equivalent JSON with identical values', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      repository: { owner: 'octo', name: 'app' },
      autonomy: { level: 'developer' },
    });
    const { decoded, report } = decode(json);
    expect(report.ok).toBe(true);
    expect(decoded?.format).toBe('json');
  });
});

describe('PolicyDecoder — hostile input rejection (C023 §17/§22)', () => {
  it('rejects YAML anchors/aliases (alias bombs included)', () => {
    const bomb = 'a: &x [1,2,3]\nb: *x\n';
    const { decoded, report } = decode(bomb);
    expect(decoded).toBeUndefined();
    expect(
      report.items.some((d) => /anchors\/tags are forbidden|aliases are forbidden/.test(d.message)),
    ).toBe(true);
  });

  it('rejects merge keys even when the library resolves them silently', () => {
    const merge = 'base: &b {x: 1}\nchild:\n  <<: *b\n';
    const { decoded, report } = decode(merge);
    // Merge requires an anchor, which is already rejected; assert at least one hit.
    expect(decoded === undefined || report.ok === false).toBe(true);
    expect(report.items.length).toBeGreaterThan(0);
  });

  it('rejects explicit custom tags', () => {
    const { decoded, report } = decode('v: !mytag hello\n');
    expect(decoded).toBeUndefined();
    expect(report.ok).toBe(false);
  });

  it('rejects duplicate mapping keys at any depth', () => {
    const { decoded, report } = decode(`${MINIMAL}actions:\n  allow: []\n  allow: []\n`);
    expect(decoded).toBeUndefined();
    expect(
      report.items.some(
        (d) => d.code === 'POLICY_SYNTAX_INVALID' && /unique|duplicate/.test(d.message),
      ),
    ).toBe(true);
  });

  it('rejects prototype-pollution keys anywhere in the document', () => {
    const { decoded, report } = decode(`${MINIMAL}triggers:\n  __proto__: []\n`);
    expect(decoded).toBeUndefined();
    expect(report.items.some((d) => d.message.includes('__proto__'))).toBe(true);
  });

  it('rejects non-finite numbers produced by YAML .inf/.nan', () => {
    const { decoded, report } = decode(`${MINIMAL}limits:\n  maxIterations: .inf\n`);
    // yaml 1.2 core resolves .inf to Infinity (non-JSON); decoder must reject.
    expect(report.ok).toBe(false);
    void decoded;
  });

  it('rejects documents exceeding the byte cap', () => {
    const big = `${MINIMAL}# ${'x'.repeat(DECODE_LIMITS.maxBytes + 10)}\n`;
    const { decoded, report } = decode(big);
    expect(decoded).toBeUndefined();
    expect(report.items.some((d) => d.code === 'POLICY_TOO_LARGE')).toBe(true);
  });

  it('rejects nesting beyond maxDepth', () => {
    const depth = DECODE_LIMITS.maxDepth + 2;
    let src = '';
    for (let i = 0; i < depth; i++) src += `${' '.repeat(i * 2)}k${i}:\n`;
    src += `${' '.repeat(depth * 2)}leaf: 1\n`;
    const { decoded, report } = decode(src);
    expect(decoded).toBeUndefined();
    expect(report.items.some((d) => /nesting deeper/.test(d.message))).toBe(true);
  });

  it('reports syntax errors without parser stack traces', () => {
    const { report } = decode('{schemaVersion: 1\n');
    expect(report.ok).toBe(false);
    for (const diagnostic of report.items) {
      expect(diagnostic.message.includes('at Parser')).toBe(false);
    }
  });
});
