/**
 * C045 §15 — skill/context delivery port (C037 integration point).
 *
 * C037 consumes the compiled, capability-verified bundle and produces the
 * provider turn payload. This port defines the normalized payload contract:
 * trust-ordered sections with provenance markers and runtime slots, plus the
 * resolved context variables the run provides. If the provider cannot
 * preserve the trust ordering/provenance, the adapter must BLOCK agent
 * workflows (C045 §15) instead of degrading silently.
 */
import type { SkillBundleSection, RuntimeSlotKind } from '../skills/skill-bundle-compiler.js';

export interface NormalizedSkillContextPayload {
  readonly schemaVersion: 'skill-context/v1';
  readonly bundleRef: { readonly definitionId: string; readonly version: string };
  readonly bundleDigest: string;
  readonly sections: readonly SkillBundleSection[];
  /** Resolved runtime slot values (empty until C037 binds a run). */
  readonly runtimeSlots: Readonly<Record<RuntimeSlotKind, string>>;
  /** Declared-and-satisfied context variables (missing ⇒ not injected). */
  readonly contextVariables: readonly string[];
}

/** Builds the provider-neutral skill/context payload from a verified bundle. */
export interface SkillContextPort {
  normalize(options: {
    readonly definitionId: string;
    readonly version: string;
    readonly bundleDigest: string;
    readonly sections: readonly SkillBundleSection[];
    readonly runtimeSlotValues: Readonly<Record<RuntimeSlotKind, string>>;
    readonly contextVariables: readonly string[];
  }): NormalizedSkillContextPayload;
}

export type { RuntimeSlotKind };
