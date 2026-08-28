/**
 * C020 §5/§12/§17/§20 — branch identity, namespaces, fingerprints, and message
 * safety for GitHub mutations.
 *
 * Mutations only ever target the `agent/<workflow>/<short-id>` namespace and
 * are exclusively owned by one workflow run. `force` is structurally impossible
 * in the MVP contract. Messages are sanitized and truthfully reasonable; no
 * forged author, no secrets.
 */
import { createHash } from 'node:crypto';
import { BRANCH_PREFIX } from './contracts.js';

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Canonical input digest binding an operation key to its exact inputs. */
export function mutationInputDigest(input: unknown): string {
  return sha256Hex(canonicalize(input));
}

/** Sanitize a branch segment into a safe, bounded, printable token. */
function safeSegment(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned.length === 0 ? 'run' : cleaned;
}

/** `agent/<workflow>/<short-id>`; short-id is a bounded digest fragment. */
export function buildWorkflowBranchName(workflowRunId: string, operationKey: string): string {
  const run = safeSegment(workflowRunId);
  const shortId = sha256Hex(operationKey).slice(0, 8);
  return `${BRANCH_PREFIX}${run}/${shortId}`;
}

/** A mutation branch must live in the owned `agent/` namespace. */
export function isMutationBranch(branch: string): boolean {
  return branch.startsWith(BRANCH_PREFIX) && branch.length <= 256;
}

export function assertMutationBranch(branch: string): void {
  if (!isMutationBranch(branch)) {
    throw new Error('GITHUB_MUTATION_NAMESPACE_DENIED');
  }
}

/** Reserved/default/protected targets are never writable through MVP. */
export function isProtectedTarget(branch: string): boolean {
  const lower = branch.toLowerCase();
  return (
    lower === 'main' ||
    lower === 'master' ||
    lower === 'trunk' ||
    lower.startsWith('refs/heads/main') ||
    lower.startsWith('refs/heads/master')
  );
}

export function assertWritableTarget(branch: string): void {
  if (isProtectedTarget(branch)) throw new Error('GITHUB_PROTECTED_BRANCH_DENIED');
}

const SECRET_INLINE =
  /(?:api[-_ .]?key|access[-_ .]?token|refresh[-_ .]?token|token|password|passwd|secret|private[-_ .]?key|credentials)\s*[:=]\s*["']?[^"'\s,;&]{6,}/i;

/** Sanitize a commit message: strip control chars, bound it, refuse secrets. */
export function sanitizeCommitMessage(raw: string): string {
  const normalized = Array.from(raw)
    .map((ch) => (ch < '\u0020' || ch === '\u007f' ? ' ' : ch))
    .join('');
  const cleaned = normalized.replace(/\s+/g, ' ').trim();
  const message = cleaned.slice(0, 10_000);
  if (message.length === 0) throw new Error('GITHUB_COMMIT_MESSAGE_EMPTY');
  if (SECRET_INLINE.test(message)) throw new Error('GITHUB_COMMIT_SECRET_REJECTED');
  return message;
}

export const mutationIdentity = {
  buildWorkflowBranchName,
  assertMutationBranch,
  assertWritableTarget,
  isProtectedTarget,
  mutationInputDigest,
  sanitizeCommitMessage,
  isMutationBranch,
};
