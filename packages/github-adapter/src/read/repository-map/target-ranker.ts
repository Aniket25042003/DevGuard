/**
 * C015 §12/§23 step 4 — deterministic target ranker.
 *
 * Ranks repository paths for task relevance from normalized terms. Purely
 * heuristic and deterministic (tie-break by path ascending). Ranking never
 * executes anything and never determines authorization; it only selects
 * which paths may be fetched as bounded snippets.
 */
import { canonicalizeRepoPath, isVendorOrGeneratedPath } from './path-safety.js';
import type { BudgetTracker } from './budget.js';
import type { TargetedPath } from './contracts.js';

interface RankInput {
  readonly path: string;
  readonly terms: readonly string[];
}

/**
 * Scores a path against normalized terms. Deterministic; higher is more
 * relevant. Exact basename matches dominate; directory hits and
 * language-relevant extensions add small bonuses; depth is a penalty.
 */
export function scorePath(input: RankInput): {
  readonly score: number;
  readonly reasons: readonly string[];
} {
  const segments = input.path.split('/');
  const basename = segments[segments.length - 1] ?? input.path;
  const basenameLower = basename.toLowerCase();
  const pathLower = input.path.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  for (const term of input.terms) {
    const termLower = term.trim().toLowerCase();
    if (termLower.length === 0) continue;
    if (basenameLower === termLower) {
      score += 10;
      reasons.push(`basename-exact:${term}`);
    } else if (basenameLower.includes(termLower) || termLower.includes(basenameLower)) {
      score += 6;
      reasons.push(`basename-similar:${term}`);
    } else if (pathLower.includes(termLower)) {
      score += 3;
      reasons.push(`path-contains:${term}`);
    }
  }

  // Depth penalty keeps the map shallow for monorepos (C015 §27).
  score -= Math.max(0, segments.length - 3);

  const extension = basename.split('.').pop();
  if (
    extension !== undefined &&
    /^(ts|tsx|js|jsx|py|go|rs|md|yml|yaml|json|toml|mod)$/.test(extension)
  ) {
    score += 1;
  }

  return { score, reasons: reasons.slice(0, 3) };
}

export class TargetRanker {
  /** Ranks `candidates`, bounded by the path budget; traversal-safe. */
  rank(
    candidates: readonly RankInput[],
    terms: readonly string[],
    budget: BudgetTracker,
    nowMs: number,
  ): { readonly targetedPaths: readonly TargetedPath[]; readonly truncated: boolean } {
    const ranked: TargetedPath[] = [];
    let truncated = false;
    for (const candidate of candidates) {
      if (budget.isExhausted(nowMs).length > 0) {
        truncated = true;
        break;
      }
      if (!budget.chargePath()) {
        truncated = true;
        break;
      }
      if (isVendorOrGeneratedPath(candidate.path)) continue;
      const { score, reasons } = scorePath({ path: candidate.path, terms });
      if (score <= 0) continue;
      ranked.push({ path: candidate.path, score, reasons });
    }
    // Deterministic ordering: score desc, then path asc.
    ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { targetedPaths: ranked, truncated };
  }

  /** Boundary validation for user-supplied query paths (C015 §17). */
  canonicalize(path: string): string {
    return canonicalizeRepoPath(path);
  }
}
