/**
 * Historical DB MCP Server
 *
 * Direct access to the historical database (PostgreSQL + TimescaleDB).
 * Enables Claude to query:
 * - Historical match results and trends
 * - H2H records going back multiple seasons
 * - Team performance trends over time
 * - League/competition statistics
 * - Player career statistics
 */

import { Pool } from 'redis';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:historical-db');

const TOOLS = [
  {
    name: 'query_h2h',
    description: 'Query full head-to-head history between two teams with custom filters',
    inputSchema: {
      type: 'object',
      properties: {
        team1Id: { type: 'string', description: 'First team ID' },
        team2Id: { type: 'string', description: 'Second team ID' },
        seasons: { type: 'number', description: 'Number of seasons back', default: 5 },
        competition: { type: 'string', description: 'Filter by league ID (optional)' },
      },
      required: ['team1Id', 'team2Id'],
    },
  },
  {
    name: 'get_team_history',
    description: 'Get team performance history across seasons',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        seasons: { type: 'number', default: 5 },
        includeStats: { type: 'boolean', default: true },
      },
      required: ['teamId'],
    },
  },
  {
    name: 'get_league_standings',
    description: 'Get historical league standings for a season',
    inputSchema: {
      type: 'object',
      properties: {
        leagueId: { type: 'string' },
        season: { type: 'string', description: 'Season identifier, e.g. "2024-2025"' },
      },
      required: ['leagueId'],
    },
  },
  {
    name: 'find_similar_matches',
    description: 'Find matches similar to a given match profile (for pattern analysis)',
    inputSchema: {
      type: 'object',
      properties: {
        homeTeamId: { type: 'string' },
        awayTeamId: { type: 'string' },
        homeEloRange: { type: 'number', description: 'ELO tolerance range', default: 100 },
        limit: { type: 'number', default: 10 },
      },
      required: ['homeTeamId', 'awayTeamId'],
    },
  },
  {
    name: 'get_trends',
    description: 'Get statistical trends for a team or league over time',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: { type: 'string', enum: ['team', 'league'] },
        entityId: { type: 'string' },
        metric: { type: 'string', enum: ['goals', 'xg', 'possession', 'cards', 'corners'] },
        lookback: { type: 'number', description: 'Matches to analyze', default: 20 },
      },
      required: ['entityType', 'entityId', 'metric'],
    },
  },
];

// ============================================================
// Server
// ============================================================

class HistoricalDbServer {
  private db: any; // pg Pool
  private redis: any;

