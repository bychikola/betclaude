/**
 * Live Scores MCP Server
 *
 * Provides real-time scores, match events, and live statistics
 * from external APIs (API-Football, Sportradar, etc.).
 * Caches data in Redis with short TTLs for performance.
 */

import { createClient } from 'redis';
import { REDIS_KEYS, createLogger } from '@betclaude/shared';

const log = createLogger('mcp:live-scores');

// ============================================================
// Tools definition
// ============================================================

const TOOLS = [
  {
    name: 'get_live_matches',
    description: 'Get all currently live matches across sports',
    inputSchema: {
      type: 'object',
      properties: {
        sport: {
          type: 'string',
          description: 'Filter by sport slug (football, basketball, tennis, etc.)',
        },
        league: { type: 'string', description: 'Filter by league ID' },
      },
      required: [],
    },
  },
  {
    name: 'get_match_score',
    description: 'Get current score and status for a specific match',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match ID' },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'get_match_events',
    description: 'Get recent events for a match (goals, cards, substitutions)',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match ID' },
        limit: { type: 'number', description: 'Maximum events', default: 20 },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'get_match_timeline',
    description: 'Get chronological timeline of a match including score changes and key moments',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string', description: 'Match ID' },
      },
      required: ['matchId'],
    },
  },
];

// ============================================================
// MCP Server
// ============================================================

class LiveScoresServer {
  private redis: ReturnType<typeof createClient>;
  private apiFootballKey: string;
  private sportradarKey: string;

