import { describe, expect, it } from 'vitest';
import { readCookie, readCsrfToken } from './csrf';

describe('CSRF cookie reader', () => {
  it('reads the named cookie and ignores neighbors', () => {
    expect(readCookie('devguard_csrf', 'a=1; devguard_csrf=token%2B1; b=2')).toBe('token+1');
    expect(readCsrfToken(() => 'devguard_csrf=abc')).toBe('abc');
    expect(readCsrfToken(() => undefined)).toBeUndefined();
  });
});
