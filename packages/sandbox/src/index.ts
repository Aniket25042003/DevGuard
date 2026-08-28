/**
 * @devguard/sandbox — Isolated command execution sandbox (C041-C044): workspace checkout, authorized timed commands, resource/egress limits and secure artifact cleanup.
 *
 * Provider-neutral application layer. External providers and policy/approval
 * wiring reach this package only through typed ports owned here; the
 * composition root (apps) supplies concrete implementations. Provider SDK
 * types and SQL row shapes never cross this boundary.
 */
export {};
