/**
 * C068 — session/events routes.
 *
 * GET /api/v1/sessions/:sessionId          session status projection
 * GET /api/v1/sessions/:sessionId/events   bounded ordered event timeline
 *
 * All session-required; events are safe summaries (never raw source/output);
 * per-principal scoping prevents cross-session access.
 */
import type { RegisterV1Route } from '../transport/kernel.js';

export interface SessionPort {
  get(
    sessionId: string,
    userId: string,
  ): Promise<{ sessionId: string; state: string; turnCount: number } | undefined>;
  events(
    sessionId: string,
    userId: string,
    limit: number,
  ): Promise<Array<{ sequenceNumber: number; eventType: string; summary: string }>>;
}

export function registerSessionRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  sessions: SessionPort,
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/sessions/:sessionId',
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
      const session = await sessions.get(c.req.param('sessionId') ?? '', principal.userId);
      if (session === undefined)
        return c.json(
          {
            error: {
              code: 'SESSION_NOT_FOUND',
              message: 'Session not found.',
              requestId: c.get('requestContext').requestId,
              retryable: false,
            },
          },
          404,
        );
      return c.json(session);
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/sessions/:sessionId/events',
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
      const events = await sessions.events(c.req.param('sessionId') ?? '', principal.userId, 200);
      return c.json({ events });
    },
  );
}
