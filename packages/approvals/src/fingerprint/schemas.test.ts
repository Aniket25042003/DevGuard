/**
 * C031 §22 — canonicalization golden vectors, normalization rules, and the
 * full fingerprint mutation matrix.
 */
import { describe, expect, it } from 'vitest';
import {
  CanonicalizationError,
  canonicalize,
  sha256Hex,
  buildFingerprints,
} from '@devguard/approvals';

describe('canonical JSON core rules', () => {
  it('sorts object keys by UTF-16 code units recursively', () => {
    expect(canonicalize({ b: 1, a: { d: 1, c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":1},"b":1}');
    // Key ordering uses RAW code units: 'A'(65) < 'a'(97) < 'b'(98).
    expect(canonicalize({ aB: 1, AB: 2, ab: 3 })).toBe('{"AB":2,"aB":1,"ab":3}');
  });

  it('serializes numbers in ES6 toString form; rejects non-finite values', () => {
    expect(canonicalize({ big: 1e21, small: 5e-7, neg: -0, zero: 0, frac: 0.1 })).toBe(
      '{"big":1e+21,"frac":0.1,"neg":0,"small":5e-7,"zero":0}',
    );
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(CanonicalizationError);
  });

  it('NFC-normalizes strings so equivalent compositions hash identically', () => {
    const decomposed = 'cafe\u0301';
    const composed = 'caf\u00e9';
    expect(canonicalize(decomposed)).toBe(canonicalize(composed));
    expect(sha256Hex(canonicalize({ k: decomposed }))).toBe(
      sha256Hex(canonicalize({ k: composed })),
    );
  });

  it('omits undefined properties instead of emitting null', () => {
    expect(canonicalize({ present: 1, absent: undefined })).toBe('{"present":1}');
  });

  it('preserves array order but normalizes duplicate representations inside them', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize(['caf\u00e9', 'cafe\u0301'])).toBe('["café","café"]');
  });

  it('escapes control characters per RFC 8785 and rejects lone surrogates fail-closed', () => {
    expect(canonicalize('line\nbreak')).toBe('"line\\nbreak"');
    expect(canonicalize('\u0001')).toBe('"\\u0001"');
    expect(() => canonicalize('\ud800')).toThrow(CanonicalizationError);
  });

  it('is idempotent byte-for-byte on its own output', () => {
    const input = { z: [{ y: 1 }, 'x'], a: true, m: 3.14, s: 'q\u00e9' };
    const once = canonicalize(input);
    // Reparse with JSON then re-canonicalize must be stable.
    const twice = canonicalize(JSON.parse(once));
    expect(once).toBe(twice);
  });

  it('rejects functions, bigints, Dates and class instances (fail closed)', () => {
    expect(() => canonicalize(() => 1)).toThrow(CanonicalizationError);
    expect(() => canonicalize(10n)).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date(0))).toThrow(CanonicalizationError);
    class Custom {
      x = 1;
    }
    expect(() => canonicalize(new Custom())).toThrow(CanonicalizationError);
  });
});

const ACTION_BASE = {
  actionType: 'pull_request_merge',
  tool: { id: 'mcp.merge_pr', registryVersion: 'registry-abc' },
  provider: 'github_adapter' as const,
  repository: {
    devguardId: '11111111-1111-4111-8111-111111111111',
    githubId: '42',
    installationId: 'inst-42',
  },
  operation: { prNumber: 7, mergeMethod: 'squash' },
  target: { kind: 'pull_request', providerId: 'octo/app#7' },
};

