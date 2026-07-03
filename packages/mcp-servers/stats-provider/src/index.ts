/**
 * Stats Provider MCP Server
 *
 * Provides advanced match statistics: xG, possession heatmaps,
 * player stats, expected assists, passing networks, etc.
 * Data sources: Sportradar API + local TimescaleDB.
 */

import { createClient } from 'redis';
import { Pool } from 'pg';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:stats-provider');

const TOOLS = [
  {
    name: 'get_match_stats',
    description: 'Get detailed match statistics (xG, possession, shots, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match ID' },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'get_xg_timeline',
    description: 'Get expected goals timeline throughout the match',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match ID' },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'get_team_season_stats',
    description: 'Get team season statistics (aggregated)',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: 'Team ID' },
        season: { type: 'string', description: 'Season (e.g., "2024-2025")' },
      },
      required: ['teamId'],
    },
  },
  {
    name: 'get_player_stats',
    description: 'Get player statistics for a match',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match ID' },
        playerId: { type: 'string', description: 'Player ID (optional, returns all if omitted)' },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'compare_team_stats',
    description: 'Compare season statistics between two teams side-by-side',
    inputSchema: {
      type: 'object',
      properties: {
        team1Id: { type: 'string' },
        team2Id: { type: 'string' },
      },
      required: ['team1Id', 'team2Id'],
    },
  },
];

// ============================================================
// Server
// ============================================================

class StatsProviderServer {
  private redis: ReturnType<typeof createClient>;
  private db: Pool;
  private sportradarKey: string;

