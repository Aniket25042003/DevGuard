import { describe, expect, it } from 'vitest';
import { installationGrantsPermission } from './lifecycle.js';

describe('installationGrantsPermission', () => {
  it('accepts an exact read grant', () => {
    expect(installationGrantsPermission(['contents: read'], 'contents: read')).toBe(true);
  });

  it('treats write as satisfying read on the same scope', () => {
    expect(installationGrantsPermission(['contents: write'], 'contents: read')).toBe(true);
    expect(installationGrantsPermission(['issues: write'], 'issues: read')).toBe(true);
  });

  it('rejects missing scopes', () => {
    expect(installationGrantsPermission(['metadata: read'], 'contents: read')).toBe(false);
  });
});
