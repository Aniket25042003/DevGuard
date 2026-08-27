/**
 * C024 §5/§8/§10 — typed tool definitions, provider manifests and the
 * ToolRegistry with immutable snapshot hashing.
 *
 * Invariants (§17): one action per tool; aliases may not fan out; unknown
 * tool/provider/version resolves DENY UNKNOWN_CAPABILITY; only ENABLED tools
 * are exposed or executable; snapshot identity is its hash.
 */
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { findActionDefinition, type ActionDefinition } from '../actions/catalog.js';

export const PROVIDER_IDS = ['github_adapter', 'trueforge_mcp', 'sandbox', 'webhook'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const TOOL_STATUSES = [
  'DISCOVERED',
  'VERIFIED',
  'ENABLED',
  'DEPRECATED',
  'DISABLED',
  'INCOMPATIBLE',
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** Metadata extracted from a concrete tool input for C025 classification. */
export interface ActionMetadata {
  readonly targetRef?: string | undefined;
  readonly baseSha?: string | undefined;
  readonly headSha?: string | undefined;
  readonly path?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly commandFingerprint?: string | undefined;
}

export interface ToolDefinitionInput<I = unknown> {
  readonly id: string;
  readonly provider: ProviderId;
  readonly providerToolName: string;
  /** Semver range the pinned capability must satisfy. */
  readonly capabilityVersionRange: string;
  readonly actionId: string;
  readonly inputSchema: z.ZodType<I>;
  readonly metadataExtractor: (input: I) => ActionMetadata;
}

export interface RegisteredTool {
  readonly id: string;
  readonly provider: ProviderId;
  readonly providerToolName: string;
  readonly capabilityVersionRange: string;
  readonly actionId: string;
  readonly status: ToolStatus;
}

/** Raw intercepted call from any provider — everything untrusted until resolved. */
export interface RawProviderToolCall {
  readonly provider: string;
  readonly toolName: string;
  readonly capabilityVersion?: string | undefined;
  readonly payload: unknown;
}

const semverish = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * A provider declares installed capabilities; verification compares each
 * declared version against registered tools' ranges and the manifest hash.
 */
export interface ProviderCapabilityManifest {
  readonly provider: ProviderId;
  readonly apiVersion: string;
  readonly capabilities: Readonly<Record<string, string>>;
  readonly manifestHash: string;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** C024 §10 ResolveResult discriminated union — never an untyped fallback. */
export type ResolveResult =
  | {
      readonly outcome: 'RESOLVED';
      readonly toolId: string;
      readonly action: ActionDefinition;
      readonly validatedInput: unknown;
      readonly metadata: ActionMetadata;
      readonly registrySnapshotId: string;
    }
  | {
      readonly outcome: 'DENIED_UNKNOWN_CAPABILITY';
      readonly reasonCode: 'UNKNOWN_TOOL' | 'UNKNOWN_PROVIDER' | 'UNKNOWN_ACTION';
      readonly detail: string;
    }
  | {
      readonly outcome: 'DENIED_INVALID_INPUT';
      readonly reasonCode: 'INPUT_SCHEMA_REJECTED';
      readonly fieldErrors: readonly string[];
    }
  | {
      readonly outcome: 'DENIED_INCOMPATIBLE';
      readonly reasonCode: 'CAPABILITY_VERSION_DRIFT' | 'TOOL_NOT_VERIFIED' | 'PROVIDER_DRIFT';
      readonly detail: string;
    }
  | {
      readonly outcome: 'DENIED_DISABLED';
      readonly reasonCode: 'TOOL_DISABLED' | 'TOOL_DEPRECATED' | 'TOOL_DISCOVERED_ONLY';
      readonly detail: string;
    };

export class RegistryBuildError extends Error {}

interface RegistryEntry {
  readonly tool: RegisteredTool;
  readonly inputSchema: z.ZodType<unknown>;
  readonly metadataExtractor: (input: unknown) => ActionMetadata;
  readonly action: ActionDefinition;
}

export interface RegistrySnapshot {
  readonly registryVersionId: string;
  readonly snapshotHash: string;
  readonly createdAtIso: string;
  readonly entries: readonly RegisteredTool[];
}

/** Build-validate-and-freeze a registry. Duplicate/incomplete definitions abort. */
export function buildRegistry(
  definitions: ReadonlyArray<ToolDefinitionInput<never>>,
  options: { now?: () => Date } = {},
): {
  registryVersionId: string;
  snapshot: () => RegistrySnapshot;
  resolve(rawCall: RawProviderToolCall): ResolveResult;
  listForWorkflow(actionIds: ReadonlySet<string>): readonly RegisteredTool[];
  verifyCapabilities(manifest: ProviderCapabilityManifest): {
    ok: boolean;
    problems: readonly string[];
  };
} {
  // ---- build validation (C024 §23-4): collisions/incompleteness stop publication
  const byProviderName = new Map<string, RegistryEntry>();
  const idsSeen = new Set<string>();
  const problems: string[] = [];
  for (const definition of definitions as unknown as ReadonlyArray<ToolDefinitionInput>) {
    if (!idsSeen.add(definition.id)) {
      throw new RegistryBuildError(`duplicate tool id '${definition.id}'`);
    }
    const key = `${definition.provider}:${definition.providerToolName}`;
    if (byProviderName.has(key)) {
      throw new RegistryBuildError(
        `provider alias collision: '${key}' maps to multiple actions (${definition.actionId})`,
      );
    }
    const action = findActionDefinition(definition.actionId);
    if (!action) {
      throw new RegistryBuildError(
        `tool '${definition.id}' references unregistered action '${definition.actionId}'`,
      );
    }
    if (!semverish.test(definition.capabilityVersionRange.replace(/[~^>=<\s]/g, ''))) {
      problems.push(
        `tool '${definition.id}' has unparsable capability range '${definition.capabilityVersionRange}'`,
      );
    }
    byProviderName.set(key, {
      tool: Object.freeze({
        id: definition.id,
        provider: definition.provider,
        providerToolName: definition.providerToolName,
        capabilityVersionRange: definition.capabilityVersionRange,
        actionId: definition.actionId,
        status: 'ENABLED',
      }),
      inputSchema: definition.inputSchema,
      metadataExtractor: definition.metadataExtractor as (input: unknown) => ActionMetadata,
      action,
    });
  }
  if (problems.length > 0) throw new RegistryBuildError(problems.join('; '));

  const entries = [...byProviderName.values()];
  const snapshotHash = createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((e) => [
          e.tool.id,
          e.tool.provider,
          e.tool.providerToolName,
          e.tool.capabilityVersionRange,
          e.tool.actionId,
          e.tool.status,
        ]),
      ),
    )
    .digest('hex');
  const registryVersionId = `registry-${snapshotHash.slice(0, 16)}`;
  const makeSnapshot = (): RegistrySnapshot =>
    Object.freeze({
      registryVersionId,
      snapshotHash,
      createdAtIso: (options.now ?? (() => new Date()))().toISOString(),
      entries: entries.map((e) => e.tool),
    });

  return {
    registryVersionId,
    snapshot: makeSnapshot,

    resolve(rawCall: RawProviderToolCall): ResolveResult {
      if (!isRecordLike(rawCall) || typeof rawCall.toolName !== 'string') {
        return {
          outcome: 'DENIED_UNKNOWN_CAPABILITY',
          reasonCode: 'UNKNOWN_TOOL',
          detail: 'malformed call envelope',
        };
      }
      if (!PROVIDER_IDS.includes(rawCall.provider as ProviderId)) {
        return {
          outcome: 'DENIED_UNKNOWN_CAPABILITY',
          reasonCode: 'UNKNOWN_PROVIDER',
          detail: `provider '${String(rawCall.provider)}' is not registered`,
        };
      }
      const entry = byProviderName.get(`${rawCall.provider}:${rawCall.toolName}`);
      if (!entry) {
        return {
          outcome: 'DENIED_UNKNOWN_CAPABILITY',
          reasonCode: 'UNKNOWN_TOOL',
          detail: `tool '${rawCall.provider}/${rawCall.toolName}' is not in registry ${registryVersionId}`,
        };
      }
      if (entry.tool.status !== 'ENABLED') {
        return {
          outcome: 'DENIED_DISABLED',
          reasonCode:
            entry.tool.status === 'DISCOVERED'
              ? 'TOOL_DISCOVERED_ONLY'
              : entry.tool.status === 'DEPRECATED'
                ? 'TOOL_DEPRECATED'
                : 'TOOL_DISABLED',
          detail: `tool status ${entry.tool.status}`,
        };
      }

      // Capability version negotiation: declared or manifest version must satisfy range.
      const declaredVersion = rawCall.capabilityVersion;
      if (
        declaredVersion === undefined ||
        !versionSatisfies(declaredVersion, entry.tool.capabilityVersionRange)
      ) {
        return {
          outcome: 'DENIED_INCOMPATIBLE',
          reasonCode: 'CAPABILITY_VERSION_DRIFT',
          detail: `declared ${declaredVersion} outside ${entry.tool.capabilityVersionRange}`,
        };
      }

      const parsed = entry.inputSchema.safeParse(rawCall.payload);
      if (!parsed.success) {
        return {
          outcome: 'DENIED_INVALID_INPUT',
          reasonCode: 'INPUT_SCHEMA_REJECTED',
          fieldErrors: parsed.error.issues
            .slice(0, 10)
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        };
      }
      return {
        outcome: 'RESOLVED',
        toolId: entry.tool.id,
        action: entry.action,
        validatedInput: parsed.data,
        metadata: entry.metadataExtractor(parsed.data),
        registrySnapshotId: registryVersionId,
      };
    },

    listForWorkflow(actionIds: ReadonlySet<string>): readonly RegisteredTool[] {
      // Least privilege: intersect enabled tools with workflow-declared actions.
      // Exposure ≠ authorization; per-call evaluation still happens (C030).
      return entries
        .filter((entry) => entry.tool.status === 'ENABLED' && actionIds.has(entry.action.id))
        .map((entry) => entry.tool);
    },

    verifyCapabilities(manifest: ProviderCapabilityManifest): {
      ok: boolean;
      problems: readonly string[];
    } {
      const found: string[] = [];
      for (const name of Object.keys(manifest.capabilities)) {
        if (
          !entries.some(
            (e) => e.tool.provider === manifest.provider && e.tool.providerToolName === name,
          )
        )
          found.push(`unknown capability ${name}`);
      }
      for (const entry of entries.filter((e) => e.tool.provider === manifest.provider)) {
        const declared = manifest.capabilities[entry.tool.providerToolName];
        if (declared === undefined) continue; // not offered this deployment
        if (!semverish.test(declared)) found.push(`malformed version for ${entry.tool.id}`);
        else if (!versionSatisfies(declared, entry.tool.capabilityVersionRange)) {
          found.push(
            `drift for ${entry.tool.id}: declared ${declared}, requires ${entry.tool.capabilityVersionRange}`,
          );
        }
      }
      void found;
      // Hash pinning: consumers record which exact manifest verified a run.
      // apiVersion may be a semver or an API date stamp (e.g. GitHub's
      // '2026-01-01' style): both are accepted as immutable version pins.
      const versionStamp = /^\d+\.\d+\.\d+$|^\d{4}-\d{2}-\d{2}$/.test(manifest.apiVersion);
      const canonical = JSON.stringify({
        provider: manifest.provider,
        apiVersion: manifest.apiVersion,
        capabilities: Object.fromEntries(Object.entries(manifest.capabilities).sort()),
      });
      const hashValid =
        /^[a-f0-9]{64}$/.test(manifest.manifestHash) &&
        createHash('sha256').update(canonical).digest('hex') === manifest.manifestHash;
      const ok = found.length === 0 && versionStamp && hashValid;
      return {
        ok,
        problems: ok
          ? []
          : [
              ...found,
              ...(versionStamp ? [] : ['malformed apiVersion']),
              ...(hashValid ? [] : ['invalid manifestHash']),
            ],
      };
    },
  };
}

/** Minimal caret/tilde/exact matcher adequate for pinned internal ranges. */
export function versionSatisfies(version: string, range: string): boolean {
  if (!semverish.test(version)) return false;
  const clean = range.trim();
  if (clean.startsWith('^')) {
    const base = parseSemver(clean.slice(1));
    const upper =
      base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
    return (
      compareSemver(version, clean.slice(1)) >= 0 && compareSemver(version, upper.join('.')) < 0
    );
  }
  if (clean.startsWith('~')) {
    const base = parseSemver(clean.slice(1));
    return (
      compareSemver(version, clean.slice(1)) >= 0 &&
      compareSemver(version, `${base[0]}.${base[1] + 1}.0`) < 0
    );
  }
  if (clean.startsWith('>=')) return compareSemver(version, clean.slice(2)) >= 0;
  if (/^\d/.test(clean)) return compareSemver(version, clean) === 0;
  return false;
}

function parseSemver(v: string): [number, number, number] {
  const core = v.split('-')[0]?.split('+')[0] ?? '0.0.0';
  const parts = core.split('.').map((n) => Number.parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
