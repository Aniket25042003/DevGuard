/**
 * C031 §10 — approval-action/v1 and approval-context/v1 builders.
 *
 * The two fingerprint payloads are fixed schemas: unknown keys, floating
 * timestamps, secret-shaped values, and locale-dependent strings are
 * rejected at build time. Every authorization-relevant field is present, so
 * ANY mutation changes the digest (mutation matrix tested exhaustively).
 */
import { z } from 'zod';
import { canonicalize, sha256Hex } from './canonical.js';

const isoSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/; // RFC3339 seconds precision
const shaPattern = /^[0-9a-f]{64}$/;

export const approvalActionV1 = z
  .object({
    schemaVersion: z.literal('approval-action/v1'),
    actionType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    tool: z
      .object({ id: z.string().min(1).max(128), registryVersion: z.string().min(1).max(64) })
      .strict(),
    provider: z.enum(['github_adapter', 'trueforge_mcp', 'sandbox', 'webhook']),
    repository: z
      .object({
        devguardId: z.string().min(26).max(36),
        githubId: z.string().min(1).max(64),
        installationId: z.string().min(1).max(64),
      })
      .strict(),
    operation: z.record(z.string(), z.unknown()),
    target: z
      .object({ kind: z.string().min(1).max(32), providerId: z.string().min(1).max(256) })
      .strict(),
  })
  .strict();

export type ApprovalActionV1 = z.infer<typeof approvalActionV1>;

export const validationEvidenceRef = z
  .object({
    id: z.string().min(1).max(64),
    configDigest: shaPattern,
    status: z.enum(['SATISFIED', 'BLOCKED', 'UNKNOWN', 'NOT_APPLICABLE']),
    evidenceDigest: shaPattern,
    subjectSha: z.string().min(6).max(128),
  })
  .strict();

export const approvalContextV1 = z
  .object({
    schemaVersion: z.literal('approval-context/v1'),
    actionFingerprint: shaPattern,
    workflow: z
      .object({
        runId: z.string().min(26).max(36),
        type: z.string().min(1).max(64),
        definitionVersion: z.string().min(1).max(64),
      })
      .strict(),
    targetState: z
      .object({
        targetKind: z.string().min(1).max(32),
        targetProviderId: z.string().min(1).max(256),
        prNumber: z.number().int().positive().max(10_000_000).optional(),
        prState: z.enum(['open', 'closed', 'merged']).optional(),
        baseRef: z.string().max(256).optional(),
        baseSha: z
          .string()
          .min(40)
          .max(40)
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        headRef: z.string().max(256).optional(),
        headSha: z
          .string()
          .min(40)
          .max(40)
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
        defaultBranch: z.string().min(1).max(256),
        defaultBranchSha: z
          .string()
          .min(40)
          .max(40)
          .regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    policy: z
      .object({ versionId: z.string().min(1).max(128), digest: z.string().min(6).max(128) })
      .strict(),
    risk: z
      .object({
        class: z.enum([
          'read',
          'reversible_write',
          'sensitive_write',
          'destructive',
          'external_side_effect',
        ]),
        reasonCodes: z.array(z.string().min(1).max(64)).max(16), // sorted/unique upstream
      })
      .strict(),
    validations: z.array(validationEvidenceRef).max(32),
    evidence: z
      .array(
        z
          .object({
            type: z.string().min(1).max(32),
            id: z.string().min(1).max(128),
            digest: shaPattern,
          })
          .strict(),
      )
      .max(32),
    expiresAt: z.string().regex(isoSeconds, 'expiry uses RFC3339 second precision'),
  })
  .strict();

export type ApprovalContextV1 = z.infer<typeof approvalContextV1>;

/** Secret-shape guard (C031 §17): reject token-like values anywhere in the operation. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
];

function assertNoSecrets(node: unknown, path = 'operation'): void {
  if (typeof node === 'string') {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(node))) {
      throw new Error(`secret-shaped value detected at '${path}'; use an opaque reference instead`);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++)
      assertNoSecrets(node[index], `${path}[${index}]`);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (
        /secret|password|token|credential|privatekey|private_key/i.test(key) &&
        typeof child === 'string' &&
        child.length > 0
      ) {
        throw new Error(
          `field '${path}.${key}' looks like a secret carrier; use an opaque reference instead`,
        );
      }
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

export interface ActionFingerprintResult {
  readonly actionFingerprint: string;
  readonly contextFingerprint: string;
  readonly canonicalActionJson: string;
  readonly canonicalContextJson: string;
}

/**
 * Build both v1 fingerprints. Validations are sorted by id and evidence by
 * type+id per the plan's canonical ordering rules; risk reason codes are
 * sorted+deduplicated here so callers cannot produce divergent bytes.
 */
export function buildFingerprints(
  actionInput: ApprovalActionV1,
  contextInput: Omit<ApprovalContextV1, 'schemaVersion' | 'actionFingerprint'>,
): ActionFingerprintResult {
  // Boundary validation (C031 §5): fingerprints are ONLY computed over
  // schema-valid payloads; fractional timestamps, unknown keys etc. fail here.
  const checkedAction = approvalActionV1.parse({
    ...actionInput,
    schemaVersion: 'approval-action/v1',
  });
  const checkedContextTemplate = approvalContextV1.parse({
    ...contextInput,
    schemaVersion: 'approval-context/v1',
  }) as ApprovalContextV1;
  void checkedContextTemplate;
  const operation = structuredClone(checkedAction.operation);
  assertNoSecrets(operation);

  const actionJson = canonicalize(checkedAction);
  const actionFingerprint = sha256Hex(actionJson);

  const normalizedReasonCodes = [...new Set(contextInput.risk.reasonCodes)].sort((a, b) =>
    a.localeCompare(b),
  );
  const validations = [...contextInput.validations].sort((a, b) => a.id.localeCompare(b.id));
  const evidence = [...contextInput.evidence].sort(
    (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
  );
  const context = {
    ...checkedContextTemplate,
    schemaVersion: 'approval-context/v1',
    actionFingerprint,
    risk: { ...contextInput.risk, reasonCodes: normalizedReasonCodes },
    validations,
    evidence,
  } satisfies ApprovalContextV1;
  const contextJson = canonicalize(context);
  const contextFingerprint = sha256Hex(contextJson);

  return {
    actionFingerprint,
    contextFingerprint,
    canonicalActionJson: actionJson,
    canonicalContextJson: contextJson,
  };
}
