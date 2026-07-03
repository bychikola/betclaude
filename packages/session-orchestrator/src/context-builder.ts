import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { createLogger, REDIS_KEYS } from '@betclaude/shared';

const log = createLogger('ctx-builder');

// ============================================================
// Context Builder
// ============================================================

/**
 * Builds context for a Claude CLI session.
 * Gathers: user profile, sports preferences, match data, session history.
 */
export class ContextBuilder {
  constructor(
    private db: Pool,
    private redis: RedisClientType
  ) {}

  /**
   * Build full context for a new session.
   */
  async buildSessionContext(userId: string, sessionId: string): Promise<SessionContext> {
    const [userProfile, sportsPreferences, recentSessions] = await Promise.all([
      this.fetchUserProfile(userId),
      this.fetchSportsPreferences(userId),
      this.fetchRecentSessions(userId, 5),
    ]);

    const context: SessionContext = {
      sessionId,
      userId,
      userProfile,
      sportsPreferences,
      recentSessions,
      systemPrompt: this.buildSystemPrompt(userProfile),
      currentTime: new Date().toISOString(),
    };

    // Cache context in Redis for fast recovery
    await this.redis.setEx(
      REDIS_KEYS.SESSION_CONTEXT(sessionId),
      300, // 5 min TTL
      JSON.stringify(context)
    );

    return context;
  }

  /**
   * Build context enriched with match-specific data.
   */
  async buildMatchContext(
    baseContext: SessionContext,
    matchId: string
  ): Promise<MatchEnrichedContext> {
    const [match, h2h, odds, stats, events] = await Promise.all([
      this.fetchMatch(matchId),
      this.fetchH2H(matchId),
      this.fetchCurrentOdds(matchId),
      this.fetchMatchStats(matchId),
      this.fetchMatchEvents(matchId, 10),
    ]);

    return {
      ...baseContext,
      match,
      h2h,
      odds,
      stats,
      recentEvents: events,
      analysisPrompt: this.buildMatchAnalysisPrompt(match),
    };
  }

  /**
   * Restore context from Redis cache (for process recovery).
   */
  async restoreContext(sessionId: string): Promise<SessionContext | null> {
    try {
      const cached = await this.redis.get(REDIS_KEYS.SESSION_CONTEXT(sessionId));
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      log.warn(`Failed to restore context for session ${sessionId}`);
    }
    return null;
  }

  /**
   * Fetch chat history to prepend to Claude's stdin.
   */
  async fetchChatHistory(sessionId: string, limit = 50): Promise<ChatHistoryEntry[]> {
    const result = await this.db.query(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [sessionId, limit]
    );

    // Return chronological order (oldest first)
    return result.rows.reverse().map((r) => ({
      role: r.role as 'user' | 'assistant' | 'system',
      content: r.content,
      timestamp: r.created_at,
    }));
  }

  // ============================================================
  // Private fetchers
  // ============================================================

  private async fetchUserProfile(userId: string): Promise<UserProfile> {
    const result = await this.db.query(
      `SELECT id, email, username, role, subscription
       FROM users WHERE id = $1`,
      [userId]
    );

    const user = result.rows[0];
    return {
      id: user?.id || userId,
      username: user?.username || 'unknown',
      role: user?.role || 'bettor',
      subscription: user?.subscription || 'free',
    };
  }

  private async fetchSportsPreferences(userId: string): Promise<string[]> {
    // Get sports the user has most sessions about
    const result = await this.db.query(
      `SELECT sport, COUNT(*) as cnt
       FROM sessions
       WHERE user_id = $1 AND sport IS NOT NULL
       GROUP BY sport
       ORDER BY cnt DESC
       LIMIT 5`,
      [userId]
    );
    return result.rows.map((r) => r.sport);
  }

