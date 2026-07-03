/**
 * Chart Builder MCP Server — generates visualizations and charts.
 * Produces ASCII charts for terminal, chart descriptions for rendering,
 * and data structures for frontend chart libraries (Chart.js, Recharts).
 */

import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:chart-builder');

const TOOLS = [
  {
    name: 'build_form_chart',
    description: 'Generate a form trend chart for a team (W/D/L over last N matches)',
    inputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', items: { type: 'object', properties: { result: { type: 'string' }, opponent: { type: 'string' }, date: { type: 'string' } } } },
        title: { type: 'string' },
      },
      required: ['results'],
    },
  },
  {
    name: 'build_odds_chart',
    description: 'Generate an odds movement visualization',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { type: 'object', properties: { timestamp: { type: 'string' }, home: { type: 'number' }, draw: { type: 'number' }, away: { type: 'number' } } } },
      },
      required: ['data'],
    },
  },
  {
    name: 'build_comparison_chart',
    description: 'Generate a side-by-side team comparison chart',
    inputSchema: {
      type: 'object',
      properties: {
        team1: { type: 'object', properties: { name: { type: 'string' }, stats: { type: 'object' } } },
        team2: { type: 'object', properties: { name: { type: 'string' }, stats: { type: 'object' } } },
        metrics: { type: 'array', items: { type: 'string' } },
      },
      required: ['team1', 'team2'],
    },
  },
  {
    name: 'build_score_timeline',
    description: 'Generate a match score timeline/progression chart',
    inputSchema: {
      type: 'object',
      properties: {
        events: { type: 'array', items: { type: 'object', properties: { minute: { type: 'number' }, type: { type: 'string' }, team: { type: 'string' }, detail: { type: 'string' } } } },
        homeTeam: { type: 'string' },
        awayTeam: { type: 'string' },
      },
      required: ['events', 'homeTeam', 'awayTeam'],
    },
  },
];

