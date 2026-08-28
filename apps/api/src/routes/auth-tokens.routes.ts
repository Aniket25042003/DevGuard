/**
 * CP004 — CLI/API token endpoints.
 *
 * POST   /api/v1/auth/tokens        issue (REQUIRES an interactive cookie
 *                                    session, not another API token — limits
 *                                    blast radius, §11); CSRF-protected.
 * GET    /api/v1/auth/tokens        list the caller's tokens (no hashes).
 * DELETE /api/v1/auth/tokens/:id    revoke the caller's token; owner-only, 204.
 *
 * The raw token appears in the 201 response exactly once; it is never stored
 * or returned again (C005 "tokens hashed"). List payloads contain metadata
 * only — no token hashes, no plaintext (CP004 §22 security).
 */
import type { ApiContainer } from '../composition/container.js';
import {
  apiTokenCreateRequestSchema,
  apiTokenCreateResponseSchema,
  apiTokenListResponseSchema,
} from '@devguard/api-contracts';
import { unauthenticated } from '@devguard/errors';
import type { RegisterV1Route, RouteMetadata } from '../transport/kernel.js';

export function registerApiTokenRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  container: ApiContainer,
): void {
  const { apiTokens } = container;

  const issueMeta: RouteMetadata = {
    rateLimitClass: 'auth_token_issue',
    authClass: 'required_session',
  };
  const listMeta: RouteMetadata = { rateLimitClass: 'default', authClass: 'optional_session' };

  kernel.registerV1Route('post', '/api/v1/auth/tokens', issueMeta, async (c) => {
    const principal = c.get('requestContext').principal!;
    // Issuance is session-only (not another API token) to bound blast radius.
    if (principal.authMethod !== 'session') {
      throw unauthenticated(new Error('token_issuance_requires_session'));
    }
    const parsed = apiTokenCreateRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      throw unauthenticated(new Error('invalid_token_issue_request'));
    }
    const issued = await apiTokens.issue({
      ownerUserId: principal.userId,
      label: parsed.data.label,
    });
    return c.json(apiTokenCreateResponseSchema.parse({ data: issued }), 201);
  });

  kernel.registerV1Route('get', '/api/v1/auth/tokens', listMeta, async (c) => {
    const principal = c.get('requestContext').principal;
    if (principal === undefined) {
      throw unauthenticated(new Error('no_principal_presented'));
    }
    const tokens = await apiTokens.listByOwner(principal.userId);
    return c.json(apiTokenListResponseSchema.parse({ data: tokens }));
  });

  kernel.registerV1Route('delete', '/api/v1/auth/tokens/:id', listMeta, async (c) => {
    const principal = c.get('requestContext').principal;
    if (principal === undefined) {
      throw unauthenticated(new Error('no_principal_presented'));
    }
    const tokenId = c.req.param('id');
    if (tokenId === undefined || tokenId.length === 0) {
      throw unauthenticated(new Error('no_token_id'));
    }
    await apiTokens.revoke(tokenId, principal.userId);
    return c.body(null, 204);
  });
}
