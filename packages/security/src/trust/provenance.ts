/**
 * C092 — Provenance envelopes and trust classes.
 *
 * Invariant: every byte that reaches model context carries a source. Unknown
 * source kinds, missing digests, oversized payloads, and malformed envelopes
 * fail closed at the registration boundary.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SOURCE_KINDS = [
  // Control plane (highest authority)
  'global_safety',
  'repository_policy',
  'workflow_rule',
  // Advisory instructions
  'agents_md',
  'contributing',
  // Authenticated request scope
  'task_request',
  // Untrusted data
  'readme',
  'issue',
  'pr_body',
  'review',
  'comment',
  'source',
  'test',
  'generated',
  'dependency',
  'tool_output',
  'provider_output',
  'model_output',
  'subagent_output',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const TRUST_CLASSES = [
  'control_plane',
  'authenticated_request',
  'advisory_instruction',
  'untrusted_data',
] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

/** Canonical trust ranking: lower number = higher authority. */
export const TRUST_RANK: Readonly<Record<SourceKind, TrustClass>> = Object.freeze({
  global_safety: 'control_plane',
  repository_policy: 'control_plane',
  workflow_rule: 'control_plane',
  agents_md: 'advisory_instruction',
  contributing: 'advisory_instruction',
  task_request: 'authenticated_request',
  readme: 'untrusted_data',
  issue: 'untrusted_data',
  pr_body: 'untrusted_data',
  review: 'untrusted_data',
  comment: 'untrusted_data',
  source: 'untrusted_data',
  test: 'untrusted_data',
  generated: 'untrusted_data',
  dependency: 'untrusted_data',
  tool_output: 'untrusted_data',
  provider_output: 'untrusted_data',
  model_output: 'untrusted_data',
  subagent_output: 'untrusted_data',
});

/** Only these classes may carry narrowly-defined control fields (never untrusted ones). */
export function canCarryControlFields(kind: SourceKind): boolean {
  return TRUST_RANK[kind] === 'control_plane' || kind === 'task_request';
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ProvenanceEnvelopeShape {
  readonly id: string;
  readonly sourceKind: SourceKind;
  readonly trustClass: TrustClass;
  readonly repositoryId?: string | undefined;
  readonly ref?: string | undefined;
  readonly path?: string | undefined;
  readonly externalId?: string | undefined;
  /** Author identity CLAIM from the provider — never an authorization input. */
  readonly actorClaim?: string | undefined;
  readonly fetchedAt: string;
  readonly digest: string;
  readonly contentType: 'text' | 'json' | 'diff' | 'binary_ref';
  readonly parentIds: readonly string[];
  readonly transformations: readonly string[];
  readonly sizeBytes: number;
  readonly flags: readonly string[];
}

export const provenanceEnvelopeSchema = z
  .object({
    id: z.string().min(8).max(128),
    sourceKind: z.enum(SOURCE_KINDS),
    trustClass: z.enum(TRUST_CLASSES),
    repositoryId: z.string().max(128).optional(),
    ref: z.string().max(256).optional(),
    path: z.string().max(512).optional(),
    externalId: z.string().max(128).optional(),
    actorClaim: z.string().max(256).optional(),
    fetchedAt: z.string().datetime({ offset: false }),
    digest: z.string().regex(SHA256_PATTERN),
    contentType: z.enum(['text', 'json', 'diff', 'binary_ref']),
    parentIds: z.array(z.string().max(128)).max(64),
    transformations: z.array(z.string().max(64)).max(16),
    sizeBytes: z.number().int().nonnegative(),
    flags: z.array(z.string().max(64)).max(32),
  })
  .strict();

/** Absolute ceiling before registration rejects instead of truncating. */
export const MAX_CONTENT_BYTES = 1_000_000;

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export class ProvenanceError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) {
    super(message);
    this.name = 'ProvenanceError';
    this.reasonCode = reasonCode;
  }
}

export interface RegisterSourceInput {
  readonly sourceKind: SourceKind;
  readonly content: string | Uint8Array;
  readonly repositoryId?: string | undefined;
  readonly ref?: string | undefined;
  readonly path?: string | undefined;
  readonly externalId?: string | undefined;
  /** Provider author claim; recorded as evidence only. */
  readonly actorClaim?: string | undefined;
  readonly fetchedAt?: string | undefined;
  readonly contentType?: 'text' | 'json' | 'diff' | 'binary_ref' | undefined;
  readonly parentIds?: readonly string[] | undefined;
}

/**
 * Build a validated envelope for a content item. Fails closed on unknown
 * kinds (compile-time via the enum), oversize payloads, or missing digests.
 */
export function registerSource(
  input: RegisterSourceInput,
  options: { readonly now?: () => Date; readonly idGenerator?: () => string } = {},
): ProvenanceEnvelopeShape {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const bytes =
    typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;
  if (bytes.byteLength > MAX_CONTENT_BYTES) {
    throw new ProvenanceError('content_too_large', `content exceeds ${MAX_CONTENT_BYTES} bytes`);
  }
  const digest = sha256Hex(bytes);
  if (!SHA256_PATTERN.test(digest)) {
    throw new ProvenanceError('digest_failed', 'content digest could not be computed');
  }
  const trustClass = TRUST_RANK[input.sourceKind];
  const envelope: ProvenanceEnvelopeShape = {
    id: (options.idGenerator ?? (() => crypto.randomUUID()))(),
    sourceKind: input.sourceKind,
    trustClass,
    ...(input.repositoryId !== undefined ? { repositoryId: input.repositoryId } : {}),
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
    ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    ...(input.actorClaim !== undefined ? { actorClaim: input.actorClaim } : {}),
    fetchedAt: input.fetchedAt ?? now,
    digest,
    ...(input.contentType !== undefined
      ? { contentType: input.contentType }
      : { contentType: 'text' }),
    parentIds: [...(input.parentIds ?? [])],
    transformations: [],
    sizeBytes: bytes.byteLength,
    flags: [],
  };
  const parsed = provenanceEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new ProvenanceError('envelope_invalid', JSON.stringify(parsed.error.issues));
  }
  return parsed.data;
}
