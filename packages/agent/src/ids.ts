/**
 * C036 — agent-local branded identifiers.
 *
 * Branding follows C004 (contracts/primitives.ts): opaque branded strings
 * prevent accidental interchange while remaining plain strings on the wire.
 * C004 already brands `AgentSessionRefId` and `TurnRefId`; this module brands
 * the provider-neutral agent concepts C004 does not yet cover (contract
 * snapshot, verification run, required action, provider ref). Provider-side
 * handles are opaque provider namespaces, bounded but not UUID-shaped.
 */
import { z } from 'zod';

export declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ContractSnapshotId = Brand<string, 'ContractSnapshotId'>;
export type VerificationRunId = Brand<string, 'VerificationRunId'>;
export type RequiredActionId = Brand<string, 'RequiredActionId'>;
export type CapabilityClaimId = Brand<string, 'CapabilityClaimId'>;
/** Opaque TrueForge-owned server/agent handle. */
export type ProviderServerId = Brand<string, 'ProviderServerId'>;
/** Opaque provider session/turn handles — never DevGuard IDs. */
export type ProviderRef = Brand<string, 'ProviderRef'>;

// Same canonical patterns as C004 (UUIDs lowercase, ULIDs uppercase).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const ID_SCHEMA = z
  .string()
  .min(26)
  .max(36)
  .refine(
    (value) => UUID_PATTERN.test(value) || ULID_PATTERN.test(value),
    'expected a well-formed UUID v1-v8 or ULID',
  );

function brandedSchema<B extends string>(): z.ZodType<Brand<string, B>> {
  return ID_SCHEMA.transform((value) => value as Brand<string, B>);
}

/** Opaque provider handles: bounded printable ASCII, never path-like. */
function providerIdSchema<B extends string>(): z.ZodType<Brand<string, B>> {
  return z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/, 'expected an opaque provider handle')
    .transform((value) => value as Brand<string, B>);
}

/** Deterministic sha256 hex digests for snapshots / run keys. */
function sha256HexSchema<B extends string>(): z.ZodType<Brand<string, B>> {
  return z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'expected a 64-char lowercase hex digest')
    .transform((value) => value as Brand<string, B>);
}

export const agentIdSchemas = {
  contractSnapshotId: sha256HexSchema<'ContractSnapshotId'>(),
  verificationRunId: brandedSchema<'VerificationRunId'>(),
  requiredActionId: brandedSchema<'RequiredActionId'>(),
  capabilityClaimId: sha256HexSchema<'CapabilityClaimId'>(),
  providerServerId: providerIdSchema<'ProviderServerId'>(),
  providerRef: providerIdSchema<'ProviderRef'>(),
} as const;
