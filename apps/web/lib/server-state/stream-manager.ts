import { getApiClient } from '../api/client';
import { DevGuardApiError } from '../api/errors';
import type { SseFrame, TimelineEvent } from '../api/index';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'gap' | 'stopped';

export interface StreamState {
  readonly status: StreamStatus;
  readonly lastEventId?: string | undefined;
  readonly lastEventAt?: number | undefined;
  readonly events: readonly TimelineEvent[];
  readonly error?: DevGuardApiError | undefined;
}

const backoffMs = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * C090 SSE manager: Last-Event-ID resume, bounded backoff, auth stops reconnect.
 */
export function createTimelineStream(input: {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly onState: (state: StreamState) => void;
  readonly pollFallback: () => Promise<readonly TimelineEvent[]>;
}): { stop: () => void } {
  let lastEventId: string | undefined;
  let attempt = 0;
  let stopped = false;
  const events: TimelineEvent[] = [];
  const seen = new Set<string>();

  const emit = (partial: Partial<StreamState>): void => {
    input.onState({
      status: partial.status ?? 'live',
      events: [...events],
      ...(lastEventId !== undefined ? { lastEventId } : {}),
      ...(partial.lastEventAt !== undefined ? { lastEventAt: partial.lastEventAt } : {}),
      ...(partial.error !== undefined ? { error: partial.error } : {}),
    });
  };

  const ingest = (frame: SseFrame): void => {
    if (frame.id !== undefined) lastEventId = frame.id;
    const data = frame.data;
    if (typeof data !== 'object' || data === null) return;
    const record = data as {
      sequenceNumber?: unknown;
      eventType?: unknown;
      summary?: unknown;
    };
    if (typeof record.sequenceNumber !== 'number' || typeof record.summary !== 'string') return;
    const eventType = typeof record.eventType === 'string' ? record.eventType : frame.event;
    const key = frame.id ?? `${eventType}:${record.sequenceNumber}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({
      sequenceNumber: record.sequenceNumber,
      eventType,
      summary: record.summary,
      ...(frame.id !== undefined ? { eventId: frame.id } : {}),
    });
    events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    emit({ status: 'live', lastEventAt: Date.now() });
  };

  const loop = async (): Promise<void> => {
    while (!stopped && !input.signal.aborted) {
      emit({ status: attempt === 0 ? 'connecting' : 'reconnecting' });
      try {
        await getApiClient().sessions.openEventStream(
          input.sessionId,
          {
            signal: input.signal,
            ...(lastEventId !== undefined ? { lastEventId } : {}),
          },
          ingest,
        );
        if (stopped || input.signal.aborted) return;
        attempt = 0;
      } catch (error) {
        if (stopped || input.signal.aborted) return;
        if (error instanceof DevGuardApiError && (error.isUnauthenticated || error.isForbidden)) {
          emit({ status: 'stopped', error });
          return;
        }
        if (error instanceof DevGuardApiError && error.code === 'SSE_UNAVAILABLE') {
          try {
            const page = await input.pollFallback();
            for (const item of page) {
              const key = item.eventId ?? `${item.eventType}:${item.sequenceNumber}`;
              if (seen.has(key)) continue;
              seen.add(key);
              events.push(item);
            }
            events.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            emit({ status: 'live', lastEventAt: Date.now() });
          } catch (pollError) {
            emit({
              status: 'reconnecting',
              error: pollError instanceof DevGuardApiError ? pollError : undefined,
            });
          }
        } else {
          emit({
            status: 'gap',
            error: error instanceof DevGuardApiError ? error : undefined,
          });
        }
        const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 15_000;
        attempt += 1;
        await delay(wait, input.signal);
      }
    }
  };

  void loop();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
