/**
 * C045 §15/§23.5 — provider capability verification port.
 *
 * C036 owns the TrueForge capability verification against the pinned
 * provider contract; C045 consumes ONLY the normalized manifest through this
 * port. Unknown manifest entries are ignored (never trusted) by the
 * evaluator, so a stale/foreign manifest fails closed.
 */
import type { Semver } from '../schemas/semver.js';
import type { CapabilityManifest } from '../capabilities/capability-evaluator.js';

export type {
  CapabilityManifest,
  VerifiedCapability,
} from '../capabilities/capability-evaluator.js';

/** Refresh + read the verified capability manifest for the pinned provider. */
export interface ProviderCapabilityPort {
  /** Latest verified manifest; throws/unavailable ⇒ treated as unverified. */
  refresh(): Promise<CapabilityManifest>;
  /** Cached snapshot (no network). */
  current(): CapabilityManifest | undefined;
}

export type { Semver };
