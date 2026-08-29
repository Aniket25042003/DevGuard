import { describe, expect, it } from 'vitest';
import { parseGitHubInstallationRef } from './parse-github-installation-ref';

describe('parseGitHubInstallationRef', () => {
  it('accepts a raw installation id', () => {
    expect(parseGitHubInstallationRef('157569422')).toBe('157569422');
  });

  it('extracts id from GitHub settings installation URL', () => {
    expect(
      parseGitHubInstallationRef('https://github.com/settings/installations/157569422'),
    ).toBe('157569422');
  });

  it('extracts id from setup redirect query params', () => {
    expect(
      parseGitHubInstallationRef(
        'https://devguard-olive.vercel.app/settings/github/setup?installation_id=157569422&setup_action=install',
      ),
    ).toBe('157569422');
  });

  it('rejects invalid input', () => {
    expect(parseGitHubInstallationRef('not-an-id')).toBeUndefined();
    expect(parseGitHubInstallationRef('')).toBeUndefined();
  });
});
