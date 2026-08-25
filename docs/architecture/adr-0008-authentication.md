# ADR-0008: Authentication architecture — GitHub OAuth identity with server-side sessions

- Status: Accepted (2026-08-25)
- Components: C005 (primary), C006, C002
- Context: PRD review A-06 blocks protected APIs until the identity model is selected. C005 §28 recommends OAuth/OIDC authorization-code + PKCE with server-side sessions and asks to choose the provider path and session store.

## Decision

1. **User identity:** direct **GitHub OAuth** authorization-code flow **with PKCE**, state, and nonce (option B in C005 §16). DevGuard links the GitHub `(issuer, subject)` pair to a local DevGuard user id. The GitHub App installation remains the _repository access_ mechanism and is never a browser session.
2. **Sessions:** opaque server-side session tokens. Only a **hash** of the token is stored (`idHash`); the raw token lives exclusively in a `Secure; HttpOnly; SameSite=Lax` cookie. Sessions enforce idle + absolute expiry, rotate the session id at login (fixation defense), revoke on logout, and use optimistic CAS on touch/revoke. CSRF: double-submit header/cookie pair plus same-origin checks on mutations; webhooks are exempt (they verify HMAC signatures instead, C075/C094).
3. **Session store:** PostgreSQL will be the durable store of record once C007/C009 land (`AuthSessionRepository` / `AuthTransactionRepository` ports defined now). Until then an explicitly-marked in-memory adapter satisfies development/tests, and **production startup fails closed** if only the volatile adapter would be bound.
4. **`AUTH_MODE=none`** remains a development/test-only configuration, rejected in production (enforced by C002).

## Rationale

- GitHub OAuth avoids introducing a second managed IdP for the MVP while keeping the `IdentityProviderClient` port provider-neutral (a managed OIDC provider can replace it without touching services).
- Hashed opaque tokens beat JWTs here: instant revocation, no key-spread risk, smaller cookies, and restart-safe durability once PostgreSQL-backed.
- PKCE/state/nonce single-use transactions neutralize code interception, CSRF-style callback forgery, and replay.

## Consequences

- Restart with the volatile dev adapter intentionally invalidates sessions (documented behavior; production requires the durable adapter).
- Provider access tokens are exchanged server-side, used only to fetch the verified identity, and never stored in browser-reachable storage.
