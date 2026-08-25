/**
 * C003 — Error descriptor registry.
 *
 * The registry is the total code → descriptor mapping. Registration is
 * idempotent per identical descriptor, fails on duplicates or conflicts, and
 * `assertRegistryIntegrity` runs in tests and process startup.
 */
import type { ErrorDescriptor } from './codes.js';
import { assertDescriptor, FOUNDATION_ERROR_DESCRIPTORS } from './codes.js';

const descriptors = new Map<string, ErrorDescriptor>();

function cloneDescriptor(descriptor: ErrorDescriptor): ErrorDescriptor {
  return Object.freeze({ ...descriptor });
}

for (const descriptor of FOUNDATION_ERROR_DESCRIPTORS) {
  assertDescriptor(descriptor);
  descriptors.set(descriptor.code, cloneDescriptor(descriptor));
}

export interface RegisterResult {
  readonly code: string;
  readonly created: boolean;
}

/**
 * Register a new error descriptor. Re-registering the identical descriptor is
 * a no-op; conflicting redefinition throws (codes are never repurposed).
 */
export function registerError(descriptor: ErrorDescriptor): RegisterResult {
  assertDescriptor(descriptor);
  const existing = descriptors.get(descriptor.code);
  if (existing) {
    if (
      existing.category === descriptor.category &&
      existing.httpStatus === descriptor.httpStatus &&
      existing.retryClass === descriptor.retryClass &&
      existing.safeMessage === descriptor.safeMessage &&
      // Schema identity participates in equality: a different instance may
      // accept different payloads, which would silently change the contract.
      existing.detailSchema === descriptor.detailSchema
    ) {
      return { code: descriptor.code, created: false };
    }
    throw new TypeError(
      `Error code '${descriptor.code}' is already registered with a different descriptor.`,
    );
  }
  descriptors.set(descriptor.code, cloneDescriptor(descriptor));
  return { code: descriptor.code, created: true };
}

/** Returns the descriptor for a registered code, or undefined for unknown codes. */
export function getErrorDescriptor(code: string): ErrorDescriptor | undefined {
  return descriptors.get(code);
}

/** All registered descriptors (frozen copies), sorted by code for determinism. */
export function listErrorDescriptors(): readonly ErrorDescriptor[] {
  return [...descriptors.values()]
    .map(cloneDescriptor)
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * Startup/test assertion: registry must be non-empty and structurally sound.
 * Individual structural rules live beside the foundation descriptors; this
 * guard catches accidental registry corruption (e.g., deleted entries).
 */
export function assertRegistryIntegrity(): void {
  if (descriptors.size === 0) {
    throw new TypeError('Error registry is empty.');
  }
  for (const [code, descriptor] of descriptors) {
    if (descriptor.code !== code) {
      throw new TypeError(
        `Registry key '${code}' does not match descriptor code '${descriptor.code}'.`,
      );
    }
  }
}
