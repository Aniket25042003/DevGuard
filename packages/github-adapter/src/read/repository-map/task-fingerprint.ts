/**
 * C015 §23 step 2 — deterministic task fingerprint and exact-ref binding.
 *
 * A map is anchored to (repositoryId, resolved head SHA); the task
 * fingerprint distinguishes concurrent builds for the same ref. The
 * fingerprint is content-dependent (terms are normalized and sorted) so a
 * cache key can never mismatch its task.
 */
import { createHash } from 'node:crypto';

export interface FingerprintInput {
  readonly repositoryId: string;
  readonly ref: string;
  readonly taskKind: string;
  readonly terms: readonly string[];
  readonly issueNumber?: number | undefined;
  readonly prNumber?: number | undefined;
}

/** Canonical hex digest (sha256) of the normalized input. */
export function taskFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify({
    v: 1,
    repositoryId: input.repositoryId,
    ref: input.ref,
    taskKind: input.taskKind,
    // Sorted + deduped so term order never changes the fingerprint.
    terms: [
      ...new Set(input.terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
    ].sort(),
    ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
    ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
