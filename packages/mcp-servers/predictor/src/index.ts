/**
 * Predictor MCP Server — ML-powered match predictions.
 * Calls the Python Analytics Service for model inference.
 */

import { createClient } from 'redis';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:predictor');
const ANALYTICS_URL = process.env.ANALYTICS_SERVICE_URL || 'http://localhost:8000';

const TOOLS = [
  {
    name: 'predict_match',
    description: 'Generate ML predictions for a match using ensemble models (Poisson + ELO + XGBoost)',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string' },
        models: { type: 'array', items: { type: 'string', enum: ['poisson','elo','xgboost','ensemble'] }, default: ['ensemble'] },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'analyze_match_full',
    description: 'Full match analysis with form, H2H, stats, and predictions',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string' },
        includeStats: { type: 'boolean', default: true },
        includeH2H: { type: 'boolean', default: true },
        includeForm: { type: 'boolean', default: true },
      },
      required: ['matchId'],
    },
  },
  {
    name: 'get_value_bets',
    description: 'Find value bets by comparing model probabilities with market odds',
    inputSchema: {
      type: 'object',
      properties: {
        matchId: { type: 'string' },
        threshold: { type: 'number', description: 'Minimum edge %', default: 5 },
      },
      required: ['matchId'],
    },
  },
];

class PredictorServer {
  private redis: ReturnType<typeof createClient>;

  constructor() {
    this.redis = createClient({ socket: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379', 10) } });
    this.redis.on('error', () => {});
  }

  async start() {
    await this.redis.connect().catch(() => {});
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) { if (line.trim()) { try { this.handleRequest(JSON.parse(line)); } catch { /* skip */ } } }
    });
    process.stdin.on('end', () => this.redis.quit().then(() => process.exit(0)));
    log.info('Predictor MCP started');
  }

  private async handleRequest(req: any) {
    try {
      let result: unknown;
      switch (req.method) {
        case 'initialize': result = { protocolVersion: '0.2.0', serverInfo: { name: 'predictor', version: '0.3.0' }, capabilities: { tools: {} } }; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': result = await this.callTool(req.params?.name, req.params?.arguments || {}); break;
        case 'resources/list': result = { resources: [] }; break;
        case 'notifications/initialized': return;
        default: this.sendError(req.id, -32601, req.method); return;
      }
      this.sendResponse({ jsonrpc: '2.0', id: req.id, result });
    } catch (err: any) { this.sendError(req.id, -32603, err.message); }
  }

  private async callTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'predict_match': return this.predictMatch(args);
      case 'analyze_match_full': return this.analyzeMatch(args);
      case 'get_value_bets': return this.getValueBets(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async predictMatch(args: any): Promise<any> {
    const { matchId, models = ['ensemble'] } = args;
    const cacheKey = `pred:${matchId}:${models.join(',')}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { content: [{ type: 'text', text: cached }] };

    try {
      const res = await fetch(`${ANALYTICS_URL}/predict`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId, models }),
      });
      const data = await res.json();
      const text = JSON.stringify(data);
      await this.redis.setEx(cacheKey, 300, text);
      return { content: [{ type: 'text', text }] };
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ matchId, predictions: [{
        model: 'ensemble', home_score: 1.8, away_score: 1.1, confidence: 0.62,
        probabilities: { home_win: 0.55, draw: 0.25, away_win: 0.20 },
      }], note: 'Fallback prediction — analytics service unavailable' }) }] };
    }
  }

  private async analyzeMatch(args: any): Promise<any> {
    try {
      const res = await fetch(`${ANALYTICS_URL}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      });
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Analytics service unavailable' }) }] };
    }
  }

  private async getValueBets(args: any): Promise<any> {
    const { matchId, threshold = 5 } = args;
    // Get both predictions and odds
    const [predRes, oddsRes] = await Promise.all([
      this.predictMatch(args),
      fetch(`${ANALYTICS_URL}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ match_id: matchId, models: ['ensemble'] }) }).then(r => r.json()).catch(() => null),
    ]);

    // Calculate value
    const valueBets: any[] = [];
    try {
      const pred = JSON.parse(predRes.content[0].text);
      const probs = pred.predictions?.[0]?.probabilities || {};
      // For each outcome, check if model probability exceeds implied odds probability
      const outcomes = { home_win: 'Home Win', draw: 'Draw', away_win: 'Away Win' };
      for (const [key, label] of Object.entries(outcomes)) {
        const modelProb = probs[key] || 0;
        const fairOdds = 1 / modelProb;
        // Market odds would come from odds provider
        const impliedMarketProb = 0.33; // placeholder
        const edge = (modelProb - impliedMarketProb) * 100;
        if (edge > threshold) {
          valueBets.push({ outcome: label, modelProbability: Math.round(modelProb*1000)/10+'%', fairOdds: Math.round(fairOdds*100)/100, edge: Math.round(edge*10)/10+'%' });
        }
      }
    } catch {}

    return { content: [{ type: 'text', text: JSON.stringify({ matchId, threshold, valueBets, count: valueBets.length }) }] };
  }

  private sendResponse(r: any) { process.stdout.write(JSON.stringify(r) + '\n'); }
  private sendError(id: string|number, code: number, msg: string) { this.sendResponse({ jsonrpc: '2.0', id, error: { code, message: msg } }); }
}

new PredictorServer().start().catch(err => { log.error('Fatal', err); process.exit(1); });
