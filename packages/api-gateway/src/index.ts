import Fastify from 'fastify';
import cors from '@fastify/cors';
import fjwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { Pool } from 'pg';
import { createClient } from 'redis';

import { env } from './config.js';
import { authPlugin } from './middleware/auth.js';
import { rateLimitPlugin } from './middleware/rate-limit.js';
import { authRoutes } from './routes/auth.js';
import { sportsRoutes } from './routes/sports.js';
import { chatRoutes } from './routes/chat.js';
import { wsHandler } from './ws/handler.js';
import { createLogger } from '@betclaude/shared';

const log = createLogger('gateway');

// ============================================================
// Database pool
// ============================================================
const db = new Pool({
  host: env.DB.host,
  port: env.DB.port,
  database: env.DB.database,
  user: env.DB.user,
  password: env.DB.password,
  max: env.isProd ? 20 : 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// ============================================================
// Redis client
// ============================================================
const redis = createClient({
  socket: {
    host: env.REDIS.host,
    port: env.REDIS.port,
  },
});

redis.on('error', (err) => {
  log.warn('Redis connection error (non-fatal for MVP)', err);
});

redis.on('connect', () => {
  log.info('Redis connected');
});

// ============================================================
// Fastify app
// ============================================================
const app = Fastify({
  logger: env.isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : true,
  trustProxy: true,
});

async function bootstrap() {
  // --- Plugins ---
  await app.register(cors, {
    origin: env.isDev ? true : ['https://betclaude.io', 'https://app.betclaude.io'],
    credentials: true,
  });

  await app.register(fjwt, {
    secret: env.JWT.accessSecret,
    sign: { algorithm: 'HS256' },
  });

  await app.register(websocket);

  await app.register(rateLimitPlugin);
  await app.register(authPlugin);

  // --- Decorate with DB and Redis ---
  app.decorate('db', db);
  app.decorate('redis', redis);

  // --- Declare custom decorators for TypeScript ---
  app.decorateReply('sendError', null);

  // --- Routes ---
  await app.register(authRoutes);
  await app.register(sportsRoutes);
  await app.register(chatRoutes);

  // --- WebSocket ---
  await app.register(wsHandler);

  // --- Health check ---
  app.get('/api/health', async (_req, reply) => {
    const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
    const redisOk = redis.isReady;

    return reply.send({
      status: dbOk && redisOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      checks: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
      version: '0.1.0',
    });
  });

  // --- Start ---
  try {
    await redis.connect();

    await app.listen({ host: env.HOST, port: env.PORT });
    log.info(`API Gateway running on http://${env.HOST}:${env.PORT}`);
    log.info(`WebSocket endpoint: ws://${env.HOST}:${env.PORT}/ws/chat`);
  } catch (err) {
    log.error('Failed to start server', err);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down gracefully...`);
  await app.close();
  await db.end();
  if (redis.isReady) {
    await redis.quit();
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Extend Fastify types for our decorators
declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    redis: ReturnType<typeof createClient>;
  }
}

bootstrap();
