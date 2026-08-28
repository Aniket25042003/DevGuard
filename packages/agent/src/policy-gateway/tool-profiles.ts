/**
 * C039 §8/§12 — versioned tool profiles + exact action mapping.
 *
 * Every enabled tool maps to exactly one action/risk/reversibility definition
 * with a pinned schema digest. Unknown/new tools, disabled tools, and tools
 * marked direct-mutative are impossible to allow: they fail closed.
 */
import { createHash } from 'node:crypto';
import type { ToolProfileEntry } from './contracts.js';

export type ToolProfileLookup =
  | { readonly ok: true; readonly entry: ToolProfileEntry }
  | {
      readonly ok: false;
      readonly code: 'UNKNOWN_TOOL_DENIED' | 'PROFILE_DISABLED' | 'DIRECT_MUTATIVE_DENIED';
    };

export class ToolProfileRegistry {
  constructor(private readonly entries: readonly ToolProfileEntry[]) {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.profileId}\u0000${entry.toolName}`;
      if (seen.has(key)) throw new Error('duplicate tool profile mapping');
      seen.add(key);
    }
  }

  lookup(toolName: string, toolProfileId: string): ToolProfileLookup {
    const entry = this.entries.find((e) => e.toolName === toolName && e.profileId === toolProfileId);
    if (entry === undefined) return { ok: false, code: 'UNKNOWN_TOOL_DENIED' };
    if (!entry.enabled) return { ok: false, code: 'PROFILE_DISABLED' };
    if (entry.directMutative) return { ok: false, code: 'DIRECT_MUTATIVE_DENIED' };
    return { ok: true, entry };
  }

  /** Fail closed on any unknown or direct-mutative enabled tool (catalog preflight). */
  preflight(): {
    readonly ok: boolean;
    readonly violation?: 'UNKNOWN_OR_DIRECT_MUTATIVE' | undefined;
  } {
    for (const e of this.entries) {
      if (e.enabled && e.directMutative)
        return { ok: false, violation: 'UNKNOWN_OR_DIRECT_MUTATIVE' };
    }
    return { ok: true };
  }
}

export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
