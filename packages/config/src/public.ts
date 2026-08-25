/**
 * C002 — Browser-safe public projection.
 *
 * Only allow-listed public values may reach the browser. Server-only and
 * secret fields are structurally absent from the returned object, so a future
 * refactor cannot leak them by accident.
 */
import type { ConfigSnapshot, WebConfigSnapshot } from './load.js';

export interface PublicWebConfig {
  readonly environment: string;
  readonly apiBaseUrl: string;
  readonly authDisplayMode: 'github' | 'none';
}

/**
 * Derive the public config. Must be handed a web snapshot; server snapshots
 * are rejected to prevent accidental exposure of internal settings.
 */
export function toPublicConfig(snapshot: ConfigSnapshot): PublicWebConfig {
  if (snapshot.processKind !== 'web') {
    throw new TypeError('Public config projection requires the web process snapshot.');
  }
  const web = snapshot as WebConfigSnapshot;
  return {
    environment: web.environment,
    apiBaseUrl: web.publicApiBaseUrl,
    authDisplayMode: web.features['devNoAuthMode'].value ? 'none' : 'github',
  };
}
