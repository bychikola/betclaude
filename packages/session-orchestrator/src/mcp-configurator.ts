import type { McpServerConfig } from '@betclaude/shared';
import { createLogger } from '@betclaude/shared';

const log = createLogger('mcp-cfg');

// ============================================================
// MCP Configurator
// ============================================================

// Base paths for MCP servers (relative to packages/mcp-servers/)
const MCP_SERVERS_BASE = '../mcp-servers';

interface UserMcpProfile {
  userId: string;
  role: string;
  subscription: string;
  preferredSports: string[];
}

/**
 * Generates the set of MCP servers to attach to a Claude CLI process
 * based on user profile, subscription tier, and session context.
 */
export class McpConfigurator {
  /**
   * Build MCP config for a new session.
   */
  buildConfig(profile: UserMcpProfile, context?: { sport?: string; matchId?: string }): McpServerConfig[] {
    const servers: McpServerConfig[] = [];

    // === CORE (always enabled) ===
    servers.push(this.sessionMemory(profile.userId));
    servers.push(this.userProfile(profile.userId));
    servers.push(this.fileSystem(profile.userId));

    // === DATA (tier-dependent) ===
    servers.push(this.liveScores(profile));

    if (profile.subscription !== 'free') {
      servers.push(this.oddsProvider(profile));
    }

    if (profile.subscription === 'pro') {
      servers.push(this.statsProvider(profile));
    }

    if (context?.sport) {
      servers.push(this.newsProvider(profile, context.sport));
    }

    // === ANALYSIS (premium+) ===
    if (profile.subscription !== 'free') {
      servers.push(this.historicalDb(profile));
    }

    if (profile.subscription === 'pro') {
      servers.push(this.predictor(profile));
      servers.push(this.chartBuilder(profile));
    }

    return servers;
  }

  /**
   * Generate a minimal config for quick queries (no live data needed).
   */
  buildMinimalConfig(userId: string): McpServerConfig[] {
    return [this.sessionMemory(userId), this.userProfile(userId)];
  }

  // ============================================================
  // Individual server configs
  // ============================================================

  private sessionMemory(userId: string): McpServerConfig {
    return {
      name: 'session-memory',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/session-memory/dist/index.js`],
      env: { USER_ID: userId },
      enabled: true,
    };
  }

  private userProfile(userId: string): McpServerConfig {
    return {
      name: 'user-profile',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/session-memory/dist/index.js`],
      env: { USER_ID: userId, MODE: 'profile' },
      enabled: true,
    };
  }

  private fileSystem(userId: string): McpServerConfig {
    return {
      name: 'filesystem',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/session-memory/dist/index.js`],
      env: { USER_ID: userId, MODE: 'filesystem' },
      enabled: true,
    };
  }

  private liveScores(profile: UserMcpProfile): McpServerConfig {
    return {
      name: 'live-scores',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/live-scores/dist/index.js`],
      env: {
        USER_ID: profile.userId,
        API_FOOTBALL_KEY: process.env.API_FOOTBALL_KEY || '',
        SPORTRADAR_KEY: process.env.SPORTRADAR_KEY || '',
      },
      enabled: true,
    };
  }

  private oddsProvider(profile: UserMcpProfile): McpServerConfig {
    return {
      name: 'odds-provider',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/odds-provider/dist/index.js`],
      env: {
        USER_ID: profile.userId,
        PINNACLE_API_KEY: process.env.PINNACLE_API_KEY || '',
      },
      enabled: true,
    };
  }

  private statsProvider(profile: UserMcpProfile): McpServerConfig {
    return {
      name: 'stats-provider',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/stats-provider/dist/index.js`],
      env: {
        USER_ID: profile.userId,
        SPORTRADAR_KEY: process.env.SPORTRADAR_KEY || '',
      },
      enabled: true,
    };
  }

  private newsProvider(profile: UserMcpProfile, sport: string): McpServerConfig {
    return {
      name: 'news-provider',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/news-provider/dist/index.js`],
      env: {
        USER_ID: profile.userId,
        SPORT: sport,
      },
      enabled: true,
    };
  }

  private historicalDb(profile: UserMcpProfile): McpServerConfig {
    return {
      name: 'historical-db',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/historical-db/dist/index.js`],
      env: { USER_ID: profile.userId },
      enabled: true,
    };
  }

  private predictor(profile: UserMcpProfile): McpServerConfig {
    return {
      name: 'predictor',
      command: 'python',
      args: [`${MCP_SERVERS_BASE}/predictor/main.py`],
      env: { USER_ID: profile.userId },
      enabled: true,
    };
  }

  private chartBuilder(profile: UserMcpProfile): McpServerConfig {
    return {
      name: 'chart-builder',
      command: 'node',
      args: [`${MCP_SERVERS_BASE}/chart-builder/dist/index.js`],
      env: { USER_ID: profile.userId },
      enabled: true,
    };
  }
}
