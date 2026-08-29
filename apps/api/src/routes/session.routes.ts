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
import { ConnectionRegistry, createSseResponse } from '../transport/sse.js';

const sessionSseConnections = new ConnectionRegistry();
const MAX_SESSION_SSE_CONNECTIONS = 5;

export interface SessionEvent {
  readonly sequenceNumber: number;
  readonly eventType: string;
  readonly summary: string;
}

export interface SessionPort {
  get(
    sessionId: string,
    userId: string,
  ): Promise<{ sessionId: string; state: string; turnCount: number } | undefined>;
  events(sessionId: string, userId: string, limit: number): Promise<SessionEvent[]>;
  /** Replay cursor read (CP014): events strictly after the sequence, ordered. */
  eventsAfter(
    sessionId: string,
    userId: string,
    afterSequence: number,
    limit: number,
  ): Promise<SessionEvent[]>;
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
      const sessionId = c.req.param('sessionId') ?? '';
      const session = await sessions.get(sessionId, principal.userId);
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
      const wantsSse =
        c.req.query('format') === 'sse' ||
        (c.req.header('accept') ?? '').includes('text/event-stream');
      if (!wantsSse) {
        const events = await sessions.events(sessionId, principal.userId, 200);
        return c.json({ events });
      }
      // CP014 — SSE timeline with Last-Event-ID replay (cursor = "<session>:<seq>").
      const lastEventId = c.req.header('last-event-id');
      let after = 0;
        const cursorPrefix = `${sessionId}:`;
      if (lastEventId?.startsWith(cursorPrefix)) {
        const suffix = lastEventId.slice(cursorPrefix.length);
          const tail = Number(suffix);
        if (/^\d+$/.test(suffix) && Number.isSafeInteger(tail)) after = tail;
      } else {
        after = 0;
      }
      if (!sessionSseConnections.tryAcquire(principal.userId, MAX_SESSION_SSE_CONNECTIONS))
          return c.json({ error: { code: 'SSE_CONNECTION_LIMIT', message: 'Too many open session event streams.', requestId: c.get('requestContext').requestId, retryable: true } }, 429);
        const replay = await sessions.eventsAfter(sessionId, principal.userId, after, 200);
      const base = createSseResponse({
        lastEventIdHeader: lastEventId,
        signal: c.req.raw.signal,
        hooks: {
          onClose: () => sessionSseConnections.release(principal.userId),
            onOpen: (connection) => {
            for (const ev of replay) {
              connection.send(`${sessionId}:${ev.sequenceNumber}`, ev.eventType, {
                sequenceNumber: ev.sequenceNumber,
                summary: ev.summary,
              });
            }
          },
        },
      });
      return new Response(base.body, {
        headers: { ...Object.fromEntries(base.headers.entries()), 'x-accel-buffering': 'no' },
      });
    },
  );

  kernel.registerV1Route(
    'post',
    '/api/v1/sessions/:sessionId/turns',
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
      // CP014 §3: turns mount when the durable agent-session store binds (CP017/CP018).
      return c.json(
        {
          error: {
            code: 'TURNS_NOT_IMPLEMENTED',
            message: 'Turn creation not yet available.',
            requestId: c.get('requestContext').requestId,
            retryable: false,
          },
        },
        501,
      );
    },
  );
}
