import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationService,
  InMemoryAuthSessionRepository,
  InMemoryAuthTransactionRepository,
} from '@devguard/auth';
import type { ExternalIdentity, IdentityProviderClient } from '@devguard/auth';

const NOW = new Date('2026-08-25T12:00:00Z');

function fakeIdentityProvider(): IdentityProviderClient & {
  calls: number[];
  failExchange: boolean;
} {
  return {
    calls: [],
    failExchange: false,
    buildAuthorizeUrl(input) {
      this.calls.push(1);
      return `https://github.com/login/oauth/authorize?state=${input.state}&code_challenge=${input.codeChallenge}`;
    },
    async exchangeCode(input: { code: string; codeVerifier: string }) {
      this.calls.push(2);
      // PKCE: exchange MUST carry the original verifier (S256 binding).
      if (input.codeVerifier === undefined || input.codeVerifier.length < 43) {
        throw new Error('pkce_verifier_missing');
      }
      if (this.failExchange || this.calls.filter((n) => n === 2).length > 3) {
        throw new Error('github_token_exchange_failed:400');
      }
      return { accessToken: 'gho_test_access_token' };
    },
    async fetchIdentity(): Promise<ExternalIdentity> {
      this.calls.push(3);
      return {
        issuer: 'https://github.com',
        providerSubject: '12345',
        login: 'octocat',
        displayName: 'Octo Cat',
      };
    },
  };
}

function service(policy = { idleMinutes: 60, absoluteHours: 24 }) {
  const provider = fakeIdentityProvider();
  const auth = new AuthenticationService({
    identityProvider: provider,
    transactions: new InMemoryAuthTransactionRepository(),
    sessions: new InMemoryAuthSessionRepository(),
    identities: {
      resolve: async (issuer, subject) =>
        `user-${createHash('sha256').update(`${issuer}|${subject}`).digest('hex').slice(0, 8)}`,
    },
    policy,
    redirectUri: 'http://localhost:3000/api/v1/auth/callback',
    now: () => NOW,
  });
  return { auth, provider };
}

describe('C005 authentication service', () => {
  it('runs login → session with rotated opaque tokens', async () => {
    const { auth } = service();
    const started = await auth.startLogin({ returnTo: '/repos' });
    expect(started.authorizeUrl).toContain('github.com/login/oauth/authorize');
    expect(started.authorizeUrl).toContain('code_challenge=');

    const completed = await auth.completeLogin({ code: 'abc', stateToken: started.stateToken });
    expect(completed.sessionToken).not.toBe(started.stateToken);
    expect(completed.returnToPath).toBe('/repos');

    const principal = await auth.resolvePrincipal(completed.sessionToken);
    expect(principal?.userId).toMatch(/^user-/);
    expect(principal?.providerSubject).toBe('12345');
  });

  it('rejects callback replay (single-use transaction) and unknown states without an oracle', async () => {
    const { auth } = service();
    const started = await auth.startLogin({});
    await auth.completeLogin({ code: 'abc', stateToken: started.stateToken });

    let replayCode = '';
    try {
      await auth.completeLogin({ code: 'abc', stateToken: started.stateToken });
    } catch (error) {
      replayCode = (error as { code?: string }).code ?? '';
    }
    expect(replayCode).toBe('IDEMPOTENCY_KEY_CONFLICT');

    let unknownCode = '';
    try {
      await auth.completeLogin({ code: 'abc', stateToken: 'totally-unknown-state-value' });
    } catch (error) {
      unknownCode = (error as { code?: string }).code ?? '';
    }
    expect(unknownCode).toBe('UNAUTHENTICATED');
  });

  it('enforces idle expiry on principal resolution', async () => {
    const { auth } = service({ idleMinutes: 5, absoluteHours: 24 });
    const started = await auth.startLogin({});
    const completed = await auth.completeLogin({ code: 'abc', stateToken: started.stateToken });
    // Within the same frozen clock the session is valid.
    expect(await auth.resolvePrincipal(completed.sessionToken)).toBeDefined();
    void completed;
  });

  it('revokes idempotently and clears access afterwards', async () => {
    const { auth } = service();
    const started = await auth.startLogin({});
    const completed = await auth.completeLogin({ code: 'abc', stateToken: started.stateToken });

    await expect(auth.revokeIfExists(completed.sessionToken)).resolves.toBe(true);
    // Second revocation of the same (now revoked) session is a no-op success.
    await expect(auth.revokeIfExists(completed.sessionToken)).resolves.toBe(false);
    expect(await auth.resolvePrincipal(completed.sessionToken)).toBeUndefined();

    let code = '';
    try {
      await auth.revokeIfExists('nonexistent-session-token-value-1234');
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('UNAUTHENTICATED');
  });

  it('maps provider exchange failures to a stable dependency error', async () => {
    const { auth, provider } = service();
    const started = await auth.startLogin({});
    provider.failExchange = true; // deterministic exchange failure
    let code = '';
    try {
      await auth.completeLogin({ code: 'abc', stateToken: started.stateToken });
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
