#!/usr/bin/env node
/**
 * DevGuard API bootstrap.
 *
 * Startup contract (C002): configuration is validated before the process can
 * become ready. The real HTTP server arrives with C005; until then this entry
 * stays a thin shell proving the composition path.
 */
// TODO(C002): validate configuration before readiness (`loadConfig('api')`).
// TODO(C005): bind the versioned /api/v1 transport here.
export {};
