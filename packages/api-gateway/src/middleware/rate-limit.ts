import type { FastifyInstance } from 'fastify';
import { RATE_LIMITS } from '@betclaude/shared';

/**
 * Register rate limiting on the Fastify instance.
 * Uses in-memory store (fine for single-node; use Redis store for multi-node).
 */
export async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(import('@fastify/rate-limit'), {
    max: RATE_LIMITS.FREE,
    timeWindow: '1 minute',
    keyGenerator(request) {
      // Rate limit by user ID if authenticated, otherwise by IP
      return request.user?.userId || request.ip;
    },
    hook: 'onRequest',
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
  });
}
