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
    async (c) => c.json({ status: 'ok' }),
  );

  kernel.registerV1Route(
    'get',
    '/api/v1/health/ready',
    { rateLimitClass: 'default', authClass: 'public' },
    async (c) => {
      const results = await Promise.all(
        probes.map(async (probe) => {
          let ok: boolean;
          try {
            ok = (
              await Promise.race([
                probe.check(),
                new Promise<{ ok: boolean }>((resolve) =>
                  setTimeout(() => resolve({ ok: false }), 2_000),
                ),
              ])
            ).ok;
          } catch {
            ok = false;
          }
          return { name: probe.name, ok, critical: probe.critical };
        }),
      );
      const level = results.some((r) => !r.ok && r.critical)
        ? 'unhealthy'
        : results.some((r) => !r.ok)
          ? 'degraded'
          : 'healthy';
      const healthy = !results.some((r) => !r.ok && r.critical);
      return c.json({ ready: healthy, level, probes: results }, healthy ? 200 : 503);
    },
  );
}
