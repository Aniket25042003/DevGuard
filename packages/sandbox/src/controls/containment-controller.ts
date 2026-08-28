/**
 * C043 §9/§10/§12 — ContainmentController + network policy compiler.
 *
 * Compiles immutable global/repository/workflow/class/provider constraints into
 * an `EffectiveContainmentProfile`, verifies provider capability support, and
 * attests a successfully applied control. A profile requirement the provider
 * cannot enforce is BLOCKED_UNSUPPORTED — it is never silently weakened. Network
 * is DENY by default; only an explicit narrow allowlist is honored.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_GLOBAL_CEILINGS,
  effectiveContainmentProfileSchema,
  type ControlAttestation,
  type ContainmentControllerDeps,
  type EffectiveContainmentProfile,
  type NetworkPolicy,
} from './contracts.js';

export interface ProfileSourceConstraints {
  readonly network?: NetworkPolicy | undefined;
  readonly allowedDestinations?: readonly string[] | undefined;
  readonly maxWallMillis?: number | undefined;
  readonly maxCpuMillis?: number | undefined;
  readonly shellModeAllowed?: boolean | undefined;
}

export interface ProviderCapabilityProbe {
  readonly supports: {
    readonly networkDeny: boolean;
    readonly allowlist: boolean;
    readonly resourceLimits: boolean;
    readonly processKill: boolean;
  };
}

export interface ContainmentProvider {
  probe(): Promise<ProviderCapabilityProbe>;
  apply(profile: EffectiveContainmentProfile): Promise<{ ok: true } | { ok: false; code: string }>;
}

export type CompileResult =
  | { readonly ok: true; readonly profile: EffectiveContainmentProfile }
  | { readonly ok: false; readonly code: 'BLOCKED_POLICY'; readonly detail: string };

export type ApplyResult =
  | { readonly ok: true; readonly attestation: ControlAttestation }
  | {
      readonly ok: false;
      readonly code: 'BLOCKED_UNSUPPORTED' | 'FAILED';
      readonly detail: string;
    };

export class ContainmentController {
  constructor(
    private readonly deps: ContainmentControllerDeps,
    private readonly provider: ContainmentProvider,
  ) {}

  compile(input: {
    source: ProfileSourceConstraints;
    class: string;
    classExtraWallMillis?: number;
  }): CompileResult {
    if (input.source.shellModeAllowed && !(this.deps.shellModePolicyAllowed ?? false)) {
      return { ok: false, code: 'BLOCKED_POLICY', detail: 'shell mode not policy-approved' };
    }
    const ceilings = { ...DEFAULT_GLOBAL_CEILINGS, ...this.deps.globalCeilings };
    // Global ceilings are a hard cap: a source requirement may never exceed them.
    const wall =
      Math.min(input.source.maxWallMillis ?? ceilings.maxWallMillis, ceilings.maxWallMillis) +
      Math.min(input.classExtraWallMillis ?? 0, ceilings.maxWallMillis);
    const profile: EffectiveContainmentProfile = {
      id: `cp-${sha256(JSON.stringify({ class: input.class, network: input.source.network, allowedDestinations: input.source.allowedDestinations, maxWallMillis: wall, maxCpuMillis: input.source.maxCpuMillis, shellModeAllowed: input.source.shellModeAllowed })).slice(0, 16)}`,
      generation: 1,
      network: compileNetworkPolicy(input.source),
      allowedDestinations:
        input.source.network === 'allowlist_only' ? (input.source.allowedDestinations ?? []) : [],
      maxCpuMillis: Math.min(
        input.source.maxCpuMillis ?? ceilings.maxCpuMillis,
        ceilings.maxCpuMillis,
      ),
      maxMemoryBytes: ceilings.maxMemoryBytes,
      maxDiskBytes: ceilings.maxDiskBytes,
      maxProcesses: ceilings.maxProcesses,
      maxWallMillis: wall,
      shellModeAllowed: input.source.shellModeAllowed === true,
      parallelReadCommands: false,
      secretRefs: [],
    };
    const parsed = effectiveContainmentProfileSchema.safeParse(profile);
    return parsed.success
      ? { ok: true, profile: parsed.data }
      : { ok: false, code: 'BLOCKED_POLICY', detail: 'compiled profile violates policy' };
  }

  async apply(profile: EffectiveContainmentProfile): Promise<ApplyResult> {
    let caps: ProviderCapabilityProbe;
    try {
      caps = await this.provider.probe();
    } catch {
      return { ok: false, code: 'FAILED', detail: 'provider probe failed' };
    }
    const s = caps.supports;
    if (!s.networkDeny || !s.allowlist || !s.resourceLimits || !s.processKill) {
      return {
        ok: false,
        code: 'BLOCKED_UNSUPPORTED',
        detail: 'provider cannot enforce requested controls',
      };
    }
    let applied;
    try {
      applied = await this.provider.apply(profile);
    } catch {
      return { ok: false, code: 'FAILED', detail: 'provider apply failed' };
    }
    if (!applied.ok)
      return {
        ok: false,
        code: applied.code === 'BLOCKED_UNSUPPORTED' ? 'BLOCKED_UNSUPPORTED' : 'FAILED',
        detail: applied.code,
      };
    const capabilityDigest = sha256(JSON.stringify(caps));
    return {
      ok: true,
      attestation: {
        profileId: profile.id,
        provider: 'trueforge',
        attestedAtIso: this.deps.clock?.nowIso() ?? new Date().toISOString(),
        capabilityDigest,
      },
    };
  }
}

export function compileNetworkPolicy(source: ProfileSourceConstraints): NetworkPolicy {
  if (source.allowedDestinations !== undefined && source.allowedDestinations.length > 0)
    return 'allowlist_only';
  return source.network ?? 'deny_all';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