  constructor() {
    const { Pool: PgPool } = require('pg') as typeof import('pg');
    this.db = new PgPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'betclaude',
      user: process.env.DB_USER || 'betclaude',
      password: process.env.DB_PASSWORD || 'betclaude_dev',
      max: 5,
    });

    const { createClient } = require('redis') as typeof import('redis');
    this.redis = createClient({
      socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) },
    });
  }

  async start() {
    await this.redis.connect();
    this.listenStdin();
    log.info('Historical DB MCP server started');
  }

  private listenStdin() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          try { this.handleRequest(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    });
    process.stdin.on('end', () => this.shutdown());
  }

  private async handleRequest(req: any) {
    try {
      let result: unknown;
      switch (req.method) {
        case 'initialize':
          result = { protocolVersion: '0.2.0', serverInfo: { name: 'historical-db', version: '0.2.0' }, capabilities: { tools: {} } };
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call':
          result = await this.callTool(req.params?.name, req.params?.arguments || {});
          break;
        case 'resources/list':
          result = { resources: [] };
          break;
        case 'notifications/initialized':
          return;
        default:
          this.sendError(req.id, -32601, `Unknown method: ${req.method}`);
          return;
      }
      this.sendResponse({ jsonrpc: '2.0', id: req.id, result });
    } catch (err: any) {
      this.sendError(req.id, -32603, err.message);
    }
  }

  private async callTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'query_h2h': return this.queryH2H(args);
      case 'get_team_history': return this.getTeamHistory(args);
      case 'get_league_standings': return this.getLeagueStandings(args);
      case 'find_similar_matches': return this.findSimilarMatches(args);
      case 'get_trends': return this.getTrends(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ============================================================
  // Tool implementations
  // ============================================================

  private async queryH2H(args: any): Promise<any> {
    const { team1Id, team2Id, seasons = 5, competition } = args;

    let query = `
      SELECT m.start_time, m.home_score, m.away_score, m.status,
             ht.name as home_team, at.name as away_team,
             l.name as league, s.name as sport
      FROM matches m
      JOIN teams ht ON m.home_team_id = ht.id
      JOIN teams at ON m.away_team_id = at.id
      JOIN leagues l ON m.league_id = l.id
      JOIN sports s ON m.sport_id = s.id
      WHERE (
        (m.home_team_id = $1 AND m.away_team_id = $2) OR
        (m.home_team_id = $2 AND m.away_team_id = $1)
      )
      AND m.status = 'finished'
      AND m.start_time > NOW() - INTERVAL '${seasons} years'
    `;
    const params: any[] = [team1Id, team2Id];

    if (competition) {
      query += ` AND m.league_id = $${params.length + 1}`;
      params.push(competition);
    }

    query += ` ORDER BY m.start_time DESC LIMIT 50`;

    const result = await this.db.query(query, params);

    let homeWins = 0, draws = 0, awayWins = 0, homeGoals = 0, awayGoals = 0;
    const matches = result.rows.map((r: any) => {
      const isTeam1Home = r.home_team === team1Id;
      if (r.home_score > r.away_score) isTeam1Home ? homeWins++ : awayWins++;
      else if (r.home_score < r.away_score) isTeam1Home ? awayWins++ : homeWins++;
      else draws++;
      homeGoals += r.home_score || 0;
      awayGoals += r.away_score || 0;

      return {
        date: r.start_time,
        homeTeam: r.home_team,
        awayTeam: r.away_team,
        score: `${r.home_score}-${r.away_score}`,
        league: r.league,
      };
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          team1Id, team2Id, seasons,
          summary: { totalMatches: matches.length, homeWins, draws, awayWins, totalHomeGoals: homeGoals, totalAwayGoals: awayGoals },
          matches,
        }),
      }],
    };
  }

  private async getTeamHistory(args: any): Promise<any> {
    const { teamId, seasons = 5, includeStats = true } = args;

    // Get team info
    const team = await this.db.query(
      'SELECT name, league_id, metadata FROM teams WHERE id = $1', [teamId]
    );
    if (team.rows.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Team not found' }) }] };
    }

    // Get match history by season
    const matches = await this.db.query(
      `SELECT
         DATE_TRUNC('season', start_time) as season,
         COUNT(*) as played,
         SUM(CASE WHEN (home_team_id = $1 AND home_score > away_score) OR
                       (away_team_id = $1 AND away_score > home_score) THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN home_score = away_score THEN 1 ELSE 0 END) as draws,
         SUM(CASE WHEN (home_team_id = $1 AND home_score < away_score) OR
                       (away_team_id = $1 AND away_score < home_score) THEN 1 ELSE 0 END) as losses,
         SUM(CASE WHEN home_team_id = $1 THEN home_score ELSE away_score END) as goals_for,
         SUM(CASE WHEN home_team_id = $1 THEN away_score ELSE home_score END) as goals_against
       FROM matches
       WHERE (home_team_id = $1 OR away_team_id = $1)
         AND status = 'finished'
         AND start_time > NOW() - INTERVAL '${seasons} years'
       GROUP BY season
       ORDER BY season DESC`,
      [teamId]
    );

    let statsHistory: any[] = [];
    if (includeStats) {
      const stats = await this.db.query(
        `SELECT
           DATE_TRUNC('month', ms.created_at) as month,
           AVG(ms.possession) as avg_possession,
           AVG(ms.shots) as avg_shots,
           AVG(ms.expected_goals) as avg_xg
         FROM match_stats ms
         JOIN matches m ON ms.match_id = m.id
         WHERE ms.team_id = $1
           AND m.start_time > NOW() - INTERVAL '${seasons} years'
         GROUP BY month
         ORDER BY month DESC
         LIMIT 36`,
        [teamId]
      );
      statsHistory = stats.rows;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          teamId,
          teamName: team.rows[0].name,
          seasonHistory: matches.rows,
          statsTrend: statsHistory.map((r: any) => ({
            month: r.month,
            possession: Math.round(parseFloat(r.avg_possession || '0') * 10) / 10,
            shots: Math.round(parseFloat(r.avg_shots || '0') * 10) / 10,
            xg: Math.round(parseFloat(r.avg_xg || '0') * 100) / 100,
          })),
        }),
      }],
    };
  }

  private async getLeagueStandings(args: any): Promise<any> {
    const { leagueId, season } = args;

    // Build standings from match results
    const result = await this.db.query(
      `SELECT
         t.id, t.name,
         COUNT(m.id) as played,
         SUM(CASE WHEN (m.home_team_id = t.id AND m.home_score > m.away_score) OR
                       (m.away_team_id = t.id AND m.away_score > m.home_score) THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN m.home_score = m.away_score THEN 1 ELSE 0 END) as draws,
         SUM(CASE WHEN (m.home_team_id = t.id AND m.home_score < m.away_score) OR
                       (m.away_team_id = t.id AND m.away_score < m.home_score) THEN 1 ELSE 0 END) as losses,
         SUM(CASE WHEN m.home_team_id = t.id THEN m.home_score ELSE m.away_score END) as goals_for,
         SUM(CASE WHEN m.home_team_id = t.id THEN m.away_score ELSE m.home_score END) as goals_against
       FROM teams t
       JOIN matches m ON (m.home_team_id = t.id OR m.away_team_id = t.id)
       WHERE m.league_id = $1 AND m.status = 'finished'
       GROUP BY t.id, t.name
       ORDER BY (SUM(CASE WHEN (m.home_team_id = t.id AND m.home_score > m.away_score) OR
                       (m.away_team_id = t.id AND m.away_score > m.home_score) THEN 3
                     WHEN m.home_score = m.away_score THEN 1 ELSE 0 END)) DESC`,
      [leagueId]
    );

    const standings = result.rows.map((r: any, i: number) => ({
      position: i + 1,
      team: r.name,
      played: parseInt(r.played),
      wins: parseInt(r.wins),
      draws: parseInt(r.draws),
      losses: parseInt(r.losses),
      goalsFor: parseInt(r.goals_for),
      goalsAgainst: parseInt(r.goals_against),
      goalDiff: parseInt(r.goals_for) - parseInt(r.goals_against),
      points: parseInt(r.wins) * 3 + parseInt(r.draws),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ leagueId, season: season || 'current', standings }),
      }],
    };
  }

  private async findSimilarMatches(args: any): Promise<any> {
    const { homeTeamId, awayTeamId, homeEloRange = 100, limit = 10 } = args;

    // Get current team ELOs
    const teams = await this.db.query(
      'SELECT id, name, metadata FROM teams WHERE id IN ($1, $2)',
      [homeTeamId, awayTeamId]
    );

    const homeMeta = teams.rows[0]?.metadata || {};
    const awayMeta = teams.rows[1]?.metadata || {};
    const homeElo = homeMeta.elo || 1500;
    const awayElo = awayMeta.elo || 1500;

    // Find matches with similar ELO profile
    const result = await this.db.query(
      `SELECT m.*, ht.name as home_team, at.name as away_team,
              ht.metadata->>'elo' as home_elo, at.metadata->>'elo' as away_elo,
              l.name as league
       FROM matches m
       JOIN teams ht ON m.home_team_id = ht.id
       JOIN teams at ON m.away_team_id = at.id
       JOIN leagues l ON m.league_id = l.id
       WHERE m.status = 'finished'
         AND (ht.metadata->>'elo')::int BETWEEN $1 AND $2
         AND (at.metadata->>'elo')::int BETWEEN $3 AND $4
         AND m.id NOT IN (
           SELECT id FROM matches
           WHERE (home_team_id = $5 AND away_team_id = $6)
              OR (home_team_id = $6 AND away_team_id = $5)
           ORDER BY start_time DESC LIMIT 1
         )
       ORDER BY m.start_time DESC
       LIMIT $7`,
      [
        homeElo - homeEloRange, homeElo + homeEloRange,
        awayElo - homeEloRange, awayElo + homeEloRange,
        homeTeamId, awayTeamId, limit,
      ]
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          profile: { homeTeamId, awayTeamId, homeElo, awayElo },
          similarMatches: result.rows.map((r: any) => ({
            homeTeam: r.home_team,
            awayTeam: r.away_team,
            score: `${r.home_score}-${r.away_score}`,
            league: r.league,
            date: r.start_time,
            eloDiff: (parseInt(r.home_elo || '1500') - parseInt(r.away_elo || '1500')),
          })),
        }),
      }],
    };
  }

  private async getTrends(args: any): Promise<any> {
    const { entityType, entityId, metric, lookback = 20 } = args;

    if (entityType === 'team') {
      const metricColumn = {
        goals: 'CASE WHEN home_team_id = $1 THEN home_score ELSE away_score END',
        xg: 'ms.expected_goals',
        possession: 'ms.possession',
        cards: 'ms.yellow_cards + ms.red_cards',
        corners: 'ms.corners',
      }[metric] || '1';

      const result = await this.db.query(
        `SELECT m.start_time, ${metricColumn} as value
         FROM matches m
         LEFT JOIN match_stats ms ON ms.match_id = m.id AND ms.team_id = $1
         WHERE (m.home_team_id = $1 OR m.away_team_id = $1)
           AND m.status = 'finished'
         ORDER BY m.start_time DESC
         LIMIT $2`,
        [entityId, lookback]
      );

      const values = result.rows.map((r: any) => parseFloat(r.value) || 0);
      const avg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
      const trend = values.length >= 6
        ? values.slice(0, Math.floor(values.length / 2)).reduce((a: number, b: number) => a + b, 0) / Math.floor(values.length / 2) -
          values.slice(-Math.floor(values.length / 2)).reduce((a: number, b: number) => a + b, 0) / Math.floor(values.length / 2)
        : 0;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            entityType, entityId, metric,
            average: Math.round(avg * 100) / 100,
            trend: trend > 0.3 ? 'increasing' : trend < -0.3 ? 'decreasing' : 'stable',
            trendMagnitude: Math.round(trend * 100) / 100,
            recentValues: values.slice(0, 6).reverse(),
            sampleSize: values.length,
          }),
        }],
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ entityType, entityId, metric, note: 'League trends require league-specific aggregation' }) }],
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  private sendResponse(response: any) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
  private sendError(id: string | number, code: number, message: string) {
    this.sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
  }
  private async shutdown() {
    await this.redis.quit();
    await this.db.end();
    process.exit(0);
  }
}

const server = new HistoricalDbServer();
server.start().catch((err) => { log.error('Fatal error', err); process.exit(1); });
