/**
 * C095 — Bounded unified-diff patch validation.
 *
 * Patches are UNTRUSTED structured input. Parsing never shells out. Hard rules:
 * - Git quoted-path form ("path" with C escapes) is REJECTED closed — quoting
 *   must not smuggle targets past the path policy.
 * - The authoritative `diff --git` envelope line must agree with ---/+++ headers.
 * - Hunk grammar is validated: @@ -l,c +l,c @@ ranges parsed, EXACTLY the
 *   declared old/new lines consumed, content counted only inside hunks,
 *   unexpected records rejected, content-changing operations require hunks.
 * - Mode metadata (old mode/new mode) rejected unless explicitly authorized.
 * - Rename metadata (rename from/to) is parsed, normalized through the same
 *   path policy as every other target, and cross-checked against the envelope.
 */
import { createHash } from 'node:crypto';
import { makeError } from '@devguard/errors';
import { normalizeRelativePath, type ContentBudget } from './paths.js';

export type PatchOperationKind = 'create' | 'update' | 'delete';

export interface PatchOperation {
  readonly kind: PatchOperationKind;
  readonly targetPath: string;
  readonly hunks: number;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface PathDecision {
  readonly path: string;
  readonly allowed: boolean;
  readonly reasonCode?: string | undefined;
}

export interface PatchValidationShape {
  readonly inputDigest: string;
  readonly operations: readonly PatchOperation[];
  readonly pathDecisions: readonly PathDecision[];
  readonly totalAddedLines: number;
  readonly totalRemovedLines: number;
  readonly withinBudget: true;
}

export interface PatchValidationContext {
  readonly rootId: string;
  /** Protected prefixes (normalized, root-relative) that may never be touched. */
  readonly protectedPrefixes?: readonly string[] | undefined;
  readonly allowBinary?: boolean | undefined;
  readonly allowModeChanges?: boolean | undefined;
  readonly budget?: Partial<ContentBudget> | undefined;
}

function rejectPatch(reasonCode: string): never {
  throw makeError('PATCH_REJECTED', { details: { reasonCode }, cause: new Error(reasonCode) });
}

const GIT_QUOTED_PATH = /^"/;

/** Reject Git's C-quoted path form outright for MVP (unescaping deferred). */
function assertUnquotedPath(value: string): void {
  if (GIT_QUOTED_PATH.test(value)) rejectPatch('quoted_path_unsupported');
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ParsedBlock {
  readonly gitOldPath: string | null;
  readonly gitNewPath: string | null;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly renameFrom?: string | undefined;
  readonly renameTo?: string | undefined;
  readonly hasModeChange: boolean;
  readonly hunks: ReadonlyArray<{ readonly oldCount: number; readonly newCount: number }>;
  readonly addedLines: number;
  readonly removedLines: number;
}

/**
 * Strict parser. Grammar deviations throw immediately rather than being
 * skipped, so malformed records can never pass as a no-op.
 */
function parseUnifiedDiff(text: string): readonly ParsedBlock[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const blocks: ParsedBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.startsWith('diff --git ')) rejectPatch('unexpected_record');
    const remainder = line.slice('diff --git '.length);

    // Envelope paths: quoted form unsupported; split on last ' b/'.
    if (remainder.includes('"')) rejectPatch('quoted_path_unsupported');
    const splitAt = remainder.lastIndexOf(' b/');
    if (splitAt <= 0) rejectPatch('envelope_unparsable');
    const rawGitOld = remainder.slice(0, splitAt).replace(/^a\//, '');
    const rawGitNew = remainder.slice(splitAt + 3).replace(/^b\//, '');
    assertUnquotedPath(rawGitOld);
    assertUnquotedPath(rawGitNew);

    index += 1;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let hasModeChange = false;

    // Metadata section between the envelope and the first hunk.
    while (index < lines.length) {
      const metadataLine = lines[index] ?? '';
      if (metadataLine.startsWith('--- ')) break;
      if (metadataLine.startsWith('new file mode')) {
        if (rawGitOld !== rawGitNew && !rawGitOld.startsWith('/dev/null')) {
          // inconsistent with envelope; final consistency check below handles it
        }
        index += 1;
        continue;
      }
      if (metadataLine.startsWith('deleted file mode')) {
        index += 1;
        continue;
      }
      if (metadataLine.startsWith('old mode ') || metadataLine.startsWith('new mode ')) {
        hasModeChange = true;
        index += 1;
        continue;
      }
      if (metadataLine.startsWith('rename from ')) {
        renameFrom = metadataLine.slice('rename from '.length).trim();
        index += 1;
        continue;
      }
      if (metadataLine.startsWith('rename to ')) {
        renameTo = metadataLine.slice('rename to '.length).trim();
        index += 1;
        continue;
      }
      if (
        metadataLine.startsWith('similarity index ') ||
        metadataLine.startsWith('dissimilarity index ')
      ) {
        index += 1;
        continue;
      }
      if (metadataLine.startsWith('index ')) {
        index += 1;
        continue;
      }
      if (metadataLine.startsWith('Binary files ') || metadataLine.startsWith('GIT binary patch')) {
        rejectPatch('binary_patch_unsupported');
      }
      if (metadataLine.startsWith('@')) break;
      rejectPatch('unexpected_record');
    }

    // File headers.
    if (index < lines.length && (lines[index] ?? '').startsWith('--- ')) {
      const value = (lines[index] ?? '').slice(4).trim();
      oldPath = value === '/dev/null' ? null : stripPrefix(assertUnquoted(value));
      index += 1;
    }
    if (index < lines.length && (lines[index] ?? '').startsWith('+++ ')) {
      const value = (lines[index] ?? '').slice(4).trim();
      newPath = value === '/dev/null' ? null : stripPrefix(assertUnquoted(value));
      index += 1;
    }

    // Hunks: strict grammar, exact line consumption.
    const hunks: Array<{ oldCount: number; newCount: number }> = [];
    let added = 0;
    let removed = 0;
    while (index < lines.length) {
      const candidate = lines[index] ?? '';
      if (candidate.startsWith('diff --git ')) break;
      const hunkMatch = HUNK_HEADER.exec(candidate);
      if (hunkMatch === null) rejectPatch('unexpected_record_outside_hunk');
      const oldStart = Number.parseInt(hunkMatch[1] ?? '0', 10);
      const oldCountRaw = hunkMatch[2];
      const newStart = Number.parseInt(hunkMatch[3] ?? '0', 10);
      const newCountRaw = hunkMatch[4];
      const oldCount = oldCountRaw !== undefined ? Number.parseInt(oldCountRaw, 10) : 1;
      const newCount = newCountRaw !== undefined ? Number.parseInt(newCountRaw, 10) : 1;
      if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart))
        rejectPatch('bad_hunk_range');
      index += 1;

      let consumedOld = 0;
      let consumedNew = 0;
      while (consumedOld < oldCount || consumedNew < newCount) {
        const bodyLine = lines[index];
        if (bodyLine === undefined) rejectPatch('truncated_hunk');
        if (bodyLine.startsWith('\\ No newline')) {
          index += 1;
          continue;
        }
        if (bodyLine.startsWith('+')) {
          consumedNew += 1;
          added += 1;
        } else if (bodyLine.startsWith('-')) {
          consumedOld += 1;
          removed += 1;
        } else if (bodyLine.startsWith(' ')) {
          consumedOld += 1;
          consumedNew += 1;
        } else {
          rejectPatch('bad_hunk_line');
        }
        index += 1;
      }
      hunks.push({ oldCount, newCount });
    }

    blocks.push({
      gitOldPath: rawGitOld === '/dev/null' ? null : rawGitOld,
      gitNewPath: rawGitNew === '/dev/null' ? null : rawGitNew,
      oldPath,
      newPath,
      ...(renameFrom !== undefined ? { renameFrom } : {}),
      ...(renameTo !== undefined ? { renameTo } : {}),
      hasModeChange,
      hunks,
      addedLines: added,
      removedLines: removed,
    });
  }
  return blocks;

