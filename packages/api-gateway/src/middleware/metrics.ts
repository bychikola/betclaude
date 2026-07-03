/**
 * Prometheus-compatible metrics middleware.
 * Exposes metrics at GET /api/metrics.
 */

import type { FastifyInstance } from 'fastify';
import { getActiveClientCount } from '../ws/handler.js';

// In-memory metrics (replace with prom-client in production)
const metrics = {
  httpRequestsTotal: 0,
  wsConnectionsTotal: 0,
  wsMessagesTotal: 0,
  claudeProcessesTotal: 0,
  errorsTotal: 0,
  requestDurationBuckets: { fast: 0, medium: 0, slow: 0 },
};

export function incrementHttpRequest() { metrics.httpRequestsTotal++; }
export function incrementWsConnection() { metrics.wsConnectionsTotal++; }
export function incrementWsMessage() { metrics.wsMessagesTotal++; }
export function incrementError() { metrics.errorsTotal++; }
export function recordDuration(ms: number) {
  if (ms < 100) metrics.requestDurationBuckets.fast++;
  else if (ms < 1000) metrics.requestDurationBuckets.medium++;
  else metrics.requestDurationBuckets.slow++;
}

export async function metricsPlugin(fastify: FastifyInstance) {
  // Track HTTP requests
  fastify.addHook('onRequest', async () => { incrementHttpRequest(); });

  fastify.addHook('onResponse', async (request, reply) => {
    const duration = reply.elapsedTime;
    recordDuration(duration);
  });

  fastify.addHook('onError', async () => { incrementError(); });

  // Prometheus metrics endpoint
  fastify.get('/api/metrics', async (_request, reply) => {
    const lines = [
      '# HELP betclaude_http_requests_total Total HTTP requests',
      '# TYPE betclaude_http_requests_total counter',
      `betclaude_http_requests_total ${metrics.httpRequestsTotal}`,
      '',
      '# HELP betclaude_ws_connections_total Total WebSocket connections',
      '# TYPE betclaude_ws_connections_total counter',
      `betclaude_ws_connections_total ${metrics.wsConnectionsTotal}`,
      '',
      '# HELP betclaude_ws_messages_total Total WebSocket messages',
      '# TYPE betclaude_ws_messages_total counter',
      `betclaude_ws_messages_total ${metrics.wsMessagesTotal}`,
      '',
      '# HELP betclaude_errors_total Total errors',
      '# TYPE betclaude_errors_total counter',
      `betclaude_errors_total ${metrics.errorsTotal}`,
      '',
      '# HELP betclaude_active_ws_clients Active WebSocket clients',
      '# TYPE betclaude_active_ws_clients gauge',
      `betclaude_active_ws_clients ${getActiveClientCount()}`,
      '',
      '# HELP betclaude_request_duration_seconds Request duration distribution',
      '# TYPE betclaude_request_duration_seconds histogram',
      `betclaude_request_duration_seconds_bucket{le="0.1"} ${metrics.requestDurationBuckets.fast}`,
      `betclaude_request_duration_seconds_bucket{le="1.0"} ${metrics.requestDurationBuckets.medium}`,
      `betclaude_request_duration_seconds_bucket{le="+Inf"} ${metrics.requestDurationBuckets.slow}`,
      '',
      '# HELP betclaude_info BetClaude build info',
      '# TYPE betclaude_info gauge',
      'betclaude_info{version="0.3.0",node="' + (process.env.HOSTNAME || 'local') + '"} 1',
    ];

    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(lines.join('\n'));
  });
}
