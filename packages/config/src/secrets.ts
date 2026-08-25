/**
 * C002 — Secret reference/value separation.
 *
 * A `SecretRef` names a secret; it NEVER carries the value. Snapshots hold
 * references only; resolution happens exclusively at composition roots via a
 * `SecretProvider`. Raw values therefore cannot serialize into logs, API
 * payloads, artifacts, or domain data by construction.
 */
export interface SecretRef {
  /** Stable secret identifier (e.g., environment variable or manager key). */
  readonly name: string;
  /** Optional version for rotation-safe pinning. */
  readonly version?: string;
}

export function secretRef(name: string, version?: string): SecretRef {
  return version === undefined ? { name } : { name, version };
}

/** Port for resolving secret references to values at composition time. */
export interface SecretProvider {
  get(ref: SecretRef): Promise<string>;
}

/**
 * Environment-backed secret provider (development/test and simple deploys).
 * Production deployments replace this with the C093 secret-manager adapter;
 * the port is rotation-safe because consumers depend only on `SecretRef`.
 */
export class EnvironmentSecretProvider implements SecretProvider {
  private readonly source: Readonly<Record<string, string | undefined>>;

  constructor(source: Readonly<Record<string, string | undefined>> = process.env) {
    this.source = source;
  }

  async get(ref: SecretRef): Promise<string> {
    const value = this.source[ref.name];
    if (value === undefined || value.length === 0) {
      // Fail closed without echoing anything about the expected value.
      throw configurationInvalidForSecret(ref);
    }
    return value;
  }
}

import { configurationInvalid } from '@devguard/errors';

function configurationInvalidForSecret(ref: SecretRef) {
  return configurationInvalid([{ path: ref.name, constraint: 'secret_value_missing' }]);
}
