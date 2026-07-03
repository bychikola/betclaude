// ============================================================
// Core domain types for betclaude platform
// ============================================================

// --- User & Auth ---

export type UserRole = 'bettor' | 'fan' | 'analyst' | 'admin';

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  subscription: SubscriptionTier;
  createdAt: Date;
  updatedAt: Date;
}

export type SubscriptionTier = 'free' | 'premium' | 'pro';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// --- Session & Messaging ---

export interface Session {
  id: string;
  userId: string;
  title: string;
  sport?: string;
  status: 'active' | 'idle' | 'closed';
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  userId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  output?: unknown;
}

// WebSocket message types

export type WsClientMessage =
  | { type: 'message'; sessionId?: string; content: string }
  | { type: 'reconnect'; sessionId: string }
  | { type: 'cancel'; sessionId: string };

export type WsServerMessage =
  | { type: 'chunk'; sessionId: string; content: string }
  | { type: 'tool_use'; sessionId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_result'; sessionId: string; tool: string; output: unknown }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; sessionId: string; message: string; code?: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'heartbeat'; timestamp: number };

// --- Sports ---

export interface Sport {
  id: string;
  name: string;
  slug: string;
  active: boolean;
}

export interface League {
  id: string;
  sportId: string;
  name: string;
  country: string;
  tier: number;
}

export interface Team {
  id: string;
  leagueId: string;
  name: string;
  shortName?: string;
  logoUrl?: string;
}

export interface Player {
  id: string;
  teamId: string;
  name: string;
  position?: string;
  number?: number;
  nationality?: string;
}

// --- Matches ---

export type MatchStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled';

export interface Match {
  id: string;
  sportId: string;
  leagueId: string;
  homeTeamId: string;
  awayTeamId: string;
  startTime: Date;
  status: MatchStatus;
  homeScore?: number;
  awayScore?: number;
  minute?: number;
  venue?: string;
  referee?: string;
}

export interface MatchEvent {
  id: string;
  matchId: string;
  type: 'goal' | 'yellow_card' | 'red_card' | 'substitution' | 'var' | 'penalty' | 'other';
  minute: number;
  teamId: string;
  playerId?: string;
  playerName?: string;
  detail?: string;
  createdAt: Date;
}

export interface MatchStats {
  matchId: string;
  teamId: string;
  possession: number;
  shots: number;
  shotsOnTarget: number;
  corners: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  offsides: number;
  expectedGoals: number;
  passAccuracy: number;
  updatedAt: Date;
}

// --- Odds ---

export interface Odds {
  id: string;
  matchId: string;
  provider: string;
  market: string;
  home: number;
  draw?: number;
  away: number;
  timestamp: Date;
}

// --- Predictions ---

export interface Prediction {
  id: string;
  matchId: string;
  model: string;
  predictedHomeScore: number;
  predictedAwayScore: number;
  confidence: number;
  features: Record<string, number>;
  createdAt: Date;
}

// --- MCP Config ---

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface SessionMcpConfig {
  sessionId: string;
  userId: string;
  servers: McpServerConfig[];
}

// --- Process Pool ---

export type ClaudeProcessState =
  | 'starting'
  | 'ready'
  | 'busy'
  | 'idle'
  | 'draining'
  | 'dead';

export interface ClaudeProcessInfo {
  id: string;
  userId: string;
  sessionId: string;
  state: ClaudeProcessState;
  pid?: number;
  createdAt: Date;
  lastActivityAt: Date;
  messageCount: number;
  tokenBudget: number;
}

// --- Analytics ---

export interface AnalysisTask {
  id: string;
  type: 'aggregate_match' | 'predict' | 'generate_report';
  payload: Record<string, unknown>;
  priority: number;
  createdAt: Date;
}
