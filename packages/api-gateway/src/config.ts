import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root
config({ path: resolve(__dirname, '../../../.env') });

export const env = {
  // Server
  HOST: process.env.API_HOST || '0.0.0.0',
  PORT: parseInt(process.env.API_PORT || '3000', 10),

  // Database
  DB: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'betclaude',
    user: process.env.DB_USER || 'betclaude',
    password: process.env.DB_PASSWORD || 'betclaude_dev',
  },

  // Redis
  REDIS: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  // JWT
  JWT: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpiresIn: '15m',
    refreshExpiresIn: '7d',
  },

  // Claude CLI
  CLAUDE: {
    cliPath: process.env.CLAUDE_CLI_PATH || 'claude',
    maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '200000', 10),
  },

  // External APIs
  APIS: {
    apiFootballKey: process.env.API_FOOTBALL_KEY || '',
    sportradarKey: process.env.SPORTRADAR_KEY || '',
  },

  // Analytics
  ANALYTICS_SERVICE_URL: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:8000',

  // Env
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production',
} as const;
