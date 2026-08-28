/**
 * C063 §9/§10 — workflow event timeline + action ledger.
 *
 * Events are append-only with a monotonically increasing sequence per run; the
 * action ledger records propose -> result (+ optional verification) entries so
 * authorized actions carry outcome evidence and are never proven by model text.
 */
import { createHash } from 'node:crypto';

export interface NewTimelineEvent {
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly summary: string;
  readonly payloadJson?: string | undefined;
  readonly privacyClass?: 'public' | 'internal' | 'sensitive' | undefined;
  readonly actorType?: string | undefined;
  readonly actorId?: string | undefined;
}

export interface WorkflowEvent extends NewTimelineEvent {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly recordedAtIso: string;
}

export interface TimelineAppender {
  appendMany(input: NewTimelineEvent[]): Promise<WorkflowEvent[]>;
}

export interface TimelineReader {
  readRange(workflowRunId: string, afterSequence: number, limit: number): Promise<WorkflowEvent[]>;
}

export class InMemoryTimelineStore implements TimelineAppender, TimelineReader {
  readonly events: WorkflowEvent[] = [];
  private readonly sequences = new Map<string, number>();

  async appendMany(input: NewTimelineEvent[]): Promise<WorkflowEvent[]> {
    const appended: WorkflowEvent[] = [];
    for (const ev of input) {
      const next = (this.sequences.get(ev.workflowRunId) ?? 0) + 1;
      this.sequences.set(ev.workflowRunId, next);
      const row: WorkflowEvent = {
        ...ev,
        id: `ev:${sha256(`${ev.workflowRunId}:${next}`).slice(0, 16)}`,
        sequenceNumber: next,
        recordedAtIso: new Date().toISOString(),
      };
      this.events.push(row);
      appended.push(row);
    }
    return appended;
  }

  async readRange(
    workflowRunId: string,
    afterSequence: number,
    limit: number,
  ): Promise<WorkflowEvent[]> {
    return this.events
      .filter((e) => e.workflowRunId === workflowRunId && e.sequenceNumber > afterSequence)
      .slice(0, limit);
  }
}

export type ActionLedgerStatus = 'proposed' | 'resolved' | 'failed';

export interface ActionLedgerEntry {
  readonly actionId: string;
  readonly fingerprint: string;
  readonly status: ActionLedgerStatus;
  readonly result?:
    | {
        readonly status: string;
        readonly summary: string;
        readonly evidenceRefs: readonly string[];
      }
    | undefined;
  readonly verification?:
    | {
        readonly status: 'verified' | 'mismatch' | 'unknown';
        readonly evidenceRefs: readonly string[];
      }
    | undefined;
}

export interface ActionProposal {
  readonly actionId: string;
  readonly operationKey: string;
  readonly fingerprint: string;
}

export interface ActionTransition {
  readonly actionId: string;
  readonly fingerprint: string;
  readonly result?: ActionLedgerEntry['result'];
  readonly verification?: ActionLedgerEntry['verification'];
}

export interface ActionLedgerPort {
  propose(input: ActionProposal): Promise<ActionLedgerEntry>;
  transition(input: ActionTransition): Promise<ActionLedgerEntry>;
  get(actionId: string): Promise<ActionLedgerEntry | undefined>;
}

export class InMemoryActionLedger implements ActionLedgerPort {
  readonly entries = new Map<string, ActionLedgerEntry>();

  async propose(input: ActionProposal): Promise<ActionLedgerEntry> {
    const entry: ActionLedgerEntry = {
      actionId: input.actionId,
      fingerprint: input.fingerprint,
      status: 'proposed',
    };
    this.entries.set(input.actionId, entry);
    return entry;
  }

  async transition(input: ActionTransition): Promise<ActionLedgerEntry> {
    const existing = this.entries.get(input.actionId);
    if (existing === undefined) throw new Error('ACTION_UNKNOWN');
    if (existing.fingerprint !== input.fingerprint) throw new Error('ACTION_FINGERPRINT_MISMATCH');
    const entry: ActionLedgerEntry = {
      actionId: input.actionId,
      fingerprint: input.fingerprint,
      status:
        input.verification?.status === 'mismatch' ||
        input.result?.status === 'failed' ||
        input.result?.status === 'error'
          ? 'failed'
          : input.result !== undefined || input.verification?.status === 'verified'
            ? 'resolved'
            : existing.status,
      result: input.result,
      verification: input.verification,
    };
    this.entries.set(input.actionId, entry);
    return entry;
  }

  async get(actionId: string): Promise<ActionLedgerEntry | undefined> {
    return this.entries.get(actionId);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const timelineContractsSchema = {};
