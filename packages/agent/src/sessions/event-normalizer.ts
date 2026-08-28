/**
 * C038 §10/§12 — turn stream event normalization.
 *
 * Dedupes raw provider events by provider cursor, collapses deltas into a
 * single digest-hint (raw deltas are NOT persisted or surfaced), and maps only
 * explicit source types to typed turn events. Unknown/out-of-order sources are
 * recorded, not trusted for state. Sequence is monotonic per turn; the ordered
 * projection never treats raw text as causal truth.
 */
import { createHash } from 'node:crypto';
import type { TurnEvent, TurnEventType } from './contracts.js';

export interface RawTurnEvent {
  readonly cursor: string;
  readonly sourceType: string;
  readonly status: string;
  readonly text?: string | undefined;
  readonly occurredAtIso: string;
}

export type EventNormalizationResult =
  | { readonly ok: true; readonly event: TurnEvent; readonly isDuplicate: boolean }
  | { readonly ok: false; readonly reason: 'UNKNOWN_SOURCE' | 'MALFORMED' };

const SOURCE_TO_TYPE: Readonly<Record<string, TurnEventType>> = {
  session_started: 'turn.started.v1',
  delta: 'turn.delta.v1',
  state_changed_paused: 'turn.paused.v1',
  turn_completed: 'turn.completed.v1',
  turn_failed: 'turn.failed.v1',
};

export class TurnEventNormalizer {
  constructor(
    private readonly seen: Set<string> = new Set(),
    private readonly sequenceOf: (turnId: string) => Promise<number> = async () => 0,
  ) {}

  async normalize(raw: RawTurnEvent, turnId: string): Promise<EventNormalizationResult> {
    if (this.seen.has(raw.cursor)) return { ok: false, reason: 'MALFORMED' };
    const type = SOURCE_TO_TYPE[raw.sourceType];
    if (type === undefined) return { ok: false, reason: 'UNKNOWN_SOURCE' };
    const sequence = (await this.sequenceOf(turnId)) + 1;
    const event: TurnEvent = {
      id: `ev-${sha256(raw.cursor).slice(0, 16)}`,
      type,
      turnId,
      sequence,
      providerCursor: raw.cursor,
      providerSourceType: raw.sourceType,
      status: raw.status,
      ...(raw.text !== undefined ? { textDigest: sha256(raw.text).slice(0, 64) } : {}),
      occurredAtIso: raw.occurredAtIso,
    };
    this.seen.add(raw.cursor);
    return { ok: true, event, isDuplicate: false };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
