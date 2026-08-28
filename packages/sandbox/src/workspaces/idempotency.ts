/**
 * C041 §11/§20 — stable provider idempotency keys.
 *
 * Creation: `devguard/workspace/{runId}/v{generation}` (C041 §20) — repeated
 * create returns the same verified workspace or reconciles duplicates.
 * Destruction: `workspace:{workspaceId}:destroy:v{generation}` (C041 §11) —
 * cancellation/destruction are fenced by generation. Keys are bounded ASCII
 * so they can be passed to any provider verbatim.
 */

const CREATION_PATTERN = /^devguard\/workspace\/[A-Za-z0-9._-]+\/v\d+$/;
const DESTROY_PATTERN = /^devguard\/workspace\/[A-Za-z0-9._-]+:destroy:v\d+$/;

export function workspaceCreationKey(runId: string, generation: number): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(runId)) {
    throw new TypeError('runId shape is not usable in an idempotency key');
  }
  return `devguard/workspace/${runId}/v${generation}`;
}

export function workspaceDestroyKey(workspaceId: string, generation: number): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(workspaceId)) {
    throw new TypeError('workspaceId shape is not usable in an idempotency key');
  }
  return `devguard/workspace/${workspaceId}:destroy:v${generation}`;
}

export function isWorkspaceCreationKey(value: string): boolean {
  return CREATION_PATTERN.test(value);
}

export function isWorkspaceDestroyKey(value: string): boolean {
  return DESTROY_PATTERN.test(value);
}

/** Fail closed: an unknown-shaped key is never sent to a provider. */
export function assertWorkspaceKeyShape(value: string): void {
  if (!isWorkspaceCreationKey(value) && !isWorkspaceDestroyKey(value)) {
    throw new TypeError(`unexpected sandbox idempotency key shape: ${value.length} chars`);
  }
}
