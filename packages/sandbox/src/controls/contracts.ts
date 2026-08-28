/**
 * C043 §8/§9/§10 — containment profile contracts + FSM.
 *
 * Global, repository-policy, workflow, command-class, and provider constraints
 * compile into an immutable effective profile. Network is DENIED by default
 * unless an action/phase policy grants a narrow allowlist. Restrictive defaults
 * and hard global ceilings cannot be loosened by repository text or model
 * output. Unenforceable profiles are rejected, never silently weakened.
 */
import { z } from 'zod';

export const CONTAINMENT_SCHEMA_VERSION = 1 as const;

export const NETWORK_POLICY = ['deny_all', 'allowlist_only', 'allow_private'] as const;
export type NetworkPolicy = (typeof NETWORK_POLICY)[number];

export const PROFILE_STATES = [
  'REQUESTED',
  'COMPILING',
  'VERIFYING_CAPABILITIES',
  'APPLYING',
  'ATTESTING',
  'ACTIVE',
  'BLOCKED_UNSUPPORTED',
  'BLOCKED_POLICY',
  'FAILED',
  'VIOLATED',
  'TERMINATING',
  'TERMINATED',
  'TERMINATION_FAILED',
] as const;
export type ProfileState = (typeof PROFILE_STATES)[number];

export const DEFAULT_GLOBAL_CEILINGS = {
  maxCpuMillis: 650 * 1000,
  maxMemoryBytes: 4 * 1024 * 1024 * 1024,
  maxDiskBytes: 16 * 1024 * 1024 * 1024,
  maxProcesses: 64,
  maxWallMillis: 15 * 60_000,
} as const;

export const effectiveContainmentProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    generation: z.number().int().nonnegative(),
    network: z.enum(NETWORK_POLICY),
    allowedDestinations: z.array(z.string().max(200)).max(64),
    maxCpuMillis: z.number().int().positive(),
    maxMemoryBytes: z.number().int().positive(),
    maxDiskBytes: z.number().int().positive(),
    maxProcesses: z.number().int().positive(),
    maxWallMillis: z.number().int().positive(),
    shellModeAllowed: z.boolean().default(false),
    parallelReadCommands: z.boolean().default(false),
    secretRefs: z.array(z.string().max(128)).max(64),
  })
  .strict();
export interface EffectiveContainmentProfile {
  readonly id: string;
  readonly generation: number;
  readonly network: NetworkPolicy;
  readonly allowedDestinations: readonly string[];
  readonly maxCpuMillis: number;
  readonly maxMemoryBytes: number;
  readonly maxDiskBytes: number;
  readonly maxProcesses: number;
  readonly maxWallMillis: number;
  readonly shellModeAllowed: boolean;
  readonly parallelReadCommands: boolean;
  readonly secretRefs: readonly string[];
}

export interface ControlAttestation {
  readonly profileId: string;
  readonly provider: string;
  readonly attestedAtIso: string;
  readonly capabilityDigest: string;
}

export interface ProfileCommandClass {
  readonly class: string;
  readonly extraWallMillis: number;
}

export interface ContainmentControllerDeps {
  readonly globalCeilings?: Partial<typeof DEFAULT_GLOBAL_CEILINGS>;
  readonly shellModePolicyAllowed?: boolean;
  readonly clock?: { readonly nowIso: () => string };
}

export type ProfileTransitionVerdict =
  | { readonly allowed: true; readonly to: ProfileState }
  | { readonly allowed: false; readonly code: string; readonly detail: string };

const PROFILE_EDGES: Readonly<Record<string, ReadonlyArray<[ProfileState, ProfileState]>>> = {
  compile: [['REQUESTED', 'COMPILING']],
  verify: [['COMPILING', 'VERIFYING_CAPABILITIES']],
  apply: [['VERIFYING_CAPABILITIES', 'APPLYING']],
  attest: [['APPLYING', 'ATTESTING']],
  active: [['ATTESTING', 'ACTIVE']],
  blocked_unsupported: [
    ['VERIFYING_CAPABILITIES', 'BLOCKED_UNSUPPORTED'],
    ['APPLYING', 'BLOCKED_UNSUPPORTED'],
  ],
  blocked_policy: [['COMPILING', 'BLOCKED_POLICY']],
  fail: [
    ['COMPILING', 'FAILED'],
    ['APPLYING', 'FAILED'],
  ],
  violated: [['ACTIVE', 'VIOLATED']],
  terminate: [['VIOLATED', 'TERMINATING']],
  terminated: [['TERMINATING', 'TERMINATED']],
  termination_failed: [['TERMINATING', 'TERMINATION_FAILED']],
};

export function resolveProfileEdge(from: ProfileState, trigger: string): ProfileTransitionVerdict {
  const match = (PROFILE_EDGES[trigger] ?? []).find(([f]) => f === from);
  return match === undefined
    ? {
        allowed: false,
        code: 'SANDBOX_PROFILE_ILLEGAL_TRANSITION',
        detail: `'${trigger}' from '${from}'`,
      }
    : { allowed: true, to: match[1] };
}

export const containmentContractsSchema = { effectiveContainmentProfileSchema };
