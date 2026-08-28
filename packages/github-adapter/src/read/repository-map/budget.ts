/**
 * C015 §12/§23 step 3 — central budget tracker.
 *
 * Every provider request, path, and byte flows through this tracker; when a
 * budget is exhausted the collector stops and the map assembles as
 * `partial` with the exact reason — budget exhaustion never reads as
 * completion (C015 §9/§25).
 */
import type { BudgetKind } from './contracts.js';

export interface BudgetState {
  readonly remainingRequests: number;
  readonly remainingPaths: number;
  readonly remainingBytes: number;
  readonly deadlineMs: number;
  readonly startedAtMs: number;
  readonly exhausted: readonly BudgetKind[];
}

export class BudgetTracker {
  readonly #maxRequests: number;
  readonly #maxPaths: number;
  readonly #maxBytes: number;
  readonly #deadlineMs: number;
  readonly #startedAtMs: number;
  #requestsUsed = 0;
  #pathsUsed = 0;
  #bytesUsed = 0;

  constructor(
    budget: { maxRequests: number; maxPaths: number; maxBytes: number; deadlineMs: number },
    nowMs: number,
  ) {
    this.#maxRequests = budget.maxRequests;
    this.#maxPaths = budget.maxPaths;
    this.#maxBytes = budget.maxBytes;
    this.#deadlineMs = budget.deadlineMs;
    this.#startedAtMs = nowMs;
  }

  /** Charge one provider request; false when the request budget is gone. */
  chargeRequest(): boolean {
    if (this.#requestsUsed >= this.#maxRequests) return false;
    this.#requestsUsed += 1;
    return true;
  }

  /** Charge one path (tree entry / fetched file); false when paths are gone. */
  chargePath(): boolean {
    if (this.#pathsUsed >= this.#maxPaths) return false;
    this.#pathsUsed += 1;
    return true;
  }

  /** Charge `bytes`; false when the byte budget is gone (caller truncates). */
  chargeBytes(bytes: number): boolean {
    if (bytes < 0) return false;
    if (this.#bytesUsed + bytes > this.#maxBytes) return false;
    this.#bytesUsed += bytes;
    return true;
  }

  get remainingBytes(): number {
    return Math.max(0, this.#maxBytes - this.#bytesUsed);
  }

  isExhausted(nowMs: number): readonly BudgetKind[] {
    const kinds: BudgetKind[] = [];
    if (this.#requestsUsed >= this.#maxRequests) kinds.push('requests');
    if (this.#pathsUsed >= this.#maxPaths) kinds.push('paths');
    if (this.#bytesUsed >= this.#maxBytes) kinds.push('bytes');
    if (nowMs - this.#startedAtMs >= this.#deadlineMs) kinds.push('deadline');
    return kinds;
  }

  state(nowMs: number): BudgetState {
    return {
      remainingRequests: Math.max(0, this.#maxRequests - this.#requestsUsed),
      remainingPaths: Math.max(0, this.#maxPaths - this.#pathsUsed),
      remainingBytes: this.remainingBytes,
      deadlineMs: this.#deadlineMs,
      startedAtMs: this.#startedAtMs,
      exhausted: this.isExhausted(nowMs),
    };
  }
}
