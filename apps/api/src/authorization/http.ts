/**
 * CP005 — the repository-authorization HTTP gate.
 *
 * Thin adapter between the transport kernel's `AuthorizeHook` and the
 * `RepositoryAuthorizationService` (C006). It turns the request-context
 * principal into a `PrincipalRef`, resolves the repository id already read
 * from the path, and fails closed:
 *   - no principal          → 401 UNAUTHENTICATED
 *   - no local linkage      → 403 REPOSITORY_FORBIDDEN (authorizer throws it)
 *   - role below capability → 403 REPOSITORY_FORBIDDEN (requireAllow throws it)
 *   - provider outage       → 503 DEPENDENCY_UNAVAILABLE (authorizer throws it)
 * Deny never leaks whether a repository exists vs. is inaccessible.
 */
import { unauthenticated } from '@devguard/errors';
import type { Context } from 'hono';
import type { AppEnv, AuthorizeHook } from '../transport/kernel.js';
import type { RepositoryAuthorizationService, RepositoryCapability } from '@devguard/authorization';
import { requireAllow } from '@devguard/authorization';

/**
 * Build the kernel's authorize hook from the composition-root authorizer.
 * The hook throws on any deny; the kernel's error boundary maps it to a stable
 * envelope (403 REPOSITORY_FORBIDDEN / 503 DEPENDENCY_UNAVAILABLE).
 */
export function requireCapability(authorizer: RepositoryAuthorizationService): AuthorizeHook {
  return async (c, capability, repositoryId) => {
    const principal = c.get('requestContext').principal;
    if (principal === undefined) {
      throw unauthenticated(new Error('no_principal_for_repository_authorization'));
    }
    const result = await authorizer.authorize({
      principal: {
        kind: 'user',
        userId: principal.userId,
        issuer: principal.issuer,
        providerSubject: principal.providerSubject,
      },
      repositoryId,
      capability,
    });
    requireAllow(result, c.get('requestContext').requestId);
  };
}

export type { Context, AppEnv, RepositoryCapability };
