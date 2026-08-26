/**
 * C096 §5 — seeded randomness and ID generation.
 *
 * All nondeterministic inputs in tests flow through a single seeded source so
 * a failing case can be replayed byte-for-byte from the seed printed in its
 * evidence manifest (C096 §4.7). uuidv7 construction mirrors @devguard/db's
 * time-ordered IDs but derives the timestamp and randomness from this source.
 */

/** mulberry32 — small, fast, seedable PRNG with a stable contract. */
export class SeededRandom {
  private state: number;

  constructor(readonly readonlySeed: number) {
    if (!Number.isSafeInteger(readonlySeed) || readonlySeed < 0 || readonlySeed > 0xffffffff) {
      throw new TypeError(`Invalid random seed ${String(readonlySeed)}`);
    }
    this.state = readonlySeed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max] inclusive. */
  intBetween(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new TypeError('intBetween requires min <= max as safe integers');
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Pick one element; throws on empty input instead of returning undefined. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new TypeError('pick requires a non-empty array');
    return items[this.intBetween(0, items.length - 1)] as T;
  }

  /** Fisher–Yates copy; the input is never mutated. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.intBetween(0, i);
      const a = out[i] as T;
      const b = out[j] as T;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }
}

const HEX = '0123456789abcdef';

function hexChar(nibble: number): string {
  return HEX.charAt(nibble) ?? '0';
}

/**
 * Deterministic UUIDv7 factory bound to a clock and PRNG.
 * Layout follows RFC 9562: 48-bit unix-ms, version 7, variant `10`.
 */
export function seededUuidV7(clockNowMs: number, random: SeededRandom): string {
  const ts = BigInt(Math.min(clockNowMs, 0xffff_ffff_ffff)) & 0xffff_ffff_ffffn;
  let hex = '';
  for (let shift = BigInt(44); shift >= BigInt(0); shift -= BigInt(4)) {
    hex += hexChar(Number((ts >> shift) & BigInt(0xf)));
  }
  hex += '7'; // RFC 9562 version nibble
  const randA = random.intBetween(0, 0xfff);
  hex += hexChar((randA >> 8) & 0xf) + hexChar((randA >> 4) & 0xf) + hexChar(randA & 0xf);
  hex += hexChar(0x8 + random.intBetween(0, 0x3)); // variant 10xx
  for (let i = 0; i < 15; i++) {
    hex += hexChar(random.intBetween(0, 15));
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class SeededIdSource {
  readonly rng: SeededRandom;
  private counter = 0;

  constructor(
    readonly seed: number,
    private readonly clock: { now(): number },
  ) {
    this.rng = new SeededRandom(seed);
  }

  nextId(): string {
    this.counter += 1;
    return seededUuidV7(this.clock.now() + this.counter, this.rng);
  }
}