  private async fetchRecentSessions(userId: string, limit: number) {
    const result = await this.db.query(
      `SELECT id, title, sport, message_count, created_at
       FROM sessions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows;
  }

  private async fetchMatch(matchId: string) {
    const result = await this.db.query(
      `SELECT m.*,
         ht.name AS home_team, ht.short_name AS home_short,
         at.name AS away_team, at.short_name AS away_short,
         l.name AS league_name, s.name AS sport_name, s.slug AS sport_slug
       FROM matches m
       JOIN teams ht ON m.home_team_id = ht.id
       JOIN teams at ON m.away_team_id = at.id
       JOIN leagues l ON m.league_id = l.id
       JOIN sports s ON m.sport_id = s.id
       WHERE m.id = $1`,
      [matchId]
    );
    return result.rows[0] || null;
  }

  private async fetchH2H(matchId: string) {
    const match = await this.fetchMatch(matchId);
    if (!match) return [];

    const result = await this.db.query(
      `SELECT m.id, m.start_time, m.status, m.home_score, m.away_score,
         ht.name AS home_team, at.name AS away_team
       FROM matches m
       JOIN teams ht ON m.home_team_id = ht.id
       JOIN teams at ON m.away_team_id = at.id
       WHERE (
         (m.home_team_id = $1 AND m.away_team_id = $2) OR
         (m.home_team_id = $2 AND m.away_team_id = $1)
       )
       AND m.id != $3 AND m.status = 'finished'
       ORDER BY m.start_time DESC
       LIMIT 10`,
      [match.home_team_id, match.away_team_id, matchId]
    );
    return result.rows;
  }

  private async fetchCurrentOdds(matchId: string) {
    const result = await this.db.query(
      `SELECT provider, market, home_odds, draw_odds, away_odds, created_at
       FROM live_odds
       WHERE match_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [matchId]
    );
    return result.rows;
  }

  private async fetchMatchStats(matchId: string) {
    const result = await this.db.query(
      `SELECT ms.*, t.name AS team_name
       FROM match_stats ms
       JOIN teams t ON ms.team_id = t.id
       WHERE ms.match_id = $1
       ORDER BY ms.created_at DESC
       LIMIT 2`,
      [matchId]
    );
    return result.rows;
  }

  private async fetchMatchEvents(matchId: string, limit: number) {
    const result = await this.db.query(
      `SELECT type, minute, player_name, team_id, detail, created_at
       FROM match_events
       WHERE match_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [matchId, limit]
    );
    return result.rows.reverse();
  }

  private buildSystemPrompt(profile: UserProfile): string {
    const roleHint =
      profile.role === 'analyst'
        ? 'You are an expert sports analyst providing deep tactical analysis.'
        : profile.role === 'bettor'
          ? 'You are a sports betting analyst providing data-driven recommendations.'
          : 'You are a knowledgeable sports analyst providing insightful analysis.';

    return `${roleHint}

You have access to live sports data through MCP tools:
- Use "live-scores" tool for real-time match scores and events
- Use "odds-provider" tool for current betting odds
- Use "historical-db" tool for historical statistics and head-to-head records
- Use "session-memory" tool to reference previous conversations

Always provide specific data and numbers when available. Be concise and direct.
When discussing betting, always include a disclaimer about responsible gambling.
Respond in Russian unless the user writes in English.`;
  }

  private buildMatchAnalysisPrompt(match: any): string {
    if (!match) return '';

    return `Analyzing match: ${match.home_team} vs ${match.away_team}
League: ${match.league_name} (${match.sport_name})
Status: ${match.status}
${match.status === 'live' ? `Current score: ${match.home_score}-${match.away_score} (${match.minute}')` : ''}
${match.status === 'scheduled' ? `Kickoff: ${match.start_time}` : ''}

Focus on:
1. Current form of both teams
2. Head-to-head history
3. Key player matchups
4. Tactical analysis
5. ${match.status === 'live' ? 'In-play dynamics and momentum' : 'Match prediction with confidence level'}`;
  }
}

// ============================================================
// Types
// ============================================================

export interface UserProfile {
  id: string;
  username: string;
  role: string;
  subscription: string;
}

export interface SessionContext {
  sessionId: string;
  userId: string;
  userProfile: UserProfile;
  sportsPreferences: string[];
  recentSessions: any[];
  systemPrompt: string;
  currentTime: string;
}

export interface MatchEnrichedContext extends SessionContext {
  match: any;
  h2h: any[];
  odds: any[];
  stats: any[];
  recentEvents: any[];
  analysisPrompt: string;
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}
