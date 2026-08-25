/**
 * C005 — GitHub OAuth adapter implementing IdentityProviderClient.
 *
 * Provider-gated: real network calls happen only when composed with live
 * credentials. `fetch` is injectable so contract tests use recorded shapes.
 * Raw provider payloads never leave this file; results normalize to
 * ExternalIdentity.
 */
import { type ExternalIdentity, type IdentityProviderClient } from './principal.js';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
export const GITHUB_ISSUER = 'https://github.com';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubOAuthClientOptions {
  readonly clientId: string;
  /** Resolved client secret VALUE — composition resolves the SecretRef. */
  readonly clientSecret: string;
  readonly fetchImpl?: FetchLike;
}

export class GitHubOAuthClient implements IdentityProviderClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: GitHubOAuthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  buildAuthorizeUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
  }): string {
    const params = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: input.redirectUri,
      scope: 'read:user',
      state: input.state,
      // PKCE + nonce travel with the transaction; GitHub echoes state back and
      // DevGuard binds the code exchange to the stored transaction.
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true',
    });
    return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(input: {
    readonly code: string;
    readonly redirectUri: string;
  }): Promise<{ readonly accessToken: string }> {
    const response = await this.fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    if (!response.ok) {
      throw new Error(`github_token_exchange_failed:${response.status}`);
    }
    const body = (await response.json()) as { access_token?: unknown };
    if (typeof body['access_token'] !== 'string' || body['access_token'].length < 10) {
      throw new Error('github_token_exchange_invalid');
    }
    return { accessToken: body['access_token'] };
  }

  async fetchIdentity(accessToken: string): Promise<ExternalIdentity> {
    const response = await this.fetchImpl(GITHUB_USER_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'DevGuard',
      },
    });
    if (!response.ok) {
      throw new Error(`github_identity_fetch_failed:${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const id = body['id'];
    const login = body['login'];
    if (typeof id !== 'number' || typeof login !== 'string' || login.length === 0) {
      throw new Error('github_identity_shape_invalid');
    }
    const displayName = body['name'];
    return {
      issuer: GITHUB_ISSUER,
      providerSubject: String(id),
      login,
      ...(typeof displayName === 'string' && displayName.length > 0 ? { displayName } : {}),
    };
  }
}
