/**
 * C015 §12/§23 step 3 — tree compaction.
 *
 * The recursive provider tree becomes a bounded summary: counts, top-level
 * directory breakdown, largest files, and vendor/generated exclusion.
 * Truncation propagates explicitly; budget exhaustion truncates, never
 * fabricates (C015 §9/§18).
 */
import { isBinaryPath, isVendorOrGeneratedPath } from './path-safety.js';
import type { BudgetTracker } from './budget.js';
import type { TreeEntryLike } from './provider-port.js';
import type { TreeSummary } from './contracts.js';

export interface TreeCollectionResult {
  readonly summary: TreeSummary;
  readonly truncated: boolean;
  readonly skippedVendorCount: number;
  /** Paths to consider for manifests/commands/instructions (bounded). */
  readonly retainedPaths: readonly string[];
}

const TOP_LEVEL_LIMIT = 100;
const LARGEST_FILES_LIMIT = 10;

export class TreeCollector {
  collect(
    entries: readonly TreeEntryLike[],
    budget: BudgetTracker,
    nowMs: number,
  ): TreeCollectionResult {
    let totalFiles = 0;
    let totalDirs = 0;
    let vendorFileCount = 0;
    let skippedVendorCount = 0;
    let truncated = false;
    const dirCounts = new Map<string, number>();
    const largest: Array<{ path: string; sizeBytes: number }> = [];
    const retainedPaths: string[] = [];

    for (const entry of entries) {
      if (budget.isExhausted(nowMs).length > 0) {
        truncated = true;
        break;
      }
      if (!budget.chargePath()) {
        truncated = true;
        break;
      }
      if (isVendorOrGeneratedPath(entry.path)) {
        skippedVendorCount += 1;
        if (entry.kind === 'blob') vendorFileCount += 1;
        continue;
      }
      if (entry.kind === 'tree') {
        totalDirs += 1;
        continue;
      }
      if (entry.kind === 'commit') continue;
      if (isBinaryPath(entry.path)) continue;
      totalFiles += 1;
      retainedPaths.push(entry.path);

      const topLevel = entry.path.split('/')[0];
      if (topLevel !== undefined) {
        dirCounts.set(topLevel, (dirCounts.get(topLevel) ?? 0) + 1);
      }
      if (entry.size !== undefined) {
        largest.push({ path: entry.path, sizeBytes: entry.size });
        largest.sort((a, b) => b.sizeBytes - a.sizeBytes);
        if (largest.length > LARGEST_FILES_LIMIT) largest.length = LARGEST_FILES_LIMIT;
      }
    }

    const topLevelDirs = [...dirCounts.entries()]
      .map(([path, fileCount]) => ({ path, fileCount }))
      .sort((a, b) => b.fileCount - a.fileCount)
      .slice(0, TOP_LEVEL_LIMIT);

    return {
      summary: {
        totalFiles,
        totalDirs,
        topLevelDirs,
        largestFiles: largest,
        vendorFileCount,
      },
      truncated,
      skippedVendorCount,
      retainedPaths,
    };
  }
}
