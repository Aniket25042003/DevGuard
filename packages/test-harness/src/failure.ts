/**
 * C096 §5/§12 — failure injection at declared boundaries only.
 *
 * Injection points are an explicit enum, not arbitrary call sites. Domain and
 * application code never knows about the injector: tests hook boundaries
 * (before/after DB commit, enqueue, provider send, stream event, checkpoint,
 * artifact promotion) through adapters that consult this registry.
 */
export const FAILURE_POINTS = [
  'db.before-commit',
  'db.after-commit',
  'queue.enqueue',
  'provider.send',
  'stream.event',
  'checkpoint.wait',
  'artifact.promote',
] as const;

export type FailurePoint = (typeof FAILURE_POINTS)[number];

export interface FailureScript {
  /** Throw once then remove itself when `once` (default). */
  readonly once?: boolean;
  readonly errorFactory: () => Error;
}

interface ArmedScript extends FailureScript {
  fired: number;
}

export class FailureInjector {
  #armed = new Map<FailurePoint, ArmedScript>();

  arm(point: FailurePoint, script: FailureScript): void {
    if (!FAILURE_POINTS.includes(point)) {
      throw new TypeError(`Unknown failure point '${String(point)}'`);
    }
    this.#armed.set(point, { ...script, fired: 0 });
  }

  disarm(point: FailurePoint): void {
    this.#armed.delete(point);
  }

  disarmAll(): void {
    this.#armed.clear();
  }

  /**
   * Consulted by boundary adapters. Throws the scripted error when armed;
   * never mutates state for unarmed points.
   */
  maybeInject(point: FailurePoint): void {
    const armed = this.#armed.get(point);
    if (!armed) return;
    armed.fired += 1;
    if (armed.once ?? true) this.#armed.delete(point);
    throw armed.errorFactory();
  }

  pendingCount(): number {
    return this.#armed.size;
  }
}
