/**
 * C041 §10/§16/§17 — checkout selector validation and ref resolution contract.
 *
 * Only immutable Git object IDs may drive an execution checkout; branch, tag
 * and pull-request selectors are mutable and MUST be resolved to a SHA by the
 * RefResolver port immediately before provisioning. Validation here rejects
 * option-like refs, SHA/ref injection, noncanonical owner/name shapes and
 * alternate object formats (fail closed).
 */
import { validationFailed } from '@devguard/errors';
import { z } from 'zod';

/** Shape accepted by VALIDATION_FAILED details (C003). */
export type ValidationIssue = { readonly path: string; readonly constraint: string };

export const REF_KINDS = ['commit', 'branch', 'tag', 'pull_request_head'] as const;
export type RefKind = (typeof REF_KINDS)[number];

/** Full immutable object IDs only: 40 or 64 lowercase hex (SHA-1 / SHA-256). */
export const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const fullShaSchema = z
  .string()
  .regex(FULL_SHA_PATTERN, 'expected a full 40- or 64-char lowercase hex commit id');

/**
 * GitHub ref name rules (git-check-ref-format subset) enforced as an
 * allowlist: ASCII printable, no leading dash/question (option injection),
 * no `..`, no `@{`, no `//`, no whitespace/control, no trailing dot or
 * `.lock`. Anything else is rejected — branches are selector inputs, never
 * executed.
 */
const REF_NAME_PATTERN = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/;
function isSafeRefName(name: string): boolean {
  if (!REF_NAME_PATTERN.test(name)) return false;
  if (name.startsWith('-') || name.startsWith('?')) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.endsWith('.') || name.endsWith('.lock')) return false;
  return true;
}

const refNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(isSafeRefName, 'unsafe, noncanonical, or option-like ref name');

export type CheckoutSelector =
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'branch'; readonly name: string; readonly expectedSha?: string | undefined }
  | { readonly kind: 'tag'; readonly name: string; readonly expectedSha?: string | undefined }
  | {
      readonly kind: 'pull_request_head';
      readonly number: number;
      readonly expectedSha?: string | undefined;
    };

export const checkoutSelectorSchema: z.ZodType<CheckoutSelector> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), sha: fullShaSchema }).strict(),
  z
    .object({
      kind: z.literal('branch'),
      name: refNameSchema,
      expectedSha: fullShaSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tag'),
      name: refNameSchema,
      expectedSha: fullShaSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pull_request_head'),
      number: z.number().int().positive(),
      expectedSha: fullShaSchema.optional(),
    })
    .strict(),
]);

function selectorIssues(result: z.ZodSafeParseResult<CheckoutSelector>): ValidationIssue[] {
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'selector',
        constraint: issue.message,
      }));
}

/** Parse and validate an untrusted checkout selector; throws VALIDATION_FAILED. */
export function parseCheckoutSelector(input: unknown): CheckoutSelector {
  const result = checkoutSelectorSchema.safeParse(input);
  if (!result.success) {
    throw validationFailed(selectorIssues(result));
  }
  return result.data;
}

/** Safe, bounded display form (`kind:value`) for events and logs. Never a raw ref. */
export function describeSelector(selector: CheckoutSelector): string {
  switch (selector.kind) {
    case 'commit':
      return `commit:${selector.sha.slice(0, 12)}`;
    case 'branch':
      return `branch:${selector.name}`;
    case 'tag':
      return `tag:${selector.name}`;
    case 'pull_request_head':
      return `pull_request_head:${selector.number}`;
  }
}

/** Immutable binding once the mutable selector is resolved (C041 §4/§6). */
export interface ResolvedCheckout {
  readonly repositoryId: string;
  readonly canonicalOwner: string;
  readonly canonicalName: string;
  readonly selector: CheckoutSelector;
  /** Exact immutable object ID the run is entitled to. */
  readonly resolvedSha: string;
  /** Canonical remote identity, e.g. `github.com/owner/name`. */
  readonly remoteFingerprint: string;
  readonly resolvedAtMs: number;
}

const OWNER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const REMOTE_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(:[0-9]{1,5})?\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface ResolvedCheckoutInput {
  readonly repositoryId: string;
  readonly canonicalOwner: string;
  readonly canonicalName: string;
  readonly selector: CheckoutSelector;
  readonly resolvedSha: string;
  readonly remoteFingerprint: string;
  readonly resolvedAtMs: number;
}

/** Validate a RefResolver result before it may bind a workspace (fail closed). */
export function parseResolvedCheckout(input: ResolvedCheckoutInput): ResolvedCheckout {
  const issues: ValidationIssue[] = [];
  if (!/^[0-9a-z-]{1,64}$/i.test(input.repositoryId ?? '')) {
    issues.push({ path: 'repositoryId', constraint: 'unexpected repository identity shape' });
  }
  if (
    !OWNER_NAME_PATTERN.test(input.canonicalOwner) ||
    !OWNER_NAME_PATTERN.test(input.canonicalName)
  ) {
    issues.push({ path: 'canonicalOwner|name', constraint: 'noncanonical owner/name' });
  }
  if (!FULL_SHA_PATTERN.test(input.resolvedSha)) {
    issues.push({ path: 'resolvedSha', constraint: 'must be a full immutable commit id' });
  }
  if (!REMOTE_PATTERN.test(input.remoteFingerprint)) {
    issues.push({ path: 'remoteFingerprint', constraint: 'unexpected remote identity' });
  } else if (
    input.remoteFingerprint !== `github.com/${input.canonicalOwner}/${input.canonicalName}`
  ) {
    issues.push({
      path: 'remoteFingerprint',
      constraint: 'remote does not match canonical repository',
    });
  }
  if (!Number.isInteger(input.resolvedAtMs) || input.resolvedAtMs <= 0) {
    issues.push({ path: 'resolvedAtMs', constraint: 'expected a positive epoch millis timestamp' });
  }
  parseCheckoutSelector(input.selector);
  if (issues.length > 0) {
    throw validationFailed(issues);
  }
  return Object.freeze({
    repositoryId: input.repositoryId,
    canonicalOwner: input.canonicalOwner,
    canonicalName: input.canonicalName,
    selector: input.selector,
    resolvedSha: input.resolvedSha,
    remoteFingerprint: input.remoteFingerprint,
    resolvedAtMs: input.resolvedAtMs,
  });
}

/**
 * Expected SHA if the caller pinned one, else undefined. Used by the manager
 * to detect `REF_CHANGED` (C041 §18) when the resolver re-derives a SHA that
 * differs from the input expectation.
 */
export function expectedShaOf(selector: CheckoutSelector): string | undefined {
  switch (selector.kind) {
    case 'commit':
      return selector.sha;
    case 'branch':
    case 'tag':
    case 'pull_request_head':
      return selector.expectedSha;
  }
}