class ChartBuilderServer {
  async start() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) { if (line.trim()) { try { this.handleRequest(JSON.parse(line)); } catch { /* skip */ } } }
    });
    process.stdin.on('end', () => process.exit(0));
    log.info('Chart Builder MCP started');
  }

  private async handleRequest(req: any) {
    try {
      let result: unknown;
      switch (req.method) {
        case 'initialize': result = { protocolVersion: '0.2.0', serverInfo: { name: 'chart-builder', version: '0.3.0' }, capabilities: { tools: {} } }; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': result = await this.callTool(req.params?.name, req.params?.arguments || {}); break;
        case 'resources/list': result = { resources: [] }; break;
        case 'notifications/initialized': return;
        default: this.sendErr(req.id, -32601, req.method); return;
      }
      this.sendRes({ jsonrpc: '2.0', id: req.id, result });
    } catch (err: any) { this.sendErr(req.id, -32603, err.message); }
  }

  private async callTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'build_form_chart': return this.formChart(args);
      case 'build_odds_chart': return this.oddsChart(args);
      case 'build_comparison_chart': return this.comparisonChart(args);
      case 'build_score_timeline': return this.scoreTimeline(args);
      default: throw new Error(`Unknown: ${name}`);
    }
  }

  private formChart(args: any): any {
    const { results, title = 'Form Guide' } = args;
    if (!results || results.length === 0) return { content: [{ type: 'text', text: 'No data' }] };

    // ASCII form bar
    const ascii = results.slice(0, 10).map((r: any) => {
      const c = r.result === 'W' ? '🟢' : r.result === 'D' ? '🟡' : '🔴';
      return `${c} ${r.opponent?.slice(0, 12) || '—'}`;
    }).join('\n');

    // Data for frontend chart
    const chartData = {
      type: 'form',
      title,
      ascii,
      data: {
        labels: results.slice(0, 10).map((r: any) => r.opponent?.slice(0, 8) || r.date?.slice(0, 10) || '?'),
        datasets: [{
          label: 'Result',
          data: results.slice(0, 10).map((r: any) => r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0),
          backgroundColor: results.slice(0, 10).map((r: any) => r.result === 'W' ? '#22c55e' : r.result === 'D' ? '#eab308' : '#ef4444'),
        }],
      },
      summary: `${results.filter((r: any) => r.result === 'W').length}W ${results.filter((r: any) => r.result === 'D').length}D ${results.filter((r: any) => r.result === 'L').length}L`,
    };

    return { content: [{ type: 'text', text: JSON.stringify(chartData) }] };
  }

  private oddsChart(args: any): any {
    const { data } = args;
    if (!data || data.length === 0) return { content: [{ type: 'text', text: 'No data' }] };

    const ascii = data.slice(-20).map((d: any) => {
      const barLen = Math.round((d.home || 2) * 5);
      return `H ${'█'.repeat(Math.min(barLen, 30))} ${d.home?.toFixed(2)} | A ${d.away?.toFixed(2)}`;
    }).join('\n');

    return { content: [{ type: 'text', text: JSON.stringify({ type: 'odds_movement', dataPoints: data.length, ascii, chartData: { labels: data.map((d: any) => d.timestamp?.slice(11, 16) || ''), datasets: [{ label: 'Home', data: data.map((d: any) => d.home) }, { label: 'Away', data: data.map((d: any) => d.away) }] }, movement: { homeFirst: data[0]?.home, homeLast: data[data.length - 1]?.home, awayFirst: data[0]?.away, awayLast: data[data.length - 1]?.away } }) }] };
  }

  private comparisonChart(args: any): any {
    const { team1, team2, metrics } = args;
    const m = metrics || Object.keys(team1?.stats || {});
    const rows = m.map((metric: string) => {
      const v1 = team1?.stats?.[metric] || 0;
      const v2 = team2?.stats?.[metric] || 0;
      const max = Math.max(v1, v2, 1);
      const bar1 = '█'.repeat(Math.round(v1 / max * 15));
      const bar2 = '█'.repeat(Math.round(v2 / max * 15));
      return `${metric.padEnd(18)} ${team1?.name?.slice(0, 10).padEnd(10)} ${bar1.padEnd(16)} ${v1}\n${''.padEnd(18)} ${team2?.name?.slice(0, 10).padEnd(10)} ${bar2.padEnd(16)} ${v2}`;
    }).join('\n\n');

    return { content: [{ type: 'text', text: JSON.stringify({ type: 'comparison', team1: team1?.name, team2: team2?.name, ascii: rows, chartData: { labels: m, datasets: [{ label: team1?.name, data: m.map((k: string) => team1?.stats?.[k] || 0) }, { label: team2?.name, data: m.map((k: string) => team2?.stats?.[k] || 0) }] } }) }] };
  }

  private scoreTimeline(args: any): any {
    const { events, homeTeam, awayTeam } = args;
    if (!events || events.length === 0) return { content: [{ type: 'text', text: JSON.stringify({ timeline: [], note: 'No events' }) }] };

    const timeline = events.map((e: any) => ({
      minute: e.minute,
      icon: e.type === 'goal' ? '⚽' : e.type === 'yellow_card' ? '🟨' : e.type === 'red_card' ? '🟥' : '🔄',
      description: `${e.minute}' — ${e.detail || e.type} (${e.team || ''})`,
    }));

    const ascii = `Timeline: ${homeTeam} vs ${awayTeam}\n` + timeline.map((t: any) => `${t.icon} ${t.description}`).join('\n');

    return { content: [{ type: 'text', text: JSON.stringify({ type: 'timeline', homeTeam, awayTeam, ascii, timeline }) }] };
  }

  private sendRes(r: any) { process.stdout.write(JSON.stringify(r) + '\n'); }
  private sendErr(id: string | number, code: number, msg: string) { this.sendRes({ jsonrpc: '2.0', id, error: { code, message: msg } }); }
}

new ChartBuilderServer().start().catch(e => { log.error('Fatal', e); process.exit(1); });
