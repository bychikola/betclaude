import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { WsClientMessage, WsServerMessage } from '@betclaude/shared';
import { WS, REDIS_KEYS } from '@betclaude/shared';
import type { JwtPayload } from '../middleware/auth.js';
import { createLogger } from '@betclaude/shared';

const log = createLogger('ws');

interface WsClient {
  ws: WebSocket;
  userId: string;
  sessionId?: string;
  alive: boolean;
}

const clients = new Map<string, WsClient>();

/**
 * Register WebSocket handler on the Fastify instance.
 */
export async function wsHandler(fastify: FastifyInstance) {
  // Heartbeat interval
  const heartbeat = setInterval(() => {
    for (const [key, client] of clients) {
      if (!client.alive) {
        log.info(`Terminating dead WS connection: ${key}`);
        client.ws.terminate();
        clients.delete(key);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, WS.HEARTBEAT_INTERVAL_MS);

  fastify.addHook('onClose', () => {
    clearInterval(heartbeat);
  });

  // WebSocket endpoint
  fastify.get('/ws/chat', { websocket: true }, (socket, request) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');

    if (!token) {
      sendMessage(socket, {
        type: 'error',
        sessionId: '',
        message: 'Authentication token required',
        code: 'AUTH_REQUIRED',
      });
      socket.close(4001, 'Authentication required');
      return;
    }

    // Verify JWT
    let user: JwtPayload;
    try {
      user = fastify.jwt.verify<JwtPayload>(token);
    } catch {
      sendMessage(socket, {
        type: 'error',
        sessionId: '',
        message: 'Invalid or expired token',
        code: 'AUTH_INVALID',
      });
      socket.close(4001, 'Invalid token');
      return;
    }

    const clientKey = `ws:${user.userId}:${Date.now()}`;
    const wsClient: WsClient = { ws: socket, userId: user.userId, alive: true };
    clients.set(clientKey, wsClient);

    log.info(`WS connected: user=${user.userId} key=${clientKey}`);

    // Handle pong
    socket.on('pong', () => {
      wsClient.alive = true;
    });

    // Handle messages from client
    socket.on('message', async (raw) => {
      try {
        const msg: WsClientMessage = JSON.parse(raw.toString());
        await handleClientMessage(fastify, wsClient, msg);
      } catch (err) {
        log.error('Failed to parse WS message', err);
        sendMessage(socket, {
          type: 'error',
          sessionId: wsClient.sessionId || '',
          message: 'Invalid message format',
          code: 'PARSE_ERROR',
        });
      }
    });

    // Handle disconnect
    socket.on('close', () => {
      log.info(`WS disconnected: user=${user.userId} key=${clientKey}`);
      clients.delete(clientKey);

      // Notify orchestrator about disconnection (via Redis pub/sub)
      if (wsClient.sessionId) {
        const redis = fastify.redis;
        if (redis) {
          redis.publish(
            'session:disconnect',
            JSON.stringify({
              sessionId: wsClient.sessionId,
              userId: user.userId,
            })
          ).catch(() => {});
        }
      }
    });

    // Handle errors
    socket.on('error', (err) => {
      log.error(`WS error for user=${user.userId}`, err);
    });
  });
}

async function handleClientMessage(
  fastify: FastifyInstance,
  client: WsClient,
  msg: WsClientMessage
) {
  const { ws } = client;
  const redis = fastify.redis;

  switch (msg.type) {
    case 'message': {
      // Forward to Session Orchestrator via Redis pub/sub
      if (!redis) {
        sendMessage(ws, {
          type: 'error',
          sessionId: '',
          message: 'Service temporarily unavailable',
          code: 'NO_REDIS',
        });
        return;
      }

      // Check rate limit
      const rateKey = REDIS_KEYS.RATE_LIMIT(client.userId);
      const count = await redis.incr(rateKey);
      if (count === 1) {
        await redis.expire(rateKey, 60);
      }
      if (count > 60) {
        sendMessage(ws, {
          type: 'error',
          sessionId: msg.sessionId || '',
          message: 'Rate limit exceeded. Please wait.',
          code: 'RATE_LIMITED',
        });
        return;
      }

      // Publish to orchestrator
      await redis.publish(
        'session:message',
        JSON.stringify({
          userId: client.userId,
          sessionId: msg.sessionId,
          content: msg.content,
          replyTo: `session:${client.userId}`,
        })
      );

      break;
    }

    case 'reconnect': {
      if (!redis) {
        sendMessage(ws, {
          type: 'error',
          sessionId: '',
          message: 'Service temporarily unavailable',
          code: 'NO_REDIS',
        });
        return;
      }

      await redis.publish(
        'session:reconnect',
        JSON.stringify({
          userId: client.userId,
          sessionId: msg.sessionId,
          replyTo: `session:${client.userId}`,
        })
      );

      client.sessionId = msg.sessionId;
      break;
    }

    case 'cancel': {
      if (redis) {
        await redis.publish(
          'session:cancel',
          JSON.stringify({
            sessionId: msg.sessionId,
            userId: client.userId,
          })
        );
      }
      break;
    }

    default:
      sendMessage(ws, {
        type: 'error',
        sessionId: client.sessionId || '',
        message: `Unknown message type: ${(msg as any).type}`,
        code: 'UNKNOWN_TYPE',
      });
  }
}

/** Helper: send a WS message to a socket */
export function sendMessage(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/** Helper: send WS message to a specific user's all connections */
export function sendToUser(userId: string, msg: WsServerMessage) {
  for (const [, client] of clients) {
    if (client.userId === userId) {
      sendMessage(client.ws, msg);
    }
  }
}

/** Get active client count */
export function getActiveClientCount(): number {
  return clients.size;
}
