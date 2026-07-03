/**
 * Pattern Finder MCP Server — discovers statistical patterns in match data.
 * Identifies trends, anomalies, and recurring patterns.
 */

import { Pool } from 'pg';
import { createClient } from 'redis';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:pattern-finder');

const TOOLS = [
  { name: 'find_form_patterns', description: 'Discover form patterns (W/L/D streaks, scoring runs) for a team',
    inputSchema: { type: 'object', properties: { teamId: { type: 'string' }, matches: { type: 'number', default: 20 } }, required: ['teamId'] } },
  { name: 'find_scoring_patterns', description: 'Analyze goal scoring patterns (timing, frequency, set pieces vs open play)',
    inputSchema: { type: 'object', properties: { teamId: { type: 'string' }, matches: { type: 'number', default: 15 } }, required: ['teamId'] } },
  { name: 'find_odds_patterns', description: 'Find patterns in odds movement and identify market inefficiencies',
    inputSchema: { type: 'object', properties: { matchId: { type: 'string' } }, required: ['matchId'] } },
  { name: 'detect_anomalies', description: 'Detect statistical anomalies in team performance (unusual results)',
    inputSchema: { type: 'object', properties: { teamId: { type: 'string' }, threshold: { type: 'number', default: 2 } }, required: ['teamId'] } },
];

class PatternFinderServer {
  private db: Pool;
  private redis: ReturnType<typeof createClient>;

  constructor() {
    this.db = new Pool({ host: process.env.DB_HOST||'localhost', port: parseInt(process.env.DB_PORT||'5432'), database: process.env.DB_NAME||'betclaude', user: process.env.DB_USER||'betclaude', password: process.env.DB_PASSWORD||'betclaude_dev', max: 3 });
    this.redis = createClient({ socket: { host: process.env.REDIS_HOST||'localhost', port: parseInt(process.env.REDIS_PORT||'6379') } });
  }

