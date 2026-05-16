import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';

/**
 * Wave 3 #35 — Prometheus-format `/metrics` endpoint.
 *
 * Pure in-house — no `prom-client` dependency. Tavern only needs a handful
 * of counters and gauges; emitting the text format by hand keeps the
 * install footprint zero and the implementation auditable.
 *
 * Operators wire Prometheus to scrape `GET /metrics`. The endpoint is
 * unauthenticated by design (Prometheus runs inside the operator's
 * private network); restrict access at the reverse-proxy layer.
 */

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function registerMetricsPlugin(app: FastifyInstance): void {
  // Hook every request into a counter so the metrics endpoint shows
  // something useful out of the box. Operators can layer additional
  // counters via `incrementCounter` from their own routes.
  app.addHook('onResponse', (_req, reply, done) => {
    incrementCounter('tavern_http_requests_total');
    incrementCounter(`tavern_http_requests_status_${reply.statusCode}`);
    done();
  });

  app.get('/metrics', async (_req, reply) => {
    const lines: string[] = [];
    // Refresh DB-backed gauges on each scrape. Cheap counts.
    try {
      const [userCount, serverCount, sessionCount] = await Promise.all([
        prisma.user.count(),
        prisma.server.count(),
        prisma.session.count({ where: { revokedAt: null } }),
      ]);
      setGauge('tavern_users_total', userCount);
      setGauge('tavern_servers_total', serverCount);
      setGauge('tavern_active_sessions', sessionCount);
    } catch {
      // Database hiccup shouldn't fail the metrics endpoint.
    }

    lines.push('# HELP tavern_users_total Number of registered users.');
    lines.push('# TYPE tavern_users_total gauge');
    for (const [name, value] of gauges) {
      lines.push(`${name} ${value}`);
    }
    for (const [name, value] of counters) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }
    reply.header('content-type', 'text/plain; version=0.0.4');
    reply.send(lines.join('\n') + '\n');
  });
}
