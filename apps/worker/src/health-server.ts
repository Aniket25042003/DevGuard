#!/usr/bin/env node
/**
 * Minimal HTTP health listener for platform deploys (Render worker services).
 * Render web/background services expect a bound PORT for health checks.
 */
import { createServer } from 'node:http';

export function startWorkerHealthServer(port: number): () => void {
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'worker' }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '0.0.0.0');
  return () => {
    server.close();
  };
}