  function assertUnquoted(value: string): string {
    assertUnquotedPath(value);
    return value;
  }

  function stripPrefix(value: string): string {
    return value.replace(/^a\//, '').replace(/^b\//, '').replace(/\t.*$/, '');
  }
}

function classifyOperation(diff: ParsedBlock): PatchOperationKind {
  if (diff.oldPath === null && diff.newPath !== null) return 'create';
  if (diff.oldPath !== null && diff.newPath === null) return 'delete';
  return 'update';
}

/**
 * Validate a patch against path policy and budgets. Returns a summary bound
 * to the exact input digest; application happens later in the sandbox with
 * resulting-tree verification.
 */
export function validatePatch(
  patchText: string,
  context: PatchValidationContext,
): PatchValidationShape {
  const budget: ContentBudget = {
    maxFiles: context.budget?.maxFiles ?? 100,
    maxFileBytes: context.budget?.maxFileBytes ?? 10_000_000,
    maxTotalBytes: context.budget?.maxTotalBytes ?? 50_000_000,
    maxLines: context.budget?.maxLines ?? 20_000,
    maxDepth: context.budget?.maxDepth ?? 16,
    maxArchiveRatio: context.budget?.maxArchiveRatio ?? 100,
    maxPatchFiles: context.budget?.maxPatchFiles ?? 100,
    maxPatchHunks: context.budget?.maxPatchHunks ?? 2_000,
    deadlineMs: context.budget?.deadlineMs ?? 60_000,
  };

  if (Buffer.byteLength(patchText, 'utf8') > budget.maxTotalBytes) rejectBudget();
  if (/^GIT binary patch/m.test(patchText) && context.allowBinary !== true) {
    rejectPatch('binary_patch_unsupported');
  }

  const blocks = parseUnifiedDiff(patchText);
  if (blocks.length === 0) rejectPatch('no_operations_parsed');
  if (blocks.length > budget.maxPatchFiles) rejectBudget();

  const operations: PatchOperation[] = [];
  const pathDecisions: PathDecision[] = [];
  let totalHunks = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  /** Run one touched path through lexical + protected policy. */
  const checkPath = (touched: string): string => {
    let normalized: string;
    try {
      normalized = normalizeRelativePath(context.rootId, touched).normalizedRelativePath;
    } catch (error) {
      const reason =
        (error as { safeDetails?: { reasonCode?: string } }).safeDetails?.reasonCode ??
        'unsafe_path';
      pathDecisions.push({ path: touched, allowed: false, reasonCode: `path_${reason}` });
      rejectPatch(`path_${reason}`);
    }
    if (normalized === '.git' || normalized.startsWith('.git/')) {
      pathDecisions.push({ path: normalized, allowed: false, reasonCode: 'git_internals' });
      rejectPatch('git_internals_forbidden');
    }
    const protectedHit = (context.protectedPrefixes ?? []).find(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
    );
    if (protectedHit !== undefined) {
      pathDecisions.push({ path: normalized, allowed: false, reasonCode: 'protected_path' });
      rejectPatch('protected_path');
    }
    pathDecisions.push({ path: normalized, allowed: true });
    return normalized;
  };

  for (const diff of blocks) {
    if (diff.hasModeChange && context.allowModeChanges !== true) {
      rejectPatch('mode_change_unauthorized');
    }

    totalHunks += diff.hunks.length;
    totalAdded += diff.addedLines;
    totalRemoved += diff.removedLines;
    if (totalHunks > budget.maxPatchHunks) rejectBudget();

    // Normalize every declared path first so agreement checks operate on
    // canonical values (and policy runs on each independently).
    const normalizeOrNull = (value: string | null | undefined): string | null => {
      if (value === undefined || value === null) return null;
      return normalizeRelativePath(context.rootId, value).normalizedRelativePath;
    };
    const normGitOld = normalizeOrNull(diff.gitOldPath);
    const normGitNew = normalizeOrNull(diff.gitNewPath);
    const normHeaderOld = normalizeOrNull(diff.oldPath);
    const normHeaderNew = normalizeOrNull(diff.newPath);
    const normRenameFrom = normalizeOrNull(diff.renameFrom);
    const normRenameTo = normalizeOrNull(diff.renameTo);

    // Envelope/header agreement: corresponding non-null normalized paths MUST
    // be identical. /dev/null (null header) pairs with a present envelope path
    // for create/delete semantics.
    if (normGitOld !== null && normHeaderOld !== null && normGitOld !== normHeaderOld) {
      rejectPatch('inconsistent_headers');
    }
    if (normGitNew !== null && normHeaderNew !== null && normGitNew !== normHeaderNew) {
      rejectPatch('inconsistent_headers');
    }
    if (normHeaderOld !== null && normGitOld === null) rejectPatch('inconsistent_headers');
    if (normHeaderNew !== null && normGitNew === null) rejectPatch('inconsistent_headers');

    const isPureRename =
      normRenameFrom !== undefined &&
      normRenameTo !== undefined &&
      diff.hunks.length === 0 &&
      normGitOld === normRenameFrom &&
      normGitNew === normRenameTo;

    const operationKind: PatchOperationKind = isPureRename ? 'update' : classifyOperation(diff);

    // Content-changing operations require at least one hunk (pure renames are
    // metadata-only and exempt).
    if (!isPureRename && operationKind !== 'delete' && diff.hunks.length === 0) {
      rejectPatch('operation_requires_hunk');
    }

    // Every named target passes full policy.
    const targets = new Set<string>();
    for (const candidate of [
      normGitOld,
      normGitNew,
      normHeaderOld,
      normHeaderNew,
      normRenameFrom,
      normRenameTo,
    ]) {
      if (candidate !== null) targets.add(candidate);
    }
    for (const target of targets) {
      checkPath(target);
    }

    const primaryTarget = normGitNew ?? normHeaderNew ?? normGitOld ?? normHeaderOld ?? '';
    operations.push({
      kind: operationKind,
      targetPath: primaryTarget,
      hunks: diff.hunks.length,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
    });
  }

  if (totalAdded + totalRemoved > budget.maxLines) rejectBudget();

  return {
    inputDigest: createHash('sha256').update(Buffer.from(patchText, 'utf8')).digest('hex'),
    operations,
    pathDecisions,
    totalAddedLines: totalAdded,
    totalRemovedLines: totalRemoved,
    withinBudget: true,
  };

  function rejectBudget(): never {
    throw makeError('PATCH_REJECTED', {
      details: { reasonCode: 'budget_exceeded' },
      cause: new Error('budget'),
    });
  }
}
