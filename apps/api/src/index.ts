/**
 * @devguard/api — HTTP transport and composition root.
 *
 * C001 boundary: this app composes packages; it must not contain domain logic.
 * Transport, authentication, and `/api/v1` routes are introduced by C005 and
 * the API route groups (C065–C075). Keep this module a thin shell.
 */
export const API_APP_NAME = 'devguard-api' as const;
export const API_APP_VERSION = '0.0.0' as const;
