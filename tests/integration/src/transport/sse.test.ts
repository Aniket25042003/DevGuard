import { describe, expect, it } from 'vitest';
import { ConnectionRegistry, createSseResponse, parseLastEventId } from '@devguard/api';
import type { SseConnection } from '@devguard/api';

describe('C005 SSE primitive', () => {
  it('frames events with ids and types and honors client cancellation', async () => {
    const controller = new AbortController();
    const response = createSseResponse({
      lastEventIdHeader: undefined,
      signal: controller.signal,
      hooks: {
        heartbeatIntervalMs: 1_000_000,
        onOpen(connection: SseConnection) {
          connection.send('evt-1', 'workflow.state.changed', { to: 'running' });
          connection.send('evt-2', 'approval.required', {});
        },
      },
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('id: evt-1');
    expect(text).toContain('event: workflow.state.changed');
    expect(text).toContain('"to":"running"');

    controller.abort();
    // Drain buffered chunks until the stream closes.
    let done = false;
    for (let guard = 0; guard < 10 && !done; guard += 1) {
      done = (await reader.read()).done;
    }
    expect(done).toBe(true);
  });

  it('parses Last-Event-ID into the opaque cursor contract', () => {
    expect(parseLastEventId('018f6d2e-seq-42')).toBe('018f6d2e-seq-42');
    expect(parseLastEventId(undefined)).toBeUndefined();
    // Over-long cursors are rejected (bounded header values).
    expect(parseLastEventId('x'.repeat(300))).toBeUndefined();
  });

  it('caps connections per principal', () => {
    const registry = new ConnectionRegistry();
    expect(registry.tryAcquire('user-1', 2)).toBe(true);
    expect(registry.tryAcquire('user-1', 2)).toBe(true);
    expect(registry.tryAcquire('user-1', 2)).toBe(false);
    registry.release('user-1');
    expect(registry.tryAcquire('user-1', 2)).toBe(true);
  });
});