function contextBase() {
  return {
    workflow: {
      runId: '22222222-2222-4222-8222-222222222222',
      type: 'implement_issue',
      definitionVersion: 'wf@1',
    },
    targetState: {
      targetKind: 'pull_request',
      targetProviderId: 'octo/app#7',
      prNumber: 7,
      prState: 'open' as const,
      baseRef: 'main',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'.slice(0, 40),
      headRef: 'feature/x',
      headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'.slice(0, 40),
      defaultBranch: 'main',
      defaultBranchSha: 'cccccccccccccccccccccccccccccccccccccccc'.slice(0, 40),
    },
    policy: {
      versionId: 'pv-1',
      digest: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'.slice(0, 64),
    },
    risk: { class: 'sensitive_write' as const, reasonCodes: ['global-floor', 'repo-rule'] },
    validations: [
      {
        id: 'unit_tests',
        configDigest: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        status: 'SATISFIED' as const,
        evidenceDigest: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        subjectSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
    evidence: [],
    expiresAt: '2030-01-01T00:00:00Z',
  };
}

describe('fingerprint builders (C031 §10 exact schemas)', () => {
  const base = buildFingerprints(ACTION_BASE as never, contextBase() as never);

  it('produces lowercase sha256 hex fingerprints and valid canonical JSON', () => {
    expect(base.actionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(base.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(base.canonicalActionJson)).toBeTruthy();
    expect(base.canonicalContextJson.startsWith('{"actionFingerprint"')).toBe(true); // sorted keys
  });

  it('mutation matrix: every authorization-relevant change alters its fingerprint', () => {
    const cases: Array<[string, () => unknown]> = [
      [
        'actionType',
        () =>
          buildFingerprints(
            { ...ACTION_BASE, actionType: 'branch_delete' } as never,
            contextBase() as never,
          ),
      ],
      [
        'tool.id',
        () =>
          buildFingerprints(
            { ...ACTION_BASE, tool: { ...ACTION_BASE.tool, id: 'other' } } as never,
            contextBase() as never,
          ),
      ],
      [
        'operation field',
        () =>
          buildFingerprints(
            {
              ...ACTION_BASE,
              operation: { ...ACTION_BASE.operation, mergeMethod: 'merge' },
            } as never,
            contextBase() as never,
          ),
      ],
      [
        'target.kind',
        () =>
          buildFingerprints(
            { ...ACTION_BASE, target: { kind: 'branch', providerId: 'x' } } as never,
            contextBase() as never,
          ),
      ],
      [
        'runId',
        () =>
          buildFingerprints(
            ACTION_BASE as never,
            {
              ...contextBase(),
              workflow: {
                ...contextBase().workflow,
                runId: '33333333-3333-4333-8333-333333333333',
              },
            } as never,
          ),
      ],
      [
        'headSha',
        () =>
          buildFingerprints(
            ACTION_BASE as never,
            {
              ...contextBase(),
              targetState: {
                ...contextBase().targetState,
                headSha: '9999999999999999999999999999999999999999',
              },
            } as never,
          ),
      ],
      [
        'defaultBranchSha',
        () =>
          buildFingerprints(
            ACTION_BASE as never,
            {
              ...contextBase(),
              targetState: {
                ...contextBase().targetState,
                defaultBranchSha: '8888888888888888888888888888888888888888',
              },
            } as never,
          ),
      ],
      [
        'policy digest',
        () =>
          buildFingerprints(
            ACTION_BASE as never,
            {
              ...contextBase(),
              policy: { ...contextBase().policy, digest: '77'.repeat(32) },
            } as never,
          ),
      ],
      [
        'validation entry added',
        () =>
          buildFingerprints(
            ACTION_BASE as never,
            {
              ...contextBase(),
              validations: [
                ...contextBase().validations,
                { ...contextBase().validations[0], id: 'typecheck' },
              ],
            } as never,
          ),
      ],
      [
        'expiresAt',
        () =>
          buildFingerprints(
            ACTION_BASE as never,
            { ...contextBase(), expiresAt: '2031-01-01T00:00:00Z' } as never,
          ),
      ],
    ];
    for (const [name, produce] of cases) {
      const result = produce() as ReturnType<typeof buildFingerprints>;
      const differsAction = result.actionFingerprint !== base.actionFingerprint;
      const differsContext = result.contextFingerprint !== base.contextFingerprint;
      expect(differsAction || differsContext, `${name} did not change any fingerprint`).toBe(true);
    }
  });

  it('risk reason codes are order-independent (sorted+deduplicated before hashing)', () => {
    const reordered = buildFingerprints(
      ACTION_BASE as never,
      {
        ...contextBase(),
        risk: { class: 'sensitive_write', reasonCodes: ['repo-rule', 'global-floor'] },
      } as never,
    );
    expect(reordered.contextFingerprint).toBe(
      buildFingerprints(ACTION_BASE as never, contextBase() as never).contextFingerprint,
    );
  });

  it('secret-shaped operations are rejected before persistence', () => {
    expect(() =>
      buildFingerprints(
        { ...ACTION_BASE, operation: { token: 'value-here' } } as never,
        contextBase() as never,
      ),
    ).toThrow(/secret/i);
    expect(() =>
      buildFingerprints(
        { ...ACTION_BASE, operation: { note: 'ghp_16C7e42F292c6912E7710c838347A' } } as never,
        contextBase() as never,
      ),
    ).toThrow(/secret/i);
  });

  it('expiry precision is RFC3339 seconds only (no fractional drift)', () => {
    expect(() =>
      buildFingerprints(
        ACTION_BASE as never,
        { ...contextBase(), expiresAt: '2030-01-01T00:00:00.123Z' } as never,
      ),
    ).toThrow();
  });
});
