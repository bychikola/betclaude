/**
 * News Provider MCP Server
 *
 * Provides sports news, injury updates, transfer rumors,
 * press conference highlights, and social media sentiment.
 *
 * Sources:
 * - NewsAPI (major sports outlets)
 * - RSS feeds (team blogs, official sites)
 * - Twitter/X API (player/team accounts) — future
 */

import { createClient } from 'redis';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:news-provider');

const TOOLS = [
  {
    name: 'get_team_news',
    description: 'Get latest news for a specific team',
    inputSchema: {
      type: 'object',
      properties: {
        teamName: { type: 'string', description: 'Team name to search for' },
        limit: { type: 'number', description: 'Max articles', default: 10 },
        days: { type: 'number', description: 'Days back', default: 7 },
      },
      required: ['teamName'],
    },
  },
  {
    name: 'get_match_preview_news',
    description: 'Get news related to an upcoming match — injuries, lineups, press conferences',
    inputSchema: {
      type: 'object',
      properties: {
        homeTeam: { type: 'string', description: 'Home team name' },
        awayTeam: { type: 'string', description: 'Away team name' },
        days: { type: 'number', default: 3 },
      },
      required: ['homeTeam', 'awayTeam'],
    },
  },
  {
    name: 'get_injury_report',
    description: 'Get injury and suspension news for a team',
    inputSchema: {
      type: 'object',
      properties: {
        teamName: { type: 'string' },
      },
      required: ['teamName'],
    },
  },
  {
    name: 'get_league_news',
    description: 'Get latest news from a specific league/competition',
    inputSchema: {
      type: 'object',
      properties: {
        leagueName: { type: 'string' },
        category: { type: 'string', enum: ['transfers', 'injuries', 'tactics', 'general'], default: 'general' },
        limit: { type: 'number', default: 10 },
      },
      required: ['leagueName'],
    },
  },
  {
    name: 'search_news',
    description: 'Search sports news by keyword',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        sport: { type: 'string', description: 'Sport filter' },
        limit: { type: 'number', default: 10 },
        sortBy: { type: 'string', enum: ['relevance', 'date'], default: 'date' },
      },
      required: ['query'],
    },
  },
];

// ============================================================
// Server
// ============================================================

class NewsProviderServer {
  private redis: ReturnType<typeof createClient>;
  private newsApiKey: string;

