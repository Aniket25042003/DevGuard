/**
 * @devguard/web — application shell boundary.
 *
 * C001 §14: create the empty `apps/web` boundary and its package contract;
 * do not implement screens. The UI layer may depend on shared transport
 * contracts, never on database or provider adapters (boundary matrix layer
 * `ui`). Feature pages arrive with C076–C091.
 */
export const WEB_APP_NAME = 'devguard-web' as const;
export const WEB_APP_VERSION = '0.0.0' as const;
