/**
 * C016 §12/§22 — path-scope applicability resolver.
 *
 * Repository instructions may carry a path scope (glob). A segment applies to
 * a path when its normalized path matches the glob. Scopes are resolved purely
 * against the immutable snapshot — never by following content-provided
 * references beyond an approved glob set (C016 §5).
 */
import { canonicalizeRepoPath } from '../repository-map/path-safety.js';

/** Match a repository-relative path against a bounded glob scope. */
export function pathMatchesScope(path: string, scope: string): boolean {
  const normalized = canonicalizeRepoPath(path);
  return globMatch(normalized, scope);
}

/**
 * Minimal glob matcher supporting `**` (any depth), `*` (within a segment),
 * and literal segments. Deterministic and bounded; rejects absolute/traversal.
 */
export function globMatch(path: string, scope: string): boolean {
  const trimmed = scope.trim();
  if (trimmed === '**') return true;
  const pathSegments = path.split('/');
  const scopeSegments = scope.split('/');

  let p = 0;
  let s = 0;
  let starBacktrackP = -1;
  let starBacktrackS = -1;

  while (p < pathSegments.length) {
    const scopeSeg = scopeSegments[s];
    if (scopeSeg === '**') {
      starBacktrackP = p;
      starBacktrackS = s + 1;
      if (s + 1 >= scopeSegments.length) return true;
      s += 1;
      continue;
    }
    const matched = scopeSeg !== undefined && segmentMatches(pathSegments[p] ?? '', scopeSeg);
    if (matched) {
      p += 1;
      s += 1;
    } else if (starBacktrackP >= 0) {
      p = starBacktrackP + 1;
      s = starBacktrackS;
      starBacktrackP += 1;
    } else {
      return false;
    }
  }
  // Scope may end with a trailing `**` (already handled) or exactly match.
  while (scopeSegments[s] === '**') s += 1;
  return s >= scopeSegments.length;
}

function segmentMatches(segment: string, scopeSegment: string): boolean {
  if (scopeSegment === '*') return true;
  if (!scopeSegment.includes('*')) return segment === scopeSegment;
  const escaped = scopeSegment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(segment);
}
