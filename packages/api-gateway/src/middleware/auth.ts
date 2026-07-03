import type { FastifyRequest, FastifyReply } from 'fastify';
import type { User } from '@betclaude/shared';

// JWT payload stored in request
export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
}

// Extend Fastify types
declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    optionalAuth: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
    requireRole: (...roles: string[]) => (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

/**
 * Fastify plugin that registers auth decorators
 */
export async function authPlugin(fastify: import('fastify').FastifyInstance) {
  // Remove any previously registered decorators if they exist (hot-reload safety)
  // Register the authenticate decorator
  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        const token = extractToken(request);
        if (!token) {
          return reply.status(401).send({ error: 'Authentication required' });
        }
        const decoded = fastify.jwt.verify<JwtPayload>(token);
        request.user = decoded;
      } catch (err) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }
    }
  );

  fastify.decorate(
    'optionalAuth',
    async function (request: FastifyRequest, _reply: FastifyReply) {
      try {
        const token = extractToken(request);
        if (token) {
          const decoded = fastify.jwt.verify<JwtPayload>(token);
          request.user = decoded;
        }
      } catch {
        // No auth — that's fine for optional
      }
    }
  );

  fastify.decorate(
    'requireRole',
    function (...roles: string[]) {
      return async function (request: FastifyRequest, reply: FastifyReply) {
        if (!request.user) {
          return reply.status(401).send({ error: 'Authentication required' });
        }
        if (!roles.includes(request.user.role)) {
          return reply.status(403).send({ error: 'Insufficient permissions' });
        }
      };
    }
  );
}

function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return null;
}
