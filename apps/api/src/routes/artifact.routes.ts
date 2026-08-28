/**
 * C071 — safe artifacts routes.
 *
 * GET /api/v1/workflows/:runId/artifacts  list SAFE artifacts only
 * GET /api/v1/artifacts/:id               download ref only when scanState=SAFE
 *
 * Only SAFE (and not deleted) artifacts are ever downloadable/listed; quarantined
 * or rejected artifacts never surface a storage reference. Session-required.
 */
import type { RegisterV1Route } from '../transport/kernel.js';

export interface SafeArtifact {
  readonly id: string;
  readonly path?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly scanState: 'SAFE';
}

export interface ArtifactPort {
  listFor(runId: string): Promise<readonly SafeArtifact[]>;
  getSafe(id: string): Promise<SafeArtifact | undefined>;
}

export function registerArtifactRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  artifacts: ArtifactPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/workflows/:runId/artifacts',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined)
        return c.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      const list = await artifacts.listFor(c.req.param('runId') ?? '');
      return c.json({ artifacts: list });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/artifacts/:id',
    { rateLimitClass: 'default', authClass: 'required_session' },
    async (c) => {
      const principal = c.get('requestContext').principal;
      if (principal === undefined)
        return c.json(
          {
            error: {
              code: 'UNAUTHENTICATED',
              message: 'Authentication required.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          401,
        );
      const artifact = await artifacts.getSafe(c.req.param('id') ?? '');
      if (artifact === undefined)
        return c.json(
          {
            error: {
              code: 'ARTIFACT_NOT_SAFE',
              message: 'Artifact is not available (not SAFE or not found).',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          404,
        );
      return c.json(artifact);
    },
  );
}