  async start() {
    await this.redis.connect().catch(() => {});
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()||''; for (const line of lines) { if(line.trim()) { try{this.handleRequest(JSON.parse(line))}catch{}} } });
    process.stdin.on('end', () => { this.db.end(); this.redis.quit(); process.exit(0); });
    log.info('Pattern Finder MCP started');
  }

  private async handleRequest(req: any) {
    try {
      let r: unknown;
      switch(req.method) {
        case 'initialize': r = { protocolVersion:'0.2.0', serverInfo:{name:'pattern-finder',version:'0.3.0'}, capabilities:{tools:{}} }; break;
        case 'tools/list': r = { tools: TOOLS }; break;
        case 'tools/call': r = await this.callTool(req.params?.name, req.params?.arguments||{}); break;
        case 'resources/list': r = { resources:[] }; break;
        case 'notifications/initialized': return;
        default: this.sendErr(req.id,-32601,req.method); return;
      }
      this.send({ jsonrpc:'2.0', id:req.id, result:r });
    } catch(e:any) { this.sendErr(req.id,-32603,e.message); }
  }

  private async callTool(name: string, args: any): Promise<any> {
    switch(name) {
      case 'find_form_patterns': return this.formPatterns(args);
      case 'find_scoring_patterns': return this.scoringPatterns(args);
      case 'find_odds_patterns': return this.oddsPatterns(args);
      case 'detect_anomalies': return this.detectAnomalies(args);
      default: throw new Error(`Unknown: ${name}`);
    }
  }

  private async formPatterns(args: any): Promise<any> {
    const { teamId, matches = 20 } = args;
    const result = await this.db.query(
      `SELECT start_time, home_score, away_score, home_team_id, ht.name as home_team, at.name as away_team
       FROM matches m JOIN teams ht ON m.home_team_id=ht.id JOIN teams at ON m.away_team_id=at.id
       WHERE (home_team_id=$1 OR away_team_id=$1) AND status='finished'
       ORDER BY start_time DESC LIMIT $2`, [teamId, matches]);

    const results = result.rows.map((r: any) => {
      const isHome = r.home_team_id === teamId;
      const gf = isHome ? r.home_score : r.away_score;
      const ga = isHome ? r.away_score : r.home_score;
      return { date: r.start_time, opponent: isHome ? r.away_team : r.home_team, gf, ga, result: gf>ga?'W':gf===ga?'D':'L' };
    });

    // Find streaks
    const streaks: any[] = [];
    let currentStreak = { type: results[0]?.result, count: 0 };
    for (const m of results) {
      if (m.result === currentStreak.type) { currentStreak.count++; }
      else { if (currentStreak.count >= 3) streaks.push({...currentStreak}); currentStreak = { type: m.result, count: 1 }; }
    }
    if (currentStreak.count >= 3) streaks.push(currentStreak);

    // Home/Away split
    const home = results.filter((r: any) => r.opponent && results.indexOf(r) % 2 === 0);
    const pts = results.reduce((s: number, r: any) => s + (r.result==='W'?3:r.result==='D'?1:0), 0);

    return { content: [{ type: 'text', text: JSON.stringify({ teamId, analyzed: results.length, pointsPerGame: Math.round(pts/results.length*100)/100, streaks, results: results.slice(0,10) }) }] };
  }

  private async scoringPatterns(args: any): Promise<any> {
    const { teamId, matches = 15 } = args;
    const events = await this.db.query(
      `SELECT me.type, me.minute, me.detail, m.start_time
       FROM match_events me JOIN matches m ON me.match_id=m.id
       WHERE me.team_id=$1 AND me.type='goal' ORDER BY m.start_time DESC LIMIT ${matches*5}`, [teamId]);

    const goalsByMinute = new Array(10).fill(0); // 0-9, 10-19, ... 80-90
    for (const e of events.rows) {
      const bucket = Math.min(9, Math.floor((e.minute||0)/10));
      goalsByMinute[bucket]++;
    }
    const total = events.rows.length;
    const timing = goalsByMinute.map((c, i) => ({ period: `${i*10}-${(i+1)*10}'`, count: c, pct: total ? Math.round(c/total*100) : 0 }));

    return { content: [{ type: 'text', text: JSON.stringify({ teamId, totalGoals: total, timing, mostDangerous: timing.sort((a:any,b:any)=>b.count-a.count)[0] }) }] };
  }

  private async oddsPatterns(args: any): Promise<any> {
    const { matchId } = args;
    const result = await this.db.query(`SELECT * FROM live_odds WHERE match_id=$1 ORDER BY created_at`, [matchId]);
    if (result.rows.length < 2) return { content: [{ type: 'text', text: JSON.stringify({ matchId, pattern: 'Insufficient data' }) }] };

    const first = result.rows[0]; const last = result.rows[result.rows.length-1];
    const homeMoved = last.home_odds - first.home_odds;
    const awayMoved = last.away_odds - first.away_odds;
    const direction = homeMoved < -0.1 ? 'Home odds shortening (more bets on home)' : homeMoved > 0.1 ? 'Home odds drifting (more bets on away)' : 'Stable';

    return { content: [{ type: 'text', text: JSON.stringify({ matchId, dataPoints: result.rows.length, firstOdds: { home: first.home_odds, away: first.away_odds }, lastOdds: { home: last.home_odds, away: last.away_odds }, movement: { homeChange: Math.round(homeMoved*100)/100, awayChange: Math.round(awayMoved*100)/100 }, direction }) }] };
  }

  private async detectAnomalies(args: any): Promise<any> {
    const { teamId, threshold = 2 } = args;
    const result = await this.db.query(
      `SELECT m.*, ht.name as h, at.name as a, ms.expected_goals as xg
       FROM matches m JOIN teams ht ON m.home_team_id=ht.id JOIN teams at ON m.away_team_id=at.id
       LEFT JOIN match_stats ms ON ms.match_id=m.id AND ms.team_id=$1
       WHERE (m.home_team_id=$1 OR m.away_team_id=$1) AND m.status='finished'
       ORDER BY m.start_time DESC LIMIT 30`, [teamId]);

    const anomalies: any[] = [];
    for (const r of result.rows) {
      const isHome = r.home_team_id === teamId;
      const gf = isHome ? r.home_score : r.away_score;
      const ga = isHome ? r.away_score : r.home_score;
      const diff = gf - ga;
      if (Math.abs(diff) >= threshold) {
        anomalies.push({ date: r.start_time, opponent: isHome ? r.a : r.h, score: `${gf}-${ga}`, diff, xg: r.xg, note: Math.abs(diff)>=3 ? 'Blowout' : 'Clear result' });
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ teamId, anomalies, count: anomalies.length, avgGoalDiff: Math.round(result.rows.reduce((s:number,r:any)=>s+((r.home_team_id===teamId?r.home_score:r.away_score)-(r.home_team_id===teamId?r.away_score:r.home_score)),0)/result.rows.length*100)/100 }) }] };
  }

  private send(r: any) { process.stdout.write(JSON.stringify(r)+'\n'); }
  private sendErr(id: string|number, code: number, msg: string) { this.send({ jsonrpc:'2.0', id, error:{code,message:msg} }); }
}

new PatternFinderServer().start().catch(e => { log.error('Fatal',e); process.exit(1); });
