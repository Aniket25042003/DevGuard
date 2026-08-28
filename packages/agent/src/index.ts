/**
 * @devguard/agent — TrueForge AgentRuntime adapter (C036-C040): verified runtime contract, durable sessions/turns, normalized streams, policy interception and context/cancellation.
 *
 * Provider-neutral application layer. External providers and policy/approval
 * wiring reach this package only through typed ports owned here; the
 * composition root (apps) supplies concrete implementations. Provider SDK
 * types and SQL row shapes never cross this boundary.
 */
export {};
