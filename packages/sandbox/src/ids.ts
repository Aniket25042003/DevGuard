/**
 * C041/C042 — sandbox-local branded identifiers.
 *
 * Branding follows C004 (contracts/primitives.ts): opaque branded strings
 * prevent accidental interchange while remaining plain strings on the wire.
 * C004 owns the canonical patterns; this module reuses the exact same
 * UUID v1–v8 / ULID patterns for concepts C004 does not yet brand
 * (workspace, command, checkout attestation). Provider-side IDs are opaque
 * provider namespaces, bounded but not UUID-shaped.
 */
import { z } from 'zod';

export declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type CommandId = Brand<string, 'CommandId'>;
export type CheckoutAttestationId = Brand<string, 'CheckoutAttestationId'>;
export type LimitProfileId = Brand<string, 'LimitProfileId'>;
/** Opaque TrueForge-owned workspace handle. Never a host filesystem path. */
export type ProviderWorkspaceId = Brand<string, 'ProviderWorkspaceId'>;
/** Opaque TrueForge-owned command handle. */
export type ProviderCommandId = Brand<string, 'ProviderCommandId'>;
/** Deterministic hash of provider/version/verified capability claims. */
export type CapabilitySnapshotId = Brand<string, 'CapabilitySnapshotId'>;

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

/** Capability snapshot ids are deterministic sha256 hex digests. */
function sha256HexSchema<B extends string>(): z.ZodType<Brand<string, B>> {
  return z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'expected a 64-char lowercase hex digest')
    .transform((value) => value as Brand<string, B>);
}

export const sandboxIdSchemas = {
  workspaceId: brandedSchema<'WorkspaceId'>(),
  commandId: brandedSchema<'CommandId'>(),
  checkoutAttestationId: brandedSchema<'CheckoutAttestationId'>(),
  capabilitySnapshotId: sha256HexSchema<'CapabilitySnapshotId'>(),
  limitProfileId: providerIdSchema<'LimitProfileId'>(),
  providerWorkspaceId: providerIdSchema<'ProviderWorkspaceId'>(),
  providerCommandId: providerIdSchema<'ProviderCommandId'>(),
} as const;

/** Monotonic per-aggregate sequence for ordered output streams. */
export const outputSequence = z.number().int().nonnegative();
