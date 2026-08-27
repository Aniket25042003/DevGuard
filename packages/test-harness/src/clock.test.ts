/**
 * C096 self-tests — deterministic clock + seeded sources.
 * Same seed must produce identical outcomes; the clock never moves backwards
 * and fires timers in deterministic order.
 */
import { describe, expect, it } from 'vitest';
import { DeterministicClock } from '@devguard/test-harness';
import { SeededRandom, SeededIdSource, seededUuidV7 } from '@devguard/test-harness';

describe('DeterministicClock', () => {
  it('starts at the configured instant and advances without firing early timers', () => {
    const clock = new DeterministicClock(1000);
    let fired = 0;
    clock.setTimeout(() => fired++, 500);
    clock.advanceBy(400);
    expect(fired).toBe(0);
    expect(clock.now()).toBe(1400);
    clock.advanceBy(100);
    expect(fired).toBe(1);
  });

  it('fires multiple due timers in deadline order during one advance', () => {
    const clock = new DeterministicClock(0);
    const order: number[] = [];
    clock.setTimeout(() => order.push(2), 20);
    clock.setTimeout(() => order.push(1), 10);
    clock.setTimeout(() => order.push(3), 10); // same deadline: FIFO by id
    clock.advanceBy(50);
    expect(order).toEqual([1, 3, 2]);
  });

  it('counts pending timers so leak sentinels can detect stragglers', () => {
    const clock = new DeterministicClock(0);
    clock.setTimeout(() => undefined, 5);
    clock.setTimeout(() => undefined, 999);
    expect(clock.pendingTimerCount()).toBe(2);
    clock.advanceBy(10);
    expect(clock.pendingTimerCount()).toBe(1);
    clock.clearAll();
    expect(clock.pendingTimerCount()).toBe(0);
  });

  it('rejects negative or non-finite advances', () => {
    const clock = new DeterministicClock(0);
    expect(() => clock.advanceBy(-1)).toThrow(TypeError);
    expect(() => clock.advanceTo(-1)).toThrow(TypeError);
  });
});

describe('SeededRandom / SeededIdSource', () => {
  it('is fully reproducible from a seed', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next());
  });

  it('different seeds diverge immediately', () => {
    const a = new SeededRandom(1);
    const b = new SeededRandom(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('intBetween stays within inclusive bounds and pick throws on empty', () => {
    const rng = new SeededRandom(7);
    for (let i = 0; i < 200; i++) {
      const v = rng.intBetween(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
    expect(() => rng.pick([])).toThrow(/non-empty/);
    expect(rng.pick(['x'])).toBe('x');
  });

  it('does not mutate input arrays when shuffling', () => {
    const rng = new SeededRandom(3);
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    rng.shuffled(input);
    expect(input).toEqual(copy);
    expect([...rng.shuffled(input)].sort((a, b) => a - b)).toEqual(copy);
  });

  it('produces valid UUIDv7 layout and reproduces ids deterministically', () => {
    const id1 = seededUuidV7(1_700_000_000_000, new SeededRandom(11));
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Byte-identical replay from the same seed+clock.
    const runtimeA = new SeededIdSource(99, { now: () => 123 });
    const runtimeB = new SeededIdSource(99, { now: () => 123 });
    expect(runtimeA.nextId()).toBe(runtimeB.nextId());
    expect(runtimeA.nextId()).not.toBe(runtimeA.nextId()); // still unique
  });
});
