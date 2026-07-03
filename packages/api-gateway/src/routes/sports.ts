import type { FastifyInstance } from 'fastify';

export async function sportsRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  // GET /api/sports
  fastify.get('/api/sports', async (_request, reply) => {
    const result = await db.query(
      'SELECT id, name, slug FROM sports WHERE active = true ORDER BY name'
    );
    return reply.send({ sports: result.rows });
  });

  // GET /api/sports/:id/leagues
  fastify.get<{ Params: { id: string } }>(
    '/api/sports/:id/leagues',
    async (request, reply) => {
      const { id } = request.params;
      const result = await db.query(
        'SELECT id, sport_id, name, country, tier FROM leagues WHERE sport_id = $1 ORDER BY tier, name',
        [id]
      );
      return reply.send({ leagues: result.rows });
    }
  );

  // GET /api/leagues/:id/teams
  fastify.get<{ Params: { id: string } }>(
    '/api/leagues/:id/teams',
    async (request, reply) => {
      const { id } = request.params;
      const result = await db.query(
        'SELECT id, league_id, name, short_name, logo_url FROM teams WHERE league_id = $1 ORDER BY name',
        [id]
      );
      return reply.send({ teams: result.rows });
    }
  );

  // GET /api/matches
  fastify.get<{
    Querystring: { date?: string; league?: string; sport?: string; status?: string };
  }>('/api/matches', async (request, reply) => {
    const { date, league, sport, status } = request.query;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (date) {
      conditions.push(`m.start_time::date = $${paramIdx++}::date`);
      params.push(date);
    }
    if (league) {
      conditions.push(`m.league_id = $${paramIdx++}`);
      params.push(league);
    }
    if (sport) {
      conditions.push(`m.sport_id = $${paramIdx++}`);
      params.push(sport);
    }
    if (status) {
      conditions.push(`m.status = $${paramIdx++}`);
      params.push(status);
    } else {
      conditions.push(`m.status IN ('scheduled', 'live')`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT
        m.id, m.sport_id, m.league_id, m.status, m.start_time,
        m.home_score, m.away_score, m.minute, m.venue,
        ht.name AS home_team, ht.short_name AS home_short, ht.logo_url AS home_logo,
        at.name AS away_team, at.short_name AS away_short, at.logo_url AS away_logo,
        l.name AS league_name, s.name AS sport_name
      FROM matches m
      JOIN teams ht ON m.home_team_id = ht.id
      JOIN teams at ON m.away_team_id = at.id
      JOIN leagues l ON m.league_id = l.id
      JOIN sports s ON m.sport_id = s.id
      ${where}
      ORDER BY m.start_time
      LIMIT 50`,
      params
    );

    return reply.send({ matches: result.rows });
  });

  // GET /api/matches/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/matches/:id',
    async (request, reply) => {
      const { id } = request.params;
      const result = await db.query(
        `SELECT
          m.*,
          ht.name AS home_team, ht.short_name AS home_short, ht.logo_url AS home_logo,
          at.name AS away_team, at.short_name AS away_short, at.logo_url AS away_logo,
          l.name AS league_name, s.name AS sport_name, s.slug AS sport_slug
        FROM matches m
        JOIN teams ht ON m.home_team_id = ht.id
        JOIN teams at ON m.away_team_id = at.id
        JOIN leagues l ON m.league_id = l.id
        JOIN sports s ON m.sport_id = s.id
        WHERE m.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Match not found' });
      }

      return reply.send({ match: result.rows[0] });
    }
  );

  // GET /api/matches/:id/odds
  fastify.get<{ Params: { id: string } }>(
    '/api/matches/:id/odds',
    async (request, reply) => {
      const { id } = request.params;
      const result = await db.query(
        `SELECT id, provider, market, home_odds, draw_odds, away_odds, created_at
         FROM live_odds
         WHERE match_id = $1
         ORDER BY created_at DESC
         LIMIT 20`,
        [id]
      );
      return reply.send({ odds: result.rows });
    }
  );

  // GET /api/matches/:id/stats
  fastify.get<{ Params: { id: string } }>(
    '/api/matches/:id/stats',
    async (request, reply) => {
      const { id } = request.params;
      const result = await db.query(
        `SELECT ms.*, t.name AS team_name
         FROM match_stats ms
         JOIN teams t ON ms.team_id = t.id
         WHERE ms.match_id = $1
         ORDER BY ms.created_at DESC
         LIMIT 2`,
        [id]
      );
      return reply.send({ stats: result.rows });
    }
  );

  // GET /api/matches/:id/h2h
  fastify.get<{ Params: { id: string } }>(
    '/api/matches/:id/h2h',
    async (request, reply) => {
      const { id } = request.params;

      // Get the two teams
      const match = await db.query(
        'SELECT home_team_id, away_team_id FROM matches WHERE id = $1',
        [id]
      );

      if (match.rows.length === 0) {
        return reply.status(404).send({ error: 'Match not found' });
      }

      const { home_team_id, away_team_id } = match.rows[0];

      const result = await db.query(
        `SELECT
          m.id, m.start_time, m.status,
          m.home_score, m.away_score,
          ht.name AS home_team, at.name AS away_team,
          l.name AS league_name
        FROM matches m
        JOIN teams ht ON m.home_team_id = ht.id
        JOIN teams at ON m.away_team_id = at.id
        JOIN leagues l ON m.league_id = l.id
        WHERE (
          (m.home_team_id = $1 AND m.away_team_id = $2) OR
          (m.home_team_id = $2 AND m.away_team_id = $1)
        )
        AND m.id != $3
        AND m.status = 'finished'
        ORDER BY m.start_time DESC
        LIMIT 10`,
        [home_team_id, away_team_id, id]
      );

      return reply.send({ h2h: result.rows });
    }
  );
}
