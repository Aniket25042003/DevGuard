/**
 * C017/CP021 — mint GitHub App installation access tokens over bounded transport.
 */
import type { GitHubTransport } from '../core/client.js';
import { requiredPermissionsFor, SecretString } from './contracts.js';
import type { AppJwtSigner, SecretKeyProvider } from './app-jwt-signer.js';
import type { InstallationTokenMintPort } from './token-lease-cache.js';

const API_VERSION = '2022-11-28';

export interface FetchInstallationTokenMintOptions {
  readonly transport: GitHubTransport;
  readonly signer: AppJwtSigner;
  readonly keyProvider: SecretKeyProvider;
  readonly apiVersion?: string | undefined;
}

export class FetchInstallationTokenMintPort implements InstallationTokenMintPort {
  readonly #transport: GitHubTransport;
  readonly #signer: AppJwtSigner;
  readonly #keyProvider: SecretKeyProvider;
  readonly #apiVersion: string;

  constructor(options: FetchInstallationTokenMintOptions) {
    this.#transport = options.transport;
    this.#signer = options.signer;
    this.#keyProvider = options.keyProvider;
    this.#apiVersion = options.apiVersion ?? API_VERSION;
  }

  async mint(input: {
    installationId: string;
    githubRepositoryIds: readonly string[];
    capabilities: readonly string[];
  }): Promise<{ token: SecretString; expiresAtIso: string }> {
    const permissions = requiredPermissionsFor(input.capabilities as never).reduce<
      Record<string, string>
    >((result, permission) => {
      const separator = permission.indexOf(':');
      if (separator < 1) throw new Error(`invalid GitHub permission '${permission}'`);
      result[permission.slice(0, separator)] = permission.slice(separator + 1).trim();
      return result;
    }, {});
    const key = await this.#keyProvider.load();
    const signed = this.#signer.sign(key);
    const response = await this.#transport.request({
      method: 'POST',
      path: `/app/installations/${encodeURIComponent(input.installationId)}/access_tokens`,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${signed.jwt.expose()}`,
        'x-github-api-version': this.#apiVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repository_ids: input.githubRepositoryIds.map(Number),
        permissions,
      }),
      timeoutMs: 30_000,
      host: 'api.github.com',
    });
    if (response.status !== 201) {
      throw new Error(`installation_token_mint_failed:${response.status}`);
    }
    const parsed = JSON.parse(response.bodyText ?? '{}') as {
      token?: string;
      expires_at?: string;
    };
    if (typeof parsed.token !== 'string' || typeof parsed.expires_at !== 'string') {
      throw new Error('installation_token_mint_schema_mismatch');
    }
    return { token: new SecretString(parsed.token), expiresAtIso: parsed.expires_at };
  }
}
