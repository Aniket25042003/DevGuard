/**
 * CP002 §2/§23 — binding matrix for the API composition root.
 *
 * Documents every port the API exposes to route modules and which adapter kind
 * satisfies it. The matrix is the single source for `validateReadiness`: a
 * `volatile` binding is only ever permitted in the `test` environment (or in
 * `development` behind the explicit `DEVGUARD_ALLOW_VOLATILE_AUTH=true` flag).
 *
 * Adapters that are not yet durable must FAIL (unavailable), never silently
 * succeed with an empty store — "do not pretend success" (CP002 §15/§16).
 */

/** Stable marker value carried by every volatile (in-memory) adapter. */
export const VOLATILE_BINDING_KIND = 'volatile' as const;

export interface VolatileBindingMarker {
  readonly bindingKind: typeof VOLATILE_BINDING_KIND;
  /** Human-readable binding identity for readiness diagnostics. */
  readonly bindingName: string;
}

/** True when `value` is a volatile adapter that must not ship to production. */
export function isVolatileBinding(value: unknown): boolean {
  const marker = value as Partial<VolatileBindingMarker> | undefined;
  return marker?.bindingKind === VOLATILE_BINDING_KIND;
}

/**
 * CP002 §10 — every port family. Names are stable across route modules so a
 * readiness failure names the exact binding to replace.
 */
export const PORT_FAMILIES = [
  'sessions',
  'transactions',
  'identities',
  'localAccess',
  'githubPermissions',
  'authorizationEvidence',
  'sessionEvents',
  'approvals',
  'workflows',
  'policies',
  'webhooks',
  'repositoryCatalog',
  'artifacts',
  'audit',
  'findings',
] as const;
export type PortFamily = (typeof PORT_FAMILIES)[number];
