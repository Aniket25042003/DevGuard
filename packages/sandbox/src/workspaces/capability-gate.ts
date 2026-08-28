/**
 * C041 §5/§15/§18 — capability gate for TrueForge workspace operations.
 *
 * The gate evaluates a provider-neutral capability MANIFEST (produced later
 * by the C036 verified adapter) against the operations C041 requires. Rules:
 * - Unknown capability names fail closed (SANDBOX_CAPABILITY_UNSUPPORTED).
 * - Declared-but-unverified capabilities fail closed.
 * - Isolation claims are mandatory and must be PROVEN; absence of proof is
 *   SANDBOX_ISOLATION_UNVERIFIED, never a silent downgrade.
 * - Missing mandatory lifecycle/cancellation/limits/secrets/network controls
 *   visibly block workspace readiness (no host fallback exists).
 * Provider SDK types never cross this boundary; the manifest is validated
 * with a strict zod schema first.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const WORKSPACE_CAPABILITY_NAMES = [
  'workspace.create',
  'workspace.inspect',
  'workspace.cancel',
  'workspace.destroy',
  'isolation.process',
  'isolation.filesystem',
  'isolation.no_host_bind',
  'checkout.native',
  'checkout.sandboxed_git',
  'limits.cpu',
  'limits.memory',
  'limits.network',
  'limits.secrets',
  'limits.cancellation',
] as const;

export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITY_NAMES)[number];

export interface ProviderCapabilityClaim {
  readonly name: WorkspaceCapability;
  readonly verified: boolean;
}

/** Strict boundary schema; unknown/malformed manifests fail closed. */
export const providerCapabilityManifestSchema: z.ZodType<{
  readonly provider: string;
  readonly providerVersion: string;
  readonly capabilities: readonly ProviderCapabilityClaim[];
}> = z
  .object({
    provider: z.string().min(1).max(64),
    providerVersion: z.string().min(1).max(128),
    capabilities: z
      .array(
        z
          .object({
            name: z.enum(WORKSPACE_CAPABILITY_NAMES),
            verified: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();

export type ProviderCapabilityManifest = z.infer<typeof providerCapabilityManifestSchema>;

export interface WorkspaceCapabilityProfile {
  readonly name: string;
  /** Every listed capability must be present and verified. */
  readonly required: readonly WorkspaceCapability[];
  /** At least one of these must be present and verified (checkout channel). */
  readonly oneOf?: readonly WorkspaceCapability[] | undefined;
}

export const DEFAULT_WORKSPACE_CAPABILITY_PROFILE = {
  name: 'sandbox-workspace-v1',
  required: [
    'workspace.create',
    'workspace.inspect',
    'workspace.cancel',
    'workspace.destroy',
    'isolation.process',
    'isolation.filesystem',
    'isolation.no_host_bind',
    'limits.cpu',
    'limits.memory',
    'limits.network',
    'limits.secrets',
    'limits.cancellation',
  ] as const,
  oneOf: ['checkout.native', 'checkout.sandboxed_git'] as const,
} satisfies WorkspaceCapabilityProfile;

export type CapabilityDecision =
  | {
      readonly allowed: true;
      readonly capabilitySnapshotId: string;
      readonly provider: string;
      readonly providerVersion: string;
      readonly checked: readonly WorkspaceCapability[];
    }
  | {
      readonly allowed: false;
      readonly blockedCapability: string;
      readonly reason: 'unsupported' | 'unverified';
      readonly code: 'SANDBOX_CAPABILITY_UNSUPPORTED' | 'SANDBOX_ISOLATION_UNVERIFIED';
    };

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(WORKSPACE_CAPABILITY_NAMES);

/** Deterministic snapshot id over provider/version/verified claims (C041 §8). */
export function capabilitySnapshotId(manifest: ProviderCapabilityManifest): string {
  const verified = manifest.capabilities
    .filter((claim) => claim.verified)
    .map((claim) => claim.name)
    .sort();
  return createHash('sha256')
    .update(
      `provider=${manifest.provider}|version=${manifest.providerVersion}|${verified.join(',')}`,
    )
    .digest('hex');
}

export function requireWorkspaceCapabilities(
  manifest: ProviderCapabilityManifest,
  profile: WorkspaceCapabilityProfile = DEFAULT_WORKSPACE_CAPABILITY_PROFILE,
): CapabilityDecision {
  const parsed = providerCapabilityManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return {
      allowed: false,
      blockedCapability: 'manifest',
      reason: 'unsupported',
      code: 'SANDBOX_CAPABILITY_UNSUPPORTED',
    };
  }
  const claims = new Map<string, boolean>();
  for (const claim of parsed.data.capabilities) {
    claims.set(claim.name, claim.verified);
  }

  // Unknown claims fail closed before anything else is evaluated.
  for (const claim of parsed.data.capabilities) {
    if (!KNOWN_CAPABILITIES.has(claim.name)) {
      return {
        allowed: false,
        blockedCapability: claim.name,
        reason: 'unsupported',
        code: 'SANDBOX_CAPABILITY_UNSUPPORTED',
      };
    }
  }

  const absent = (capability: WorkspaceCapability) => !claims.has(capability);
  const missingMandatory = profile.required.filter(
    (capability) => absent(capability) || claims.get(capability) !== true,
  );
  if (missingMandatory.length > 0) {
    const capability = missingMandatory[0] as WorkspaceCapability;
    const isIsolationClaim =
      capability === 'isolation.process' ||
      capability === 'isolation.filesystem' ||
      capability === 'isolation.no_host_bind';
    return isIsolationClaim
      ? {
          allowed: false,
          blockedCapability: capability,
          reason: 'unverified',
          code: 'SANDBOX_ISOLATION_UNVERIFIED',
        }
      : {
          allowed: false,
          blockedCapability: capability,
          reason: 'unsupported',
          code: 'SANDBOX_CAPABILITY_UNSUPPORTED',
        };
  }

  const alternatives = profile.oneOf ?? [];
  if (
    alternatives.length > 0 &&
    !alternatives.some((capability) => claims.get(capability) === true)
  ) {
    return {
      allowed: false,
      blockedCapability: alternatives.join('|'),
      reason: 'unsupported',
      code: 'SANDBOX_CAPABILITY_UNSUPPORTED',
    };
  }

  return {
    allowed: true,
    capabilitySnapshotId: capabilitySnapshotId(parsed.data),
    provider: parsed.data.provider,
    providerVersion: parsed.data.providerVersion,
    checked: [...profile.required, ...(profile.oneOf ?? [])],
  };
}
