import {
  decodePageCursor,
  encodePageCursor,
  DEFAULT_PAGE_SIZE,
  page,
} from '@devguard/api-contracts';
import { describe, expect, it } from 'vitest';

describe('C005 pagination cursors preserve effective limit (Qodo fix)', () => {
  it('page() encodes the caller-supplied effective limit into nextCursor', () => {
    const result = page(['a', 'b'], 50, 50);
    expect(result.nextCursor).toBeDefined();
    const decoded = decodePageCursor(result.nextCursor);
    expect(decoded).toEqual({ limit: 50, offset: 50 });
  });

  it('round-trips a decoded cursor without reverting to the default size', () => {
    const cursor = encodePageCursor({ limit: 75, offset: 150 });
    const first = decodePageCursor(cursor);
    expect(first.limit).toBe(75);
    const next = page(['x'], first.offset + 75, first.limit);
    const second = decodePageCursor(next.nextCursor);
    expect(second.limit).toBe(75); // not DEFAULT_PAGE_SIZE
    expect(second.offset).toBe(225);
  });

  it('defaults remain bounded and valid', () => {
    expect(DEFAULT_PAGE_SIZE).toBeLessThan(101);
    expect(decodePageCursor(undefined)).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
  });
});
