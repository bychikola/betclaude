// ============================================================
// Shared constants
// ============================================================

// Process Pool
export const POOL_DEFAULTS = {
  MAX_PROCESSES_PER_USER: 3,
  MAX_TOTAL_PROCESSES: 50,
  IDLE_TIMEOUT_MS: 5 * 60 * 1000,        // 5 minutes
  MAX_SESSION_DURATION_MS: 2 * 60 * 60 * 1000, // 2 hours
  GRACEFUL_SHUTDOWN_MS: 30 * 1000,        // 30 seconds
  HEALTH_CHECK_INTERVAL_MS: 30 * 1000,    // 30 seconds
  TOKEN_BUDGET_DEFAULT: 200_000,
  PROCESS_MEMORY_MB: 500,
} as const;

// Rate Limiting
export const RATE_LIMITS = {
  FREE: 20,       // requests per minute
  PREMIUM: 60,
  PRO: 120,
} as const;

// Auth
export const AUTH = {
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '7d',
  BCRYPT_ROUNDS: 12,
} as const;

// WebSocket
export const WS = {
  HEARTBEAT_INTERVAL_MS: 30_000,
  RECONNECT_GRACE_PERIOD_MS: 10_000,
} as const;

// Redis keys
export const REDIS_KEYS = {
  SESSION_CONTEXT: (sessionId: string) => `session:${sessionId}:context`,
  LIVE_SCORE: (matchId: string) => `live:match:${matchId}:score`,
  LIVE_ODDS: (matchId: string) => `live:match:${matchId}:odds`,
  TEAM_STATS: (teamId: string) => `cache:team:${teamId}:stats`,
  H2H: (team1Id: string, team2Id: string) => `cache:h2h:${team1Id}:${team2Id}`,
  RATE_LIMIT: (userId: string) => `user:${userId}:rate_limit`,
  ANALYSIS_QUEUE: 'queue:analysis:tasks',
  PROCESS_REGISTRY: 'registry:processes',
} as const;

// Supported sports
export const SPORTS = [
  { slug: 'football', name: 'Футбол' },
  { slug: 'basketball', name: 'Баскетбол' },
  { slug: 'tennis', name: 'Теннис' },
  { slug: 'hockey', name: 'Хоккей' },
  { slug: 'mma', name: 'MMA' },
  { slug: 'boxing', name: 'Бокс' },
] as const;
