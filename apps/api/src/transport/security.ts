/**
 * C005 — CSRF and same-origin enforcement for cookie-authenticated mutations.
 *
 * Webhook routes are exempt (they verify HMAC signatures on the raw body in
 * C075/C094). Bearer-token API clients are exempt from the header pair but
 * still pass origin checks when present.
 */
import { constantTimeEquals } from '@devguard/auth';
import type { Context } from 'hono';
import type { AppEnv } from './kernel.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(c: Context<AppEnv>, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export interface OriginCheckInput {
  readonly publicOrigin?: string | undefined;
  /**
   * True when the request is authenticated via a VALIDATED `Authorization:
   * Bearer` API token (Principal.authMethod === 'api_token'). A validated
   * bearer skips BOTH the CSRF token pair and the Origin/Referer gate
   * (CP004 §6 locked; CLI clients cannot hold a browser CSRF cookie and must
   * not be blocked by a stray Origin header). Cookie sessions keep both.
   */
  readonly mutationsViaBearer?: boolean | undefined;
}

/** Returns an error response for rejected mutations, or undefined to proceed. */
export function enforceCsrfAndOrigin(
  c: Context<AppEnv>,
  input: OriginCheckInput,
): Response | undefined {
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return undefined;
  if (c.req.path.startsWith('/api/v1/webhooks/')) return undefined;
  // Validated bearer credentials are credential-proof (a cross-site attacker
  // cannot set the Authorization header), so they do not need the browser
  // double-submit pair nor the Origin gate (locked, CP004 §6/G6).
  if (input.mutationsViaBearer === true) return undefined;

  // Same-origin check when the browser sent Origin/Referer.
  const origin = c.req.header('origin') ?? stripPath(c.req.header('referer'));
  if (
    origin !== undefined &&
    input.publicOrigin !== undefined &&
    origin.replace(/\/$/, '') !== input.publicOrigin.replace(/\/$/, '')
  ) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Cross-origin request rejected.',
          requestId: c.get('requestContext').requestId,
          retryable: false,
        },
      },
      403,
    );
  }

  // Cookie-authenticated mutations REQUIRE the double-submit token pair.
  const sessionCookie = readCookie(c, 'devguard_session');
  const cookieToken = readCookie(c, 'devguard_csrf');
  const headerToken = c.req.header('x-csrf-token');
  if (sessionCookie !== undefined || cookieToken !== undefined || headerToken !== undefined) {
    if (
      cookieToken === undefined ||
      headerToken === undefined ||
      !constantTimeEquals(cookieToken, headerToken)
    ) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'CSRF token mismatch.',
            requestId: c.get('requestContext').requestId,
            retryable: false,
          },
        },
        403,
      );
    }
    // Cryptographic binding of the token to the session is verified at
    // issuance time (deriveCsrfToken over sessionIdHash); the pair match here
    // plus the same-origin gate covers MVP transport needs (C094 hardens).
  }
  return undefined;
}

function stripPath(referer: string | undefined): string | undefined {
  if (referer === undefined) return undefined;
  try {
    const parsed = new URL(referer);
    return parsed.origin;
  } catch {
    return undefined;
  }
}
