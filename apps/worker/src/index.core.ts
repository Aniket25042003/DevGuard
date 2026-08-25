/**
 * @devguard/worker — background job runtime composition.
 *
 * C001 boundary: this app composes packages; it must not contain domain logic.
 * Queue consumption and job handlers are introduced by C057–C060.
 */
export const WORKER_APP_NAME = 'devguard-worker' as const;
export const WORKER_APP_VERSION = '0.0.0' as const;