  constructor() {
    this.redis = createClient({
      socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) },
    });
    this.db = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'betclaude',
      user: process.env.DB_USER || 'betclaude',
      password: process.env.DB_PASSWORD || 'betclaude_dev',
      max: 5,
    });
    this.sportradarKey = process.env.SPORTRADAR_KEY || '';
  }

  async start() {
    await this.redis.connect();
    this.listenStdin();
    log.info('Stats Provider MCP server started');
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
          result = { protocolVersion: '0.2.0', serverInfo: { name: 'stats-provider', version: '0.2.0' }, capabilities: { tools: {} } };
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
      case 'get_match_stats': return this.getMatchStats(args);
      case 'get_xg_timeline': return this.getXgTimeline(args);
      case 'get_team_season_stats': return this.getTeamSeasonStats(args);
      case 'get_player_stats': return this.getPlayerStats(args);
      case 'compare_team_stats': return this.compareTeamStats(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ============================================================
  // Tool implementations
  // ============================================================

  private async getMatchStats(args: any): Promise<any> {
    const { matchId } = args;

    // Check cache
    const cached = await this.redis.get(`stats:match:${matchId}`);
    if (cached) {
      return { content: [{ type: 'text', text: cached }] };
    }

    const result = await this.db.query(
      `SELECT ms.*, t.name as team_name, t.short_name
       FROM match_stats ms
       JOIN teams t ON ms.team_id = t.id
       WHERE ms.match_id = $1
       ORDER BY ms.created_at DESC
       LIMIT 2`,
      [matchId]
    );

    // Also fetch from Sportradar if available
    let externalStats = null;
    if (this.sportradarKey) {
      try {
        externalStats = await this.fetchSportradarStats(matchId);
      } catch { /* use DB only */ }
    }

    const response = JSON.stringify({
      matchId,
      teams: result.rows.map(r => ({
        team: r.team_name,
        possession: r.possession,
        shots: r.shots,
        shotsOnTarget: r.shots_on_target,
        corners: r.corners,
        fouls: r.fouls,
        yellowCards: r.yellow_cards,
        redCards: r.red_cards,
        offsides: r.offsides,
        expectedGoals: r.expected_goals,
        passAccuracy: r.pass_accuracy,
      })),
      external: externalStats,
    });

    await this.redis.setEx(`stats:match:${matchId}`, 120, response);
    return { content: [{ type: 'text', text: response }] };
  }

  private async getXgTimeline(args: any): Promise<any> {
    const { matchId } = args;

    const result = await this.db.query(
      `SELECT team_id, expected_goals, created_at
       FROM match_stats
       WHERE match_id = $1
       ORDER BY created_at ASC`,
      [matchId]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ matchId, timeline: [], note: 'xG data not available for this match' }) }] };
    }

    // Group by team
    const homeTeam = result.rows[0]?.team_id;
    const timeline: any[] = [];
    let cumulativeHome = 0;
    let cumulativeAway = 0;

    for (const row of result.rows) {
      if (row.team_id === homeTeam) {
        cumulativeHome = row.expected_goals || cumulativeHome;
      } else {
        cumulativeAway = row.expected_goals || cumulativeAway;
      }
      timeline.push({
        timestamp: row.created_at,
        homeXg: Math.round(cumulativeHome * 100) / 100,
        awayXg: Math.round(cumulativeAway * 100) / 100,
        xgDiff: Math.round((cumulativeHome - cumulativeAway) * 100) / 100,
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matchId,
          finalHomeXg: Math.round(cumulativeHome * 100) / 100,
          finalAwayXg: Math.round(cumulativeAway * 100) / 100,
          timeline,
        }),
      }],
    };
  }

  private async getTeamSeasonStats(args: any): Promise<any> {
    const { teamId, season } = args;

    const result = await this.db.query(
      `SELECT
         COUNT(*) as matches,
         AVG(possession) as avg_possession,
         AVG(shots) as avg_shots,
         AVG(shots_on_target) as avg_shots_on_target,
         AVG(corners) as avg_corners,
         AVG(fouls) as avg_fouls,
         AVG(expected_goals) as avg_xg,
         AVG(pass_accuracy) as avg_pass_accuracy,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY expected_goals) as median_xg
       FROM match_stats
       WHERE team_id = $1`,
      [teamId]
    );

    const team = await this.db.query('SELECT name FROM teams WHERE id = $1', [teamId]);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          teamId,
          teamName: team.rows[0]?.name || 'Unknown',
          season: season || 'current',
          stats: result.rows[0] ? {
            matches: parseInt(result.rows[0].matches),
            avgPossession: Math.round(parseFloat(result.rows[0].avg_possession || '0') * 10) / 10,
            avgShots: Math.round(parseFloat(result.rows[0].avg_shots || '0') * 10) / 10,
            avgShotsOnTarget: Math.round(parseFloat(result.rows[0].avg_shots_on_target || '0') * 10) / 10,
            avgCorners: Math.round(parseFloat(result.rows[0].avg_corners || '0') * 10) / 10,
            avgXg: Math.round(parseFloat(result.rows[0].avg_xg || '0') * 100) / 100,
            medianXg: Math.round(parseFloat(result.rows[0].median_xg || '0') * 100) / 100,
            avgPassAccuracy: Math.round(parseFloat(result.rows[0].avg_pass_accuracy || '0') * 10) / 10,
          } : null,
        }),
      }],
    };
  }

  private async getPlayerStats(args: any): Promise<any> {
    const { matchId, playerId } = args;

    // Player stats would come from Sportradar/Opta
    // For now, return events involving players
    const query = playerId
      ? `SELECT * FROM match_events WHERE match_id = $1 AND player_id = $2 ORDER BY minute`
      : `SELECT * FROM match_events WHERE match_id = $1 ORDER BY minute`;

    const params = playerId ? [matchId, playerId] : [matchId];
    const result = await this.db.query(query, params);

    // Group by player
    const playerMap = new Map<string, any>();
    for (const row of result.rows) {
      const key = row.player_name || row.player_id || 'unknown';
      if (!playerMap.has(key)) {
        playerMap.set(key, { name: key, events: [], goalCount: 0, cardCount: 0 });
      }
      const p = playerMap.get(key)!;
      p.events.push({ minute: row.minute, type: row.type, detail: row.detail });
      if (row.type === 'goal') p.goalCount++;
      if (row.type === 'yellow_card' || row.type === 'red_card') p.cardCount++;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matchId,
          players: Array.from(playerMap.values()),
          count: playerMap.size,
        }),
      }],
    };
  }

  private async compareTeamStats(args: any): Promise<any> {
    const { team1Id, team2Id } = args;

    const [stats1, stats2, team1, team2] = await Promise.all([
      this.db.query(
        `SELECT AVG(possession) as avg_possession, AVG(shots) as avg_shots,
                AVG(expected_goals) as avg_xg
         FROM match_stats WHERE team_id = $1`, [team1Id]),
      this.db.query(
        `SELECT AVG(possession) as avg_possession, AVG(shots) as avg_shots,
                AVG(expected_goals) as avg_xg
         FROM match_stats WHERE team_id = $1`, [team2Id]),
      this.db.query('SELECT name FROM teams WHERE id = $1', [team1Id]),
      this.db.query('SELECT name FROM teams WHERE id = $1', [team2Id]),
    ]);

    const s1 = stats1.rows[0];
    const s2 = stats2.rows[0];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          team1: {
            name: team1.rows[0]?.name || 'Team 1',
            avgPossession: Math.round(parseFloat(s1?.avg_possession || '0') * 10) / 10,
            avgShots: Math.round(parseFloat(s1?.avg_shots || '0') * 10) / 10,
            avgXg: Math.round(parseFloat(s1?.avg_xg || '0') * 100) / 100,
          },
          team2: {
            name: team2.rows[0]?.name || 'Team 2',
            avgPossession: Math.round(parseFloat(s2?.avg_possession || '0') * 10) / 10,
            avgShots: Math.round(parseFloat(s2?.avg_shots || '0') * 10) / 10,
            avgXg: Math.round(parseFloat(s2?.avg_xg || '0') * 100) / 100,
          },
        }),
      }],
    };
  }

  private async fetchSportradarStats(matchId: string): Promise<any> {
    const response = await fetch(
      `https://api.sportradar.com/soccer/trial/v4/en/sport_events/${matchId}/statistics.json?api_key=${this.sportradarKey}`
    );
    if (!response.ok) return null;
    return response.json();
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

const server = new StatsProviderServer();
server.start().catch((err) => { log.error('Fatal error', err); process.exit(1); });
