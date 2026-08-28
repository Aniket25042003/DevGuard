/**
 * C045 §23.2 — explicit catalogs for schemas, tools and capabilities.
 *
 * The DEFINITION registry validates every cross-reference against these
 * catalogs and FAILS CLOSED on anything unknown (C045 §4.6): an unknown
 * action/validator/tool/schema/capability id blocks the definition (and, for
 * mandatory definitions, startup). Action and validator vocabularies are the
 * canonical C004 enums; schemas and tools are typed ports so provider-owned
 * registries (C024, C037) plug in from the composition root.
 */
import type { z } from 'zod';
import { ActionType, ValidatorKind } from '@devguard/contracts';
import type { ActionTypeMember, ValidatorKindMember } from '../schemas/workflow-definition.js';

/** Canonical action ceiling vocabulary (C004). */
export const KNOWN_ACTION_TYPES: readonly ActionTypeMember[] = ActionType.options;

/** Canonical validator vocabulary (C004). */
export const KNOWN_VALIDATOR_KINDS: readonly ValidatorKindMember[] = ValidatorKind.options;

export function isKnownActionType(value: string): value is ActionTypeMember {
  return (KNOWN_ACTION_TYPES as readonly string[]).includes(value);
}

export function isKnownValidatorKind(value: string): value is ValidatorKindMember {
  return (KNOWN_VALIDATOR_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Schema catalog (typed port; C037/composition root supplies zod schemas)
// ---------------------------------------------------------------------------

export interface SchemaEntry {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly schema: z.ZodType<unknown>;
}

/**
 * Versioned input/output schema registry. C045 needs id+version+digest to
 * seal snapshots and a parser to validate launch input; the zod schemas are
 * provider-neutral and supplied by the composition root.
 */
export interface SchemaCatalogPort {
  /** Resolve by ref; undefined ⇒ unknown (fail closed). */
  getSchema(ref: { readonly id: string; readonly version: string }): SchemaEntry | undefined;
}

/** In-process implementation for tests and app composition. */
export function createSchemaCatalog(entries: readonly SchemaEntry[]): SchemaCatalogPort {
  const byIdVersion = new Map<string, SchemaEntry>();
  const identity = (id: string, version: string) => `${id}@${version}`;
  for (const entry of entries) {
    byIdVersion.set(identity(entry.id, entry.version), entry);
  }
  return {
    getSchema(ref) {
      return byIdVersion.get(identity(ref.id, ref.version));
    },
  };
}

// ---------------------------------------------------------------------------
// Tool catalog (typed port; C024 owns the persisted registry)
// ---------------------------------------------------------------------------

export interface ToolBindingInfo {
  readonly id: string;
  readonly registryVersion: string;
}

/** Tool registry lookups used by definition validation and snapshots. */
export interface ToolCatalogPort {
  /** Resolve an exact id+registryVersion; undefined ⇒ unknown (fail closed). */
  getTool(ref: {
    readonly id: string;
    readonly registryVersion: string;
  }): ToolBindingInfo | undefined;
}

/** In-process implementation for tests and app composition. */
export function createToolCatalog(entries: readonly ToolBindingInfo[]): ToolCatalogPort {
  const byKey = new Map<string, ToolBindingInfo>();
  const key = (id: string, version: string) => `${id}@${version}`;
  for (const entry of entries) {
    byKey.set(key(entry.id, entry.registryVersion), entry);
  }
  return {
    getTool(ref) {
      return byKey.get(key(ref.id, ref.registryVersion));
    },
  };
}

// ---------------------------------------------------------------------------
// Capability catalog (C045 declares; C036 verifies against the provider)
// ---------------------------------------------------------------------------

export interface CapabilityInfo {
  readonly id: string;
  readonly description: string;
}

/**
 * Known provider capability vocabulary (C045 §15/§23.5). Extensions register
 * new ids BEFORE definitions may reference them — unknown ids fail closed.
 */
export const KNOWN_CAPABILITIES: readonly CapabilityInfo[] = Object.freeze([
  {
    id: 'trueforge.skill_assets',
    description: 'Versioned skill asset upload and digest-addressed retrieval.',
  },
  {
    id: 'trueforge.context_variables',
    description: 'Structured context variable mechanism for run payloads.',
  },
  {
    id: 'trueforge.structured_turn',
    description: 'Structured turn payload with normalized skill/context ordering.',
  },
  { id: 'github.actions', description: 'GitHub adapter action execution (C019-C021).' },
  { id: 'sandbox.commands', description: 'Isolated command execution (C028).' },
]);

export const KNOWN_CAPABILITY_IDS: readonly string[] = KNOWN_CAPABILITIES.map((entry) => entry.id);

export function isKnownCapability(id: string): boolean {
  return KNOWN_CAPABILITY_IDS.includes(id);
}

function capabilityInfo(id: string): CapabilityInfo | undefined {
  return KNOWN_CAPABILITIES.find((entry) => entry.id === id);
}

/** Returns stable description or undefined for unknown capability ids. */
export function capabilityDescription(id: string): string | undefined {
  return capabilityInfo(id)?.description;
}
