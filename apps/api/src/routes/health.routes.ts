/**
 * C074 — health/diagnostics routes (§11).
 *
 * GET /api/v1/health/live  — liveness (no dependency calls; public)
 * GET /api/v1/health/ready — readiness from critical-probe registry (public,
 *                              never leaks internals). Readiness is NOT
 *                              request-time authority.
 */
import type { RegisterV1Route } from '../transport/kernel.js';

export interface HealthProbeName {
  readonly name: string;
  readonly critical: boolean;
  check(): Promise<{ ok: boolean }>;
}

export function registerHealthRoutes(
  kernel: { registerV1Route: RegisterV1Route },
  probes: readonly HealthProbeName[],
): void {
  kernel.registerV1Route(
    'get',
    '/api/v1/health/live',
    { rateLimitClass: 'default', authClass: 'public' },
    async (c) => {
      return c.json({ status: 'ok' });
    },
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/health/ready',
    { rateLimitClass: 'default', authClass: 'public' },
    async (c) => {
      const results = [];
      let level = 'healthy';
      for (const probe of probes) {
        let ok: boolean;
        try {
          ok = (await probe.check()).ok;
        } catch {
          ok = false;
        }
        results.push({ name: probe.name, ok });
        if (!ok && probe.critical) level = 'unhealthy';
        else if (!ok && level === 'healthy') level = 'degraded';
      }
      const healthy = level === 'healthy';
      return c.json({ ready: healthy, level, probes: results }, healthy ? 200 : 503);
    },
  );
}
