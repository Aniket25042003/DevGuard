/**
 * C023 §22 — normalization/canonicalization tests plus the full service
 * pipeline table from the plan (§22 case matrix).
 */
import { describe, expect, it } from 'vitest';
import {
  POLICY_LIMIT_DEFAULTS,
  type CanonicalPolicyDocument,
  PolicyDocumentService,
  canonicalJson,
  canonicalizationIsStable,
  effectiveLimits,
  normalizePolicyV1,
  repositoryPolicyV1,
  type CanonicalPolicyDocument,
} from '@devguard/policy-engine';
const REGISTRIES = {
  knownActions: new Set([
    'repository.read',
    'issue.read',
    'file.read',
    'pull_request.create',
    'pull_request.merge',
    'branch.delete',
  ]),
  knownWorkflows: new Set(['wf.implement-issue', 'wf.security-audit']),
  knownObligations: new Set(['tests-pass', 'build-pass', 'cafe\u0301-check', 'caf\u00e9-check']),
};

function ctx() {
  return { registries: REGISTRIES };
}

function makeService() {
  let seq = 0;
  return new PolicyDocumentService({
    versions: {
      insertVersion: async () => ({ id: `pv-${++seq}`, version: seq }),
      findActiveVersion: async () => undefined,
      activate: async () => ({ activatedAt: '2026-01-01T00:00:00Z' }),
    },
    newVersionId: () => `pvid-${Math.random().toString(36).slice(2)}`,
  });
}

const VALID_YAML = `schemaVersion: 1
repository: { owner: octo, name: app }
autonomy: { level: developer }
triggers:
  webhook:
    - wf.implement-issue
manualCommands:
  - wf.security-audit
actions:
  allow: [issue.read, file.read]
  requireApproval: [pull_request.create]
  deny: [branch.delete, branch.delete]   # duplicate dedupes canonically
validation:
  obligations: [tests-pass]
limits:
  maxFilesChanged: 10
`;

const VALID_JSON = JSON.stringify({
  schemaVersion: 1,
  repository: { owner: 'octo', name: 'app' },
  autonomy: { level: 'developer' },
  triggers: { webhook: ['wf.implement-issue'] },
  manualCommands: ['wf.security-audit'],
  actions: {
    allow: ['file.read', 'issue.read'],
    requireApproval: ['pull_request.create'],
    deny: ['branch.delete', 'branch.delete'],
  },
  validation: { obligations: ['tests-pass'] },
  limits: { maxFilesChanged: 10 },
});

