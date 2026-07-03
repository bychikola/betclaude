import type { FastifyInstance } from 'fastify';

export async function chatRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // All chat routes require authentication
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/chat/sessions
  fastify.get('/api/chat/sessions', async (request, reply) => {
    const result = await db.query(
      `SELECT id, title, sport, status, message_count, created_at, updated_at
       FROM sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [request.user.userId]
    );
    return reply.send({ sessions: result.rows });
  });

  // GET /api/chat/sessions/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/chat/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;

      // Verify ownership
      const session = await db.query(
        'SELECT id, user_id FROM sessions WHERE id = $1',
        [id]
      );

      if (session.rows.length === 0) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      if (session.rows[0].user_id !== request.user.userId) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const messages = await db.query(
        `SELECT id, role, content, tool_calls, metadata, created_at
         FROM chat_messages
         WHERE session_id = $1
         ORDER BY created_at
         LIMIT 500`,
        [id]
      );

      return reply.send({
        session: session.rows[0],
        messages: messages.rows,
      });
    }
  );

  // DELETE /api/chat/sessions/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/chat/sessions/:id',
    async (request, reply) => {
      const { id } = request.params;

      const session = await db.query(
        'SELECT id, user_id FROM sessions WHERE id = $1',
        [id]
      );

      if (session.rows.length === 0) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      if (session.rows[0].user_id !== request.user.userId) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      await db.query('DELETE FROM sessions WHERE id = $1', [id]);

      return reply.send({ success: true });
    }
  );
}
