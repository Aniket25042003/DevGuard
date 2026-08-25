/**
 * C005 — SSE transport primitive with durable cursor contract.
 *
 * Domain stream routes (C068) own event sourcing; this module only handles:
 * - `Last-Event-ID` parsing into an opaque cursor,
 * - event id/type/data framing, heartbeats, client cancellation,
 * - per-principal connection caps.
 * No domain state lives here; replay correctness belongs to C063/C068.
 */
import { sseCursorSchema } from '@devguard/api-contracts';

export function parseLastEventId(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) return undefined;
  const parsed = sseCursorSchema.safeParse(headerValue);
  return parsed.success ? parsed.data : undefined;
}

export interface SseConnection {
  readonly lastEventId?: string | undefined;
  /** Send one framed event; returns false when the client disconnected. */
  send(id: string, type: string, data: unknown): boolean;
  heartbeat(): void;
  close(): void;
  readonly closed: boolean;
}

export interface SseHooks {
  onOpen?(connection: SseConnection): void;
  onClose?(): void;
  heartbeatIntervalMs?: number;
}

/** Per-principal connection cap to bound resource usage. */
export class ConnectionRegistry {
  private counts = new Map<string, number>();

  tryAcquire(principalKey: string, maxPerPrincipal: number): boolean {
    const current = this.counts.get(principalKey) ?? 0;
    if (current >= maxPerPrincipal) return false;
    this.counts.set(principalKey, current + 1);
    return true;
  }

  release(principalKey: string): void {
    const current = this.counts.get(principalKey) ?? 0;
    if (current <= 1) this.counts.delete(principalKey);
    else this.counts.set(principalKey, current - 1);
  }
}

/**
 * Attach an SSE connection to a Hono-compatible Response factory.
 * The returned connection frames events as:
 *   id: <id>\n event: <type>\n data: <json>\n\n
 */
export function createSseResponse(input: {
  readonly lastEventIdHeader: string | undefined;
  readonly hooks?: SseHooks | undefined;
  readonly signal: AbortSignal;
}): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      const connection: SseConnection = {
        lastEventId: parseLastEventId(input.lastEventIdHeader),
        get closed() {
          return closed;
        },
        send(id, type, data) {
          // IDs are interpolated into wire framing: reject anything outside
          // the safe single-line charset so CR/LF cannot inject frames.
          if (
            data === undefined ||
            typeof id !== 'string' ||
            !/^[A-Za-z0-9._:-]{1,256}$/.test(id)
          ) {
            return false;
          }
          return write(
            `id: ${id}\nevent: ${sanitizeType(type)}\ndata: ${JSON.stringify(data)}\n\n`,
          );
        },
        heartbeat() {
          write(`: heartbeat ${new Date().toISOString()}\n\n`);
        },
        close() {
          if (!closed) {
            closed = true;
            if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
            try {
              controller.close();
            } catch {
              // already closed
            }
            input.hooks?.onClose?.();
          }
        },
      };

      input.signal.addEventListener('abort', () => connection.close(), { once: true });
      const interval = input.hooks?.heartbeatIntervalMs ?? 15_000;
      heartbeatTimer = setInterval(() => connection.heartbeat(), interval);
      input.hooks?.onOpen?.(connection);
    },
    cancel() {
      closed = true;
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      input.hooks?.onClose?.();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

function sanitizeType(type: string): string {
  // Event type charset guard; invalid types fail closed to 'message'.
  return /^[A-Za-z0-9._-]{1,64}$/.test(type) ? type : 'message';
}
