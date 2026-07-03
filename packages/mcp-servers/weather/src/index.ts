/**
 * Weather MCP Server — provides weather conditions for match venues.
 * Weather impacts: passing game (wind), injury risk (rain/heat), fatigue (temperature).
 */

import { createClient } from 'redis';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp:weather');

const TOOLS = [
  {
    name: 'get_match_weather',
    description: 'Get weather conditions for a match venue at kickoff time',
    inputSchema: {
      type: 'object', properties: {
        matchId: { type: 'string' },
        venue: { type: 'string', description: 'Stadium/city name (if matchId not available)' },
      },
      required: [],
    },
  },
  {
    name: 'assess_weather_impact',
    description: 'Analyze how weather conditions might affect the match outcome and player performance',
    inputSchema: {
      type: 'object', properties: {
        temperature: { type: 'number' }, windSpeed: { type: 'number' },
        condition: { type: 'string', enum: ['clear','rain','snow','cloudy','storm','fog'] },
        humidity: { type: 'number' },
      },
      required: ['temperature', 'condition'],
    },
  },
];

class WeatherServer {
  private redis: ReturnType<typeof createClient>;
  private apiKey: string;

  constructor() {
    this.redis = createClient({ socket: { host: process.env.REDIS_HOST||'localhost', port: parseInt(process.env.REDIS_PORT||'6379') } });
    this.apiKey = process.env.OPENWEATHER_API_KEY || '';
  }

  async start() {
    await this.redis.connect().catch(() => {});
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()||''; for (const line of lines) { if(line.trim()) { try{this.handleRequest(JSON.parse(line))}catch{} } } });
    process.stdin.on('end', () => { this.redis.quit(); process.exit(0); });
    log.info('Weather MCP started');
  }

  private async handleRequest(req: any) {
    try {
      let r: unknown;
      switch(req.method) {
        case 'initialize': r = { protocolVersion:'0.2.0', serverInfo:{name:'weather',version:'0.3.0'}, capabilities:{tools:{}} }; break;
        case 'tools/list': r = { tools: TOOLS }; break;
        case 'tools/call': r = await this.callTool(req.params?.name, req.params?.arguments||{}); break;
        case 'resources/list': r = { resources:[] }; break;
        case 'notifications/initialized': return;
        default: this.sendErr(req.id,-32601,req.method); return;
      }
      this.sendRes({ jsonrpc:'2.0', id:req.id, result:r });
    } catch(e:any) { this.sendErr(req.id,-32603,e.message); }
  }

  private async callTool(name: string, args: any): Promise<any> {
    switch(name) {
      case 'get_match_weather': return this.getWeather(args);
      case 'assess_weather_impact': return this.assessImpact(args);
      default: throw new Error(`Unknown: ${name}`);
    }
  }

  private async getWeather(args: any): Promise<any> {
    const { matchId, venue } = args;
    const searchPlace = venue || 'London'; // Default fallback — in production, look up venue from matchId

    // Try cache
    const cached = await this.redis.get(`weather:${searchPlace}`);
    if (cached) return { content: [{ type: 'text', text: cached }] };

    if (this.apiKey) {
      try {
        const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(searchPlace)}&appid=${this.apiKey}&units=metric`);
        if (res.ok) {
          const data = await res.json();
          const weather = {
            venue: searchPlace,
            temperature: data.main?.temp,
            feelsLike: data.main?.feels_like,
            humidity: data.main?.humidity,
            windSpeed: data.main?.wind?.speed || data.wind?.speed,
            condition: data.weather?.[0]?.main?.toLowerCase(),
            description: data.weather?.[0]?.description,
            pressure: data.main?.pressure,
          };
          const text = JSON.stringify(weather);
          await this.redis.setEx(`weather:${searchPlace}`, 600, text); // 10 min cache
          return { content: [{ type: 'text', text }] };
        }
      } catch {}
    }

    // Mock fallback
    const mock = { venue: searchPlace, temperature: 18, feelsLike: 16, humidity: 65, windSpeed: 12, condition: 'clear', description: 'Clear sky', note: 'Mock data — set OPENWEATHER_API_KEY for real weather' };
    return { content: [{ type: 'text', text: JSON.stringify(mock) }] };
  }

  private async assessImpact(args: any): Promise<any> {
    const { temperature, windSpeed = 10, condition = 'clear', humidity = 60 } = args;
    const impacts: string[] = [];

    if (temperature > 30) impacts.push('High temperature (>30°C): Increased fatigue risk, more hydration breaks, slower tempo expected');
    else if (temperature < 5) impacts.push('Cold temperature (<5°C): Higher injury risk, harder ball control, reduced passing accuracy');
    else impacts.push('Moderate temperature: No significant weather impact on player performance');

    if (windSpeed > 30) impacts.push('Strong wind (>30 km/h): Affects long passes, crosses, and goalkeeper distribution');
    else if (windSpeed > 15) impacts.push('Moderate wind: Slight effect on aerial balls and long passes');

    if (condition === 'rain') { impacts.push('Rain: Slippery pitch, faster ball movement, more unpredictable bounces, advantage for defensive teams'); }
    else if (condition === 'snow') { impacts.push('Snow: Severely reduced visibility and ball control, low-scoring game likely'); }
    else if (condition === 'fog') { impacts.push('Fog: Reduced visibility, affects long-range passing and shooting'); }

    if (humidity > 80) impacts.push('High humidity: Increased player fatigue, more substitutions likely');

    const riskLevel = impacts.filter(i => i.includes('High') || i.includes('Strong') || i.includes('Severe')).length >= 2
      ? 'HIGH' : impacts.some(i => i.includes('Moderate') || i.includes('Slight')) ? 'MODERATE' : 'LOW';

    return { content: [{ type: 'text', text: JSON.stringify({ conditions: { temperature, windSpeed, condition, humidity }, impacts, riskLevel, summary: impacts.length === 1 ? 'Minimal weather impact expected' : `${impacts.length} factors identified — ${riskLevel} risk level` }) }] };
  }

  private sendRes(r: any) { process.stdout.write(JSON.stringify(r)+'\n'); }
  private sendErr(id: string|number, code: number, msg: string) { this.sendRes({ jsonrpc:'2.0', id, error:{code,message:msg} }); }
}

new WeatherServer().start().catch(e => { log.error('Fatal',e); process.exit(1); });
