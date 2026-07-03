import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { AUTH } from '@betclaude/shared';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../config.js';

// Validation schemas
const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(100),
  role: z.enum(['bettor', 'fan', 'analyst']).default('bettor'),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function authRoutes(fastify: FastifyInstance) {
  // POST /api/auth/register
  fastify.post('/api/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const { email, username, password, role } = parsed.data;
    const db = fastify.db;

    // Check existing user
    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: 'Email or username already taken' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, AUTH.BCRYPT_ROUNDS);

    // Create user
    const result = await db.query(
      `INSERT INTO users (email, username, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, username, role, subscription, created_at`,
      [email, username, passwordHash, role]
    );

    const user = result.rows[0];
    const tokens = generateTokens(fastify, user);

    // Audit log
    await db.query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip_address)
       VALUES ($1, 'user.registered', 'user', $1, $2)`,
      [user.id, request.ip]
    );

    return reply.status(201).send({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        subscription: user.subscription,
      },
      ...tokens,
    });
  });

  // POST /api/auth/login
  fastify.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.flatten(),
      });
    }

    const { email, password } = parsed.data;
    const db = fastify.db;

    const result = await db.query(
      'SELECT id, email, username, role, subscription, password_hash FROM users WHERE email = $1 AND is_active = true',
      [email]
    );

    if (result.rows.length === 0) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const tokens = generateTokens(fastify, user);

    // Store refresh token hash
    const refreshHash = hashToken(tokens.refreshToken);
    await db.query(
      'UPDATE users SET refresh_token_hash = $1, updated_at = NOW() WHERE id = $2',
      [refreshHash, user.id]
    );

    // Audit log
    await db.query(
      `INSERT INTO audit_log (user_id, action, resource_type, ip_address)
       VALUES ($1, 'user.login', 'session', $2)`,
      [user.id, request.ip]
    );

    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        subscription: user.subscription,
      },
      ...tokens,
    });
  });

  // POST /api/auth/refresh
  fastify.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (!refreshToken) {
      return reply.status(400).send({ error: 'Refresh token required' });
    }

    try {
      const decoded = fastify.jwt.verify<{ userId: string; email: string; role: string }>(
        refreshToken,
        { key: env.JWT.refreshSecret }
      );

      const db = fastify.db;
      const result = await db.query(
        'SELECT id, email, role, subscription, refresh_token_hash FROM users WHERE id = $1 AND is_active = true',
        [decoded.userId]
      );

      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid refresh token' });
      }

      const user = result.rows[0];
      const tokenHash = hashToken(refreshToken);

      if (user.refresh_token_hash !== tokenHash) {
        return reply.status(401).send({ error: 'Refresh token reused or revoked' });
      }

      const tokens = generateTokens(fastify, user);

      // Rotate refresh token
      const newHash = hashToken(tokens.refreshToken);
      await db.query(
        'UPDATE users SET refresh_token_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, user.id]
      );

      return reply.send(tokens);
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }
  });

  // POST /api/auth/logout
  fastify.post(
    '/api/auth/logout',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      await fastify.db.query(
        'UPDATE users SET refresh_token_hash = NULL WHERE id = $1',
        [request.user.userId]
      );
      return reply.send({ success: true });
    }
  );

  // GET /api/auth/me
  fastify.get(
    '/api/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const result = await fastify.db.query(
        'SELECT id, email, username, role, subscription, created_at FROM users WHERE id = $1',
        [request.user.userId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'User not found' });
      }

      return reply.send({ user: result.rows[0] });
    }
  );
}

function generateTokens(
  fastify: FastifyInstance,
  user: { id: string; email: string; role: string }
) {
  const accessToken = fastify.jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    { expiresIn: AUTH.ACCESS_TOKEN_TTL }
  );

  const refreshToken = fastify.jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    {
      key: env.JWT.refreshSecret,
      expiresIn: AUTH.REFRESH_TOKEN_TTL,
    }
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: 900, // 15 minutes in seconds
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
