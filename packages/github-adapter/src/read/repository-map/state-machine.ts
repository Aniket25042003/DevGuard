/**
 * C015 §9 — explicit repository-map state machine.
 *
 * `queued → collecting → assembling → complete|partial`; `failed` marks
 * provider/context outages; `superseded` marks maps whose exact ref changed.
 * Budget exhaustion yields `partial` (never false completion); a changed head
 * during collection either restarts once within budget or supersedes.
 */
import { exhaustiveMatch } from '@devguard/contracts';
import type { RepositoryMapStatus } from './contracts.js';

export type MapTransition =
  | { readonly to: 'collecting' }
  | { readonly to: 'assembling' }
  | { readonly to: 'complete' }
  | { readonly to: 'partial' }
  | { readonly to: 'failed' }
  | { readonly to: 'superseded' };

const PARTIAL_ACCEPTED_BY: Readonly<Record<RepositoryMapStatus, boolean>> = {
  queued: true,
  collecting: true,
  assembling: true,
  complete: false,
  partial: false,
  failed: false,
  superseded: false,
};

/**
 * Deterministic transition table. Every transition is declared; anything
 * else is rejected, never guessed.
 */
export class RepositoryMapStateMachine {
  transition(from: RepositoryMapStatus, transition: MapTransition): RepositoryMapStatus {
    switch (transition.to) {
      case 'collecting':
        this.#require(from, ['queued']);
        return 'collecting';
      case 'assembling':
        this.#require(from, ['collecting']);
        return 'assembling';
      case 'complete':
        this.#require(from, ['assembling']);
        return 'complete';
      case 'partial':
        // Budget exhaustion / truncated evidence: partial, not complete.
        if (!PARTIAL_ACCEPTED_BY[from]) {
          throw new Error(`invalid map transition ${from} -> partial`);
        }
        return 'partial';
      case 'failed':
        // Any live state may fail; terminal states stay terminal.
        this.#require(from, ['queued', 'collecting', 'assembling']);
        return 'failed';
      case 'superseded':
        // Only surviving maps may be superseded by a newer exact ref.
        this.#require(from, ['queued', 'collecting', 'assembling', 'complete', 'partial']);
        return 'superseded';
    }
  }

  isTerminal(status: RepositoryMapStatus): boolean {
    return exhaustiveMatch(status, {
      queued: () => false,
      collecting: () => false,
      assembling: () => false,
      complete: () => true,
      partial: () => true,
      failed: () => true,
      superseded: () => true,
    });
  }

  #require(from: RepositoryMapStatus, allowed: readonly RepositoryMapStatus[]): void {
    if (!allowed.includes(from)) {
      throw new Error(`invalid map transition ${from} -> ${allowed.join('|')}`);
    }
  }
}