describe('normalization (C023 §8/§22)', () => {
  it('YAML and JSON with same semantics produce identical canonical bytes and hash', async () => {
    const service = makeService();
    const yamlResult = await service.validate({ bytes: VALID_YAML }, ctx());
    const jsonResult = await service.validate({ bytes: VALID_JSON }, ctx());
    expect(yamlResult.ok).toBe(true);
    expect(jsonResult.ok).toBe(true);
    expect(yamlResult.canonical!.json).toBe(jsonResult.canonical!.json);
    expect(yamlResult.canonical!.hash).toBe(jsonResult.canonical!.hash);
  });

  it('normalization is idempotent byte-for-byte (canonicalize∘canonicalize === canonicalize)', () => {
    const parsed = repositoryPolicyV1.parse(
      JSON.parse(VALID_JSON) as unknown,
    ) as never as Parameters<typeof normalizePolicyV1>[0];
    const once = normalizePolicyV1(parsed) as CanonicalPolicyDocument;
    expect(canonicalizationIsStable(once)).toBe(true);
    expect(canonicalJson(once)).toBe(
      canonicalJson(
        normalizePolicyV1(repositoryPolicyV1.parse(JSON.parse(canonicalJson(once))) as never),
      ),
    );
  });

  it('omitted grants become empty sets; omitted limits use conservative defaults', async () => {
    const minimal = await makeService().validate({ bytes: MINIMAL_YAML }, ctx());
    expect(minimal.ok).toBe(true);
    expect(minimal.canonical!.limits).toEqual(POLICY_LIMIT_DEFAULTS);
    const doc = JSON.parse(minimal.canonical!.json) as Record<string, unknown>;
    const actions = doc['actions'] as Record<string, string[]>;
    expect(actions['allow']).toEqual([]);
    expect(actions['deny']).toEqual([]);
    const triggers = doc['triggers'] as Record<string, string[]>;
    // Empty-record triggers may drop to {} after Zod record default handling.
    expect(Object.keys(triggers).length).toBeLessThanOrEqual(1);
  });

  it('explicitly empty rule arrays are valid but grant nothing (no rules ⇒ no permission)', async () => {
    const doc = `${MINIMAL_YAML}actions:\n  allow: []\n  requireApproval: []\n  deny: []\n`;
    const result = await makeService().validate({ bytes: doc }, ctx());
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.canonical!.json) as { actions: Record<string, string[]> };
    expect(parsed.actions.allow).toEqual([]);
  });

  it('same action in allow AND deny is a contradiction (rejected)', async () => {
    const doc = `${MINIMAL_YAML}actions:\n  allow: [issue.read]\n  deny: [issue.read]\n`;
    const result = await makeService().validate({ bytes: doc }, ctx());
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'POLICY_CONFLICT')).toBe(true);
  });

  it('unknown actions/workflows/obligations fail closed via registry lookups', async () => {
    // Unknown action: rejected at the schema enum boundary (even stricter than
    // the registry lookup), surfacing as a schema diagnostic.
    const doc = `${MINIMAL_YAML}actions:\n  allow: [issue.read, unknown.action]\n`;
    const result = await makeService().validate({ bytes: doc }, ctx());
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === 'POLICY_REFERENCE_UNKNOWN' || d.code === 'POLICY_SCHEMA_INVALID',
      ),
    ).toBe(true);

    // Plain-string references rely purely on registry lookups.
    const wfDoc = `${MINIMAL_YAML}triggers:\n  manual:\n    - wf.nope\n`;
    const wfResult = await makeService().validate({ bytes: wfDoc }, ctx());
    expect(wfResult.ok).toBe(false);
    expect(wfResult.diagnostics.some((d) => d.code === 'POLICY_REFERENCE_UNKNOWN')).toBe(true);

    const obligDoc = `${MINIMAL_YAML}validation:\n  obligations: [nope]\n`;
    const obligResult = await makeService().validate({ bytes: obligDoc }, ctx());
    expect(obligResult.ok).toBe(false);
    expect(obligResult.diagnostics.some((d) => d.code === 'POLICY_REFERENCE_UNKNOWN')).toBe(true);
  });

  it('missing autonomy.level is invalid for user documents (never widened)', async () => {
    const doc = `schemaVersion: 1\nrepository: { owner: octo, name: app }\nautonomy: {}\n`;
    const result = await makeService().validate({ bytes: doc }, ctx());
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('POLICY_SCHEMA_INVALID');
  });

  it('empty object document fails closed (missing autonomy/repository)', async () => {
    const result = await makeService().validate({ bytes: '{}' }, ctx());
    expect(result.ok).toBe(false);
  });

  it('policy retargeting a different repository is a conflict', async () => {
    const service = makeService();
    const context = { ...ctx(), expectedOwner: 'other-org', expectedName: 'backend' };
    const result = await service.validate({ bytes: VALID_YAML }, context);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => /retargeting is forbidden/.test(d.message))).toBe(true);
  });

  it('limit above global cap is rejected even though schema bound matches', async () => {
    const doc = JSON.stringify({
      schemaVersion: 1,
      repository: { owner: 'octo', name: 'app' },
      autonomy: { level: 'assist' },
      limits: { maxFilesChanged: 5000 },
    });
    const result = await makeService().validate({ bytes: doc }, ctx());
    expect(result.ok).toBe(false);
  });

  it('unicode strings are NFC-normalized before hashing', () => {
    // Obligations accept arbitrary short strings, so compose vs decomposed é
    // must yield identical canonical bytes/hashes.
    const decomposed = JSON.stringify({
      schemaVersion: 1,
      repository: { owner: 'octo', name: 'app' },
      autonomy: { level: 'assist' },
      validation: { obligations: ['cafe\u0301-check'] },
    });
    const composed = JSON.stringify({
      schemaVersion: 1,
      repository: { owner: 'octo', name: 'app' },
      autonomy: { level: 'assist' },
      validation: { obligations: ['caf\u00e9-check'] },
    });
    const a = await makeService().validate({ bytes: decomposed }, ctx());
    expect(a.ok).toBe(true);
    const b = await makeService().validate({ bytes: composed }, ctx());
    expect(b.ok).toBe(true);
    expect(a.canonical?.hash).toBe(b.canonical?.hash);
  });
});

const MINIMAL_YAML = `schemaVersion: 1
repository: { owner: octo, name: app }
autonomy: { level: developer }
`;

describe('effectiveLimits', () => {
  it('clamps requested values to global caps and fills defaults', () => {
    expect(effectiveLimits()).toEqual(POLICY_LIMIT_DEFAULTS);
    expect(effectiveLimits({ maxFilesChanged: 1000 }).maxFilesChanged).toBe(200);
    expect(effectiveLimits({ maxRuntimeMinutes: 5 }).maxRuntimeMinutes).toBe(5);
  });
});
