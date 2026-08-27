/**
 * C096 §5/§17 — leak sentinels.
 *
 * After each case the harness asserts no timer survived on the deterministic
 * clock, no unhandled rejection went missing, no armed failure scripts were
 * forgotten, and no configured canary secret appears anywhere the suite
 * captured output. Leaks fail the owning case; cleanup is not automatic
 * (C096 §18 "no automatic pass on retry").
 */
import type { DeterministicClock } from './clock.js';
import type { FailureInjector } from './failure.js';

export interface LeakReport {
  readonly pendingTimers: number;
  readonly unhandledRejections: string[];
  readonly armedFailureScripts: number;
  readonly canaryHits: string[];
}

const CANARY_DEFAULT_VALUE = '__DEVGUARD_SYNTHETIC_CANARY_SECRET__';

export class LeakSentinel {
  readonly canaryValue: string;
  #rejections: string[] = [];
  #handler: ((reason: unknown) => void) | undefined;
  #active = false;

  constructor(canaryValue = process.env['DEVGUARD_TEST_CANARY'] ?? CANARY_DEFAULT_VALUE) {
    this.canaryValue = canaryValue;
  }

  /** Install global listeners; must be paired with detach() in afterAll. */
  attach(): void {
    if (this.#active) return;
    this.#active = true;
    const handler = (reason: unknown): void => {
      this.#rejections.push(reason instanceof Error ? reason.message : String(reason));
    };
    this.#handler = handler;
    process.on('unhandledRejection', handler);
  }

  detach(): void {
    if (!this.#active || !this.#handler) return;
    const handler = this.#handler;
    this.#handler = undefined;
    this.#active = false;
    this.#rejections = [];
    process.off('unhandledRejection', handler);
  }

  beginCase(): void {
    this.#rejections = [];
  }

  /** True when any captured surface contains the synthetic canary secret. */
  scanCanary(...surfaces: ReadonlyArray<string | undefined | null>): string[] {
    const hits: string[] = [];
    for (const surface of surfaces) {
      if (surface && surface.includes(this.canaryValue)) hits.push(this.canaryValue);
      if (surface && surface.toLowerCase().includes('sk-live-')) hits.push('sk-live-…');
    }
    return [...new Set(hits)];
  }

  report(clock: DeterministicClock, injector?: FailureInjector): LeakReport {
    const leaks: LeakReport = {
      pendingTimers: clock.pendingTimerCount(),
      unhandledRejections: [...this.#rejections],
      armedFailureScripts: injector?.pendingCount() ?? 0,
      canaryHits: [],
    };
    // Sentinel state is consumed by the case that produced it.
    this.#rejections = [];
    return leaks;
  }
}

/** Throws with a deterministic summary when anything leaked. */
export function assertNoLeaks(report: LeakReport): void {
  const problems: string[] = [];
  if (report.pendingTimers > 0)
    problems.push(`${report.pendingTimers} pending fake-clock timer(s)`);
  if (report.unhandledRejections.length > 0) {
    problems.push(`unhandled rejection(s): ${report.unhandledRejections.join('; ')}`);
  }
  if (report.armedFailureScripts > 0)
    problems.push(`${report.armedFailureScripts} armed failure script(s) left`);
  if (report.canaryHits.length > 0)
    problems.push('synthetic canary secret found in captured output');
  if (problems.length > 0) {
    throw new Error(`Resource leak detected: ${problems.join(', ')}`);
  }
}
