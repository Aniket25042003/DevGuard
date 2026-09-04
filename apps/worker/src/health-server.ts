#!/usr/bin/env node
/**
 * Minimal HTTP health listener for platform deploys (Render worker services).
 * Render web/background services expect a bound PORT for health checks.
 */
import { createServer } from 'node:http';

export function startWorkerHealthServer(port: number, readiness: () => boolean = () => true): () => void {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz' || req.url === '/ready') {
      const live = req.url !== '/ready';
      const ready = live || readiness();
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: ready, role: 'worker', ...(live ? {} : { ready }) }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0');
  return () => {
    server.close();
  };
}
