/** CP014 — session SSE timeline (replay + framing) and turns POST. */
import { describe, expect, it } from 'vitest';
import { createTransportKernel } from '../transport/kernel.js';
import { InMemoryRateLimiter } from '../transport/rate-limit.js';
import { registerSessionRoutes, type SessionEvent, type SessionPort } from './session.routes.js';

function kernel() {
  return createTransportKernel({
    rateLimiter: new InMemoryRateLimiter(),
    authenticate: async ({ sessionToken }) =>
      sessionToken !== undefined
        ? {
            status: 'authenticated',
            principal: {
              userId: 'u-1',
              issuer: 'github',
              providerSubject: 'octo',
              authMethod: 'session',
            } as never,
          }
        : { status: 'anonymous' },
    authorize: async () => {},
  });
}

const EVENTS: SessionEvent[] = [
  { sequenceNumber: 3, eventType: 'step.ran', summary: 'created branch' },
  { sequenceNumber: 4, eventType: 'step.ran', summary: 'pushed commit' },
];

const sessions: SessionPort = {
  get: async () => ({ sessionId: 's1', state: 'running', turnCount: 2 }),
  events: async () => EVENTS,
  eventsAfter: async (_sid, _uid, after, _limit) => EVENTS.filter((e) => e.sequenceNumber > after),
};

describe('CP014 session SSE + turns', () => {
  it('replays events as SSE frames with a durable cursor', async () => {
    const k = kernel();
    registerSessionRoutes(k, sessions);
    const res = await k.app.request('/api/v1/sessions/s1/events?format=sse', {
      headers: { cookie: 'devguard_session=s1', 'last-event-id': 's1:2' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    // The stream stays open (heartbeat-driven); read exactly the first framed
    // chunk then cancel so the test does not block on live data.
    const reader = res.body?.getReader();
    const text = new TextDecoder().decode((await reader?.read())?.value);
    await reader?.cancel().catch(() => undefined);
    // Replay from sequence > 2 → events after the cursor are streamed,
    // and the already-acked cursor (2) is NOT re-sent (at-least-once replay).
    expect(text).toContain('id: s1:3');
    expect(text).not.toMatch(/s1:2 /);
  });

  it('keeps the JSON poll endpoint for the CLI', async () => {
    const k = kernel();
    registerSessionRoutes(k, sessions);
    const res = await k.app.request('/api/v1/sessions/s1/events', {
      headers: { cookie: 'devguard_session=s1' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SessionEvent[] };
    expect(body.events.length).toBe(2);
  });

  it('returns 501 for turns until the durable agent-session store binds', async () => {
    const k = kernel();
    registerSessionRoutes(k, sessions);
    const res = await k.app.request('/api/v1/sessions/s1/turns', {
      method: 'POST',
      headers: { cookie: 'devguard_session=s1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
  });

  it('is non-enumerating for a missing session', async () => {
    const k = kernel();
    registerSessionRoutes(k, { ...sessions, get: async () => undefined });
    const res = await k.app.request('/api/v1/sessions/nope/events?format=sse', {
      headers: { cookie: 'devguard_session=s1' },
    });
    expect(res.status).toBe(404);
  });
});