  constructor() {
    this.redis = createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    });
    this.apiFootballKey = process.env.API_FOOTBALL_KEY || '';
    this.sportradarKey = process.env.SPORTRADAR_KEY || '';
  }

  async start() {
    await this.redis.connect();

    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            this.handleRequest(JSON.parse(line));
          } catch { /* skip invalid json */ }
        }
      }
    });

    process.stdin.on('end', () => this.shutdown());
    log.info('Live Scores MCP server started');
  }

  private async handleRequest(req: any) {
    try {
      let result: unknown;

      switch (req.method) {
        case 'initialize':
          result = {
            protocolVersion: '0.2.0',
            serverInfo: { name: 'live-scores', version: '0.1.0' },
            capabilities: { tools: {} },
          };
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
          this.sendError(req.id, -32601, `Method not found: ${req.method}`);
          return;
      }

      this.sendResponse({ jsonrpc: '2.0', id: req.id, result });
    } catch (err: any) {
      this.sendError(req.id, -32603, err.message);
    }
  }

  private async callTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'get_live_matches':
        return this.getLiveMatches(args);
      case 'get_match_score':
        return this.getMatchScore(args);
      case 'get_match_events':
        return this.getMatchEvents(args);
      case 'get_match_timeline':
        return this.getMatchTimeline(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ============================================================
  // Tool implementations
  // ============================================================

  private async getLiveMatches(args: any): Promise<any> {
    const { sport, league } = args;

    // Try cache first
    const cacheKey = `live:matches:${sport || 'all'}:${league || 'all'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { content: [{ type: 'text', text: cached }] };
    }

    // Build URL for external API
    let url = 'https://v3.football.api-sports.io/fixtures?live=all';
    if (league) url += `&league=${league}`;

    try {
      const response = await fetch(url, {
        headers: {
          'x-apisports-key': this.apiFootballKey,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return this.fallbackLiveMatches(sport, league);
      }

      const data = await response.json();
      const matches = this.normalizeApiFootballResponse(data);

      // Cache for 15 seconds
      const result = JSON.stringify({ matches, count: matches.length, source: 'live' });
      await this.redis.setEx(cacheKey, 15, result);

      return { content: [{ type: 'text', text: result }] };
    } catch (err: any) {
      log.warn(`API-Football fetch failed: ${err.message}, using fallback`);
      return this.fallbackLiveMatches(sport, league);
    }
  }

  private async getMatchScore(args: any): Promise<any> {
    const { matchId } = args;

    // Check Redis cache (15 second TTL from live updates)
    const cacheKey = REDIS_KEYS.LIVE_SCORE(matchId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { content: [{ type: 'text', text: cached }] };
    }

    // Fetch from API
    try {
      const response = await fetch(
        `https://v3.football.api-sports.io/fixtures?id=${matchId}`,
        {
          headers: {
            'x-apisports-key': this.apiFootballKey,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) return this.fallbackScore(matchId);

      const data = await response.json();
      const fixture = data.response?.[0];
      if (!fixture) return this.fallbackScore(matchId);

      const score = {
        matchId,
        status: fixture.fixture?.status?.short || 'NS',
        elapsed: fixture.fixture?.status?.elapsed || 0,
        homeScore: fixture.goals?.home || 0,
        awayScore: fixture.goals?.away || 0,
        homeTeam: fixture.teams?.home?.name,
        awayTeam: fixture.teams?.away?.name,
        league: fixture.league?.name,
      };

      const result = JSON.stringify(score);
      await this.redis.setEx(cacheKey, 15, result);

      return { content: [{ type: 'text', text: result }] };
    } catch {
      return this.fallbackScore(matchId);
    }
  }

  private async getMatchEvents(args: any): Promise<any> {
    const { matchId, limit = 20 } = args;

    try {
      const response = await fetch(
        `https://v3.football.api-sports.io/fixtures/events?fixture=${matchId}`,
        {
          headers: {
            'x-apisports-key': this.apiFootballKey,
            'Accept': 'application/json',
          },
        }
      );

      if (!response.ok) return this.emptyResult('events');

      const data = await response.json();
      const events = (data.response || []).slice(0, limit).map((e: any) => ({
        minute: e.time?.elapsed,
        extra: e.time?.extra,
        type: e.type,
        detail: e.detail,
        player: e.player?.name,
        team: e.team?.name,
        comments: e.comments,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ events, count: events.length }),
        }],
      };
    } catch {
      return this.emptyResult('events');
    }
  }

  private async getMatchTimeline(args: any): Promise<any> {
    const { matchId } = args;

    // Combine score + events into timeline
    const [scoreResult, eventsResult] = await Promise.all([
      this.getMatchScore(args),
      this.getMatchEvents({ matchId, limit: 50 }),
    ]);

    const score = JSON.parse(scoreResult.content[0].text);
    const events = JSON.parse(eventsResult.content[0].text);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matchId,
          timeline: { score, ...events },
        }),
      }],
    };
  }

  // ============================================================
  // Fallbacks (when external APIs are unavailable)
  // ============================================================

  private async fallbackLiveMatches(sport?: string, league?: string): Promise<any> {
    // Return mock/empty data for development
    const mockMatches = [
      {
        id: 'mock-1',
        status: 'live',
        elapsed: 65,
        homeTeam: 'Home FC',
        awayTeam: 'Away United',
        homeScore: 2,
        awayScore: 1,
        league: 'Premier League',
        sport: 'football',
      },
    ];

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matches: sport ? mockMatches.filter(() => true) : mockMatches,
          count: mockMatches.length,
          source: 'mock',
          note: 'Using development mock data. Configure API keys for live data.',
        }),
      }],
    };
  }

  private async fallbackScore(matchId: string): Promise<any> {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          matchId,
          status: 'unknown',
          note: 'Live data not available. Check API configuration.',
        }),
      }],
    };
  }

  private async emptyResult(type: string): Promise<any> {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ [type]: [], count: 0, note: 'No data available' }),
      }],
    };
  }

  // ============================================================
  // Helpers
  // ============================================================

  private normalizeApiFootballResponse(data: any): any[] {
    if (!data.response) return [];
    return data.response.map((f: any) => ({
      id: f.fixture?.id?.toString(),
      status: f.fixture?.status?.short === '1H' || f.fixture?.status?.short === '2H'
        ? 'live' : f.fixture?.status?.short,
      elapsed: f.fixture?.status?.elapsed,
      homeTeam: f.teams?.home?.name,
      awayTeam: f.teams?.away?.name,
      homeScore: f.goals?.home || 0,
      awayScore: f.goals?.away || 0,
      league: f.league?.name,
      sport: 'football',
    }));
  }

  private sendResponse(response: any) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendError(id: string | number, code: number, message: string) {
    this.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  private async shutdown() {
    await this.redis.quit();
    process.exit(0);
  }
}

// Start
const server = new LiveScoresServer();
server.start().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
