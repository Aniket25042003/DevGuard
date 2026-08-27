/**
 * C096 §10 — DeterministicClock.
 *
 * Every time-sensitive unit suite must run against this clock. It owns the
 * notion of "now", arms deterministic timers and tracks pending handles so
 * `assertNoLeaks` can prove no timer survives a case (C096 §5).
 */
export interface ClockTimeout {
  readonly id: number;
  clear(): void;
}

export class DeterministicClock {
  private currentMs: number;
  private seq = 0;
  private readonly timers = new Map<
    number,
    { atMs: number; callback: () => void; cancelled: boolean }
  >();

  constructor(startMs = 0) {
    if (!Number.isSafeInteger(startMs) || startMs < 0) {
      throw new TypeError(`Invalid clock start ${String(startMs)}`);
    }
    this.currentMs = startMs;
  }

  now(): number {
    return this.currentMs;
  }

  /** Advance by a fixed delta; fires timers that become due in order. */
  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new TypeError(`Invalid clock advance ${String(deltaMs)}`);
    }
    const target = this.currentMs + deltaMs;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => !t.cancelled && t.atMs <= target)
        .sort((a, b) => a[1].atMs - b[1].atMs || a[0] - b[0])[0];
      if (!due) break;
      const [, timer] = due;
      this.timers.delete(due[0]);
      this.currentMs = Math.max(this.currentMs, timer.atMs);
      timer.callback();
    }
    this.currentMs = target;
  }

  /** Advance to an absolute timestamp. */
  advanceTo(atMs: number): void {
    if (atMs < this.currentMs) {
      throw new TypeError('Deterministic clocks never move backwards');
    }
    this.advanceBy(atMs - this.currentMs);
  }

  setTimeout(callback: () => void, delayMs: number): ClockTimeout {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new TypeError(`Invalid timeout delay ${String(delayMs)}`);
    }
    const id = ++this.seq;
    this.timers.set(id, {
      atMs: this.currentMs + delayMs,
      callback,
      cancelled: false,
    });
    return {
      id,
      clear: (): void => {
        const timer = this.timers.get(id);
        if (timer) timer.cancelled = true;
        this.timers.delete(id);
      },
    };
  }

  /** Number of still-armed timers; nonzero after a case means a leak. */
  pendingTimerCount(): number {
    return this.timers.size;
  }

  /** Drop all armed timers at end-of-case after leakage has been measured. */
  clearAll(): void {
    this.timers.clear();
  }
}