  constructor() {
    this.redis = createClient({
      socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) },
    });
    this.newsApiKey = process.env.NEWSAPI_KEY || '';
  }

  async start() {
    await this.redis.connect();
    this.listenStdin();
    log.info('News Provider MCP server started');
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
          result = { protocolVersion: '0.2.0', serverInfo: { name: 'news-provider', version: '0.2.0' }, capabilities: { tools: {} } };
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
      case 'get_team_news': return this.getTeamNews(args);
      case 'get_match_preview_news': return this.getMatchPreviewNews(args);
      case 'get_injury_report': return this.getInjuryReport(args);
      case 'get_league_news': return this.getLeagueNews(args);
      case 'search_news': return this.searchNews(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ============================================================
  // Tool implementations
  // ============================================================

  private async getTeamNews(args: any): Promise<any> {
    const { teamName, limit = 10, days = 7 } = args;

    const cacheKey = `news:team:${teamName}:${days}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { content: [{ type: 'text', text: cached }] };
    }

    const articles = await this.fetchNews({
      query: `${teamName} football`,
      from: this.daysAgo(days),
      pageSize: limit,
      sortBy: 'publishedAt',
    });

    const response = JSON.stringify({ teamName, articles, count: articles.length });
    await this.redis.setEx(cacheKey, 300, response); // 5 min cache

    return { content: [{ type: 'text', text: response }] };
  }

  private async getMatchPreviewNews(args: any): Promise<any> {
    const { homeTeam, awayTeam, days = 3 } = args;

    const cacheKey = `news:preview:${homeTeam}:${awayTeam}:${days}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { content: [{ type: 'text', text: cached }] };
    }

    // Fetch news for both teams and the matchup
    const [homeNews, awayNews, matchupNews, injuryNews] = await Promise.all([
      this.fetchNews({ query: `${homeTeam} match preview`, from: this.daysAgo(days), pageSize: 5 }),
      this.fetchNews({ query: `${awayTeam} match preview`, from: this.daysAgo(days), pageSize: 5 }),
      this.fetchNews({ query: `${homeTeam} vs ${awayTeam} preview`, from: this.daysAgo(days), pageSize: 5 }),
      this.fetchNews({ query: `${homeTeam} OR ${awayTeam} injury`, from: this.daysAgo(days), pageSize: 5 }),
    ]);

    const response = JSON.stringify({
      homeTeam, awayTeam,
      homeNews, awayNews, matchupNews,
      injuryUpdates: injuryNews.filter((a: any) =>
        a.title?.toLowerCase().includes('injury') || a.title?.toLowerCase().includes('injured') ||
        a.description?.toLowerCase().includes('injury')
      ),
    });

    await this.redis.setEx(cacheKey, 180, response); // 3 min cache
    return { content: [{ type: 'text', text: response }] };
  }

  private async getInjuryReport(args: any): Promise<any> {
    const { teamName } = args;

    const cacheKey = `news:injuries:${teamName}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return { content: [{ type: 'text', text: cached }] };
    }

    const articles = await this.fetchNews({
      query: `${teamName} injury injured squad suspension`,
      from: this.daysAgo(14),
      pageSize: 15,
      sortBy: 'publishedAt',
    });

    // Extract likely injury mentions
    const injuryMentions = articles
      .filter((a: any) => {
        const text = `${a.title} ${a.description}`.toLowerCase();
        return ['injury', 'injured', 'out', 'doubt', 'suspension', 'suspended', 'unavailable', 'fitness', 'recovery']
          .some(term => text.includes(term));
      })
      .map((a: any) => ({
        title: a.title,
        source: a.source?.name,
        date: a.publishedAt,
        url: a.url,
        snippet: (a.description || '').slice(0, 300),
      }));

    const response = JSON.stringify({
      teamName,
      injuryNews: injuryMentions,
      count: injuryMentions.length,
      note: 'Injury data is extracted from news. For official injury lists, refer to league/team official channels.',
    });

    await this.redis.setEx(cacheKey, 600, response);
    return { content: [{ type: 'text', text: response }] };
  }

  private async getLeagueNews(args: any): Promise<any> {
    const { leagueName, category = 'general', limit = 10 } = args;

    const query = category === 'transfers'
      ? `${leagueName} transfer news rumors`
      : category === 'injuries'
        ? `${leagueName} injuries`
        : category === 'tactics'
          ? `${leagueName} tactics analysis`
          : `${leagueName} football news`;

    const articles = await this.fetchNews({
      query,
      from: this.daysAgo(3),
      pageSize: limit,
      sortBy: 'publishedAt',
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ leagueName, category, articles, count: articles.length }),
      }],
    };
  }

  private async searchNews(args: any): Promise<any> {
    const { query, sport = 'football', limit = 10, sortBy = 'date' } = args;

    const articles = await this.fetchNews({
      query: `${query} ${sport}`,
      pageSize: limit,
      sortBy: sortBy === 'date' ? 'publishedAt' : 'relevancy',
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ query, sport, articles, count: articles.length }),
      }],
    };
  }

  // ============================================================
  // NewsAPI integration
  // ============================================================

  private async fetchNews(params: {
    query: string;
    from?: string;
    pageSize?: number;
    sortBy?: string;
  }): Promise<any[]> {
    // If no API key, return mock data
    if (!this.newsApiKey) {
      return this.generateMockNews(params.query, params.pageSize || 5);
    }

    try {
      const url = new URL('https://newsapi.org/v2/everything');
      url.searchParams.set('q', params.query);
      url.searchParams.set('language', 'en');
      url.searchParams.set('pageSize', String(params.pageSize || 10));
      url.searchParams.set('sortBy', params.sortBy || 'publishedAt');
      if (params.from) url.searchParams.set('from', params.from);
      url.searchParams.set('apiKey', this.newsApiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        log.warn(`NewsAPI returned ${response.status}, using mock data`);
        return this.generateMockNews(params.query, params.pageSize || 5);
      }

      const data = await response.json();
      return (data.articles || []).map((a: any) => ({
        title: a.title,
        source: a.source?.name,
        author: a.author,
        description: a.description,
        url: a.url,
        publishedAt: a.publishedAt,
        imageUrl: a.urlToImage,
      }));
    } catch (err: any) {
      log.warn(`NewsAPI fetch failed: ${err.message}`);
      return this.generateMockNews(params.query, params.pageSize || 5);
    }
  }

  private generateMockNews(query: string, count: number): any[] {
    const templates = [
      { title: `${query} — Pre-match analysis and key battles`, source: 'Sports Analytics Daily' },
      { title: `Injury update: Key players return for ${query}`, source: 'Team News Network' },
      { title: `Tactical preview: What to expect from ${query}`, source: 'The Tactical Board' },
      { title: `${query} — Recent form suggests tight contest`, source: 'Form Guide' },
      { title: `Manager press conference: ${query}`, source: 'Press Room' },
      { title: `Transfer latest: ${query} squad updates`, source: 'Transfer Watch' },
      { title: `Stats breakdown: ${query} by the numbers`, source: 'Stats Hub' },
      { title: `${query} — Fan expectations and predictions`, source: 'Fan Voice' },
    ];

    const now = new Date();
    return templates.slice(0, count).map((t, i) => ({
      title: t.title,
      source: t.source,
      description: `Analysis and updates for ${query}. Key insights and latest developments.`,
      url: `https://example.com/news/${i}`,
      publishedAt: new Date(now.getTime() - i * 3600000).toISOString(),
    }));
  }

  // ============================================================
  // Helpers
  // ============================================================

  private daysAgo(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0]!;
  }

  private sendResponse(response: any) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
  private sendError(id: string | number, code: number, message: string) {
    this.sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
  }
  private async shutdown() {
    await this.redis.quit();
    process.exit(0);
  }
}

const server = new NewsProviderServer();
server.start().catch((err) => { log.error('Fatal error', err); process.exit(1); });
