import { createClient } from 'redis';
import { Pool } from 'pg';
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@betclaude/shared';

import { ProcessPoolManager } from './pool-manager.js';
import { ContextBuilder } from './context-builder.js';
import { McpConfigurator } from './mcp-configurator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const log = createLogger('orchestrator');

// ============================================================
// Configuration
// ============================================================

const config_env = {
  DB: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'betclaude',
    user: process.env.DB_USER || 'betclaude',
    password: process.env.DB_PASSWORD || 'betclaude_dev',
  },
  REDIS: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
};

// ============================================================
// Services
// ============================================================

const db = new Pool({
  host: config_env.DB.host,
  port: config_env.DB.port,
  database: config_env.DB.database,
  user: config_env.DB.user,
  password: config_env.DB.password,
  max: 10,
});

const redis = createClient({
  socket: {
    host: config_env.REDIS.host,
    port: config_env.REDIS.port,
  },
});

const poolManager = new ProcessPoolManager();
const contextBuilder = new ContextBuilder(db, redis);
const mcpConfigurator = new McpConfigurator();

// ============================================================
// Message handling
// ============================================================

interface OrchestratorMessage {
  userId: string;
  sessionId?: string;
  content?: string;
  replyTo?: string;
  sport?: string;
  matchId?: string;
}

async function handleNewMessage(msg: OrchestratorMessage) {
  const { userId, sessionId, content, replyTo } = msg;
  if (!content) return;

  log.info(`Handling message from user=${userId} session=${sessionId || 'new'}`);

  try {
    // Get user profile for MCP config
    const userResult = await db.query(
      'SELECT id, role, subscription FROM users WHERE id = $1',
      [userId]
    );

    const userProfile = userResult.rows[0] || {
      id: userId,
      role: 'bettor',
      subscription: 'free',
    };

    // Build MCP config
    const mcpConfig = mcpConfigurator.buildConfig({
      userId,
      role: userProfile.role,
      subscription: userProfile.subscription,
      preferredSports: [],
    });

    // Get or create process
    const { proc, isNew } = await poolManager.getOrCreate(userId, sessionId, mcpConfig);

    // Build context for new sessions
    if (isNew) {
      const ctx = await contextBuilder.buildSessionContext(userId, proc.sessionId);

      // Create session in DB
      await db.query(
        `INSERT INTO sessions (id, user_id, title, status)
         VALUES ($1, $2, $3, 'active')`,
        [
          proc.sessionId,
          userId,
          content.slice(0, 100).replace(/\n/g, ' '),
        ]
      );

      // Send context to process
      const contextInput = JSON.stringify({
        type: 'context',
        systemPrompt: ctx.systemPrompt,
        userProfile: ctx.userProfile,
        currentTime: ctx.currentTime,
        sportsPreferences: ctx.sportsPreferences,
      });

      poolManager.sendInput(proc.id, contextInput);

      // Notify client about new session
      if (replyTo) {
        await redis.publish(
          replyTo,
          JSON.stringify({
            type: 'session_created',
            sessionId: proc.sessionId,
          })
        );
      }
    }

    // Save user message to DB
    await db.query(
      `INSERT INTO chat_messages (session_id, user_id, role, content)
       VALUES ($1, $2, 'user', $3)`,
      [proc.sessionId, userId, content]
    );

    // Send user message to Claude CLI
    const messageInput = JSON.stringify({
      type: 'message',
      content,
    });

    const sent = poolManager.sendInput(proc.id, messageInput);
    if (!sent) {
      log.error(`Failed to send input to process ${proc.id}`);

      // Send error back to client
      if (replyTo) {
        await redis.publish(
          replyTo,
          JSON.stringify({
            type: 'error',
            sessionId: proc.sessionId,
            message: 'Failed to communicate with analysis engine',
            code: 'PROCESS_ERROR',
          })
        );
      }
    }

    // Subscribe to process output for this session
    subscribeToProcessOutput(proc.id, replyTo);
  } catch (err: any) {
    log.error(`Error handling message: ${err.message}`);

    if (replyTo) {
      await redis.publish(
        replyTo,
        JSON.stringify({
          type: 'error',
          sessionId: sessionId || '',
          message: err.message || 'Internal server error',
          code: 'ORCHESTRATOR_ERROR',
        })
      );
    }
  }
}

async function handleReconnect(msg: OrchestratorMessage) {
  const { userId, sessionId, replyTo } = msg;
  if (!sessionId) return;

  log.info(`Reconnect request: user=${userId} session=${sessionId}`);

  try {
    const { proc, isNew } = await poolManager.getOrCreate(userId, sessionId, []);

    if (!isNew) {
      // Restore context from Redis
      const ctx = await contextBuilder.restoreContext(sessionId);

      if (replyTo) {
        await redis.publish(
          replyTo,
          JSON.stringify({
            type: 'session_created',
            sessionId: proc.sessionId,
          })
        );
      }

      // Send chat history
      const history = await contextBuilder.fetchChatHistory(sessionId, 50);
      if (history.length > 0 && replyTo) {
        for (const entry of history) {
          await redis.publish(
            replyTo,
            JSON.stringify({
              type: 'chunk',
              sessionId: proc.sessionId,
              content: `[${entry.role}]: ${entry.content}\n`,
            })
          );
        }
      }
    }

    subscribeToProcessOutput(proc.id, replyTo);
  } catch (err: any) {
    log.error(`Reconnect error: ${err.message}`);
  }
}

async function handleCancel(msg: OrchestratorMessage) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const proc = poolManager.findBySession(sessionId);
  if (proc) {
    log.info(`Cancelling process ${proc.id}`);
    proc.process.kill('SIGINT'); // Send Ctrl+C equivalent
  }
}

// ============================================================
// Process output streaming
// ============================================================

function subscribeToProcessOutput(procId: string, replyTo?: string) {
  const proc = poolManager.getProcess(procId);
  if (!proc) return;

  const onStdout = (data: Buffer) => {
    const text = data.toString();
    if (replyTo) {
      redis.publish(
        replyTo,
        JSON.stringify({
          type: 'chunk',
          sessionId: proc.sessionId,
          content: text,
        })
      ).catch(() => {});
    }
  };

  const onStderr = (data: Buffer) => {
    const text = data.toString();
    log.warn(`Process ${procId} stderr: ${text.slice(0, 200)}`);

    if (replyTo && text.includes('Error')) {
      redis.publish(
        replyTo,
        JSON.stringify({
          type: 'error',
          sessionId: proc.sessionId,
          message: text,
          code: 'CLAUDE_ERROR',
        })
      ).catch(() => {});
    }
  };

  const onReady = () => {
    proc.process.stdout?.on('data', onStdout);
    proc.process.stderr?.on('data', onStderr);
  };

  const onExit = async (exitedProc: any, code: number | null, signal: string | null) => {
    // Save assistant messages from stdout buffer
    // (In a real implementation, we'd parse stream-json output here)

    // Mark as done
    if (replyTo) {
      await redis.publish(
        replyTo,
        JSON.stringify({
          type: 'done',
          sessionId: exitedProc.sessionId,
        })
      ).catch(() => {});
    }

    poolManager.markIdle(exitedProc.id);

    // If crashed, attempt recovery
    if (code !== 0 && code !== null) {
      log.warn(`Process ${exitedProc.id} exited with code ${code}`);
      // Recovery logic would go here
    }
  };

  // Attach listeners
  if (proc.state === 'ready' || proc.state === 'busy' || proc.state === 'idle') {
    onReady();
  } else {
    poolManager.once('process:ready', (p: any) => {
      if (p.id === procId) onReady();
    });
  }

  poolManager.once('process:exit', (p: any, code: any, signal: any) => {
    if (p.id === procId) onExit(p, code, signal);
  });
}

// ============================================================
// Redis pub/sub listener
// ============================================================

async function bootstrap() {
  // Connect Redis
  await redis.connect();
  log.info('Redis connected');

  // Subscribe to channels
  const subscriber = redis.duplicate();
  await subscriber.connect();

  await subscriber.subscribe('session:message', (raw) => {
    try {
      const msg: OrchestratorMessage = JSON.parse(raw);
      handleNewMessage(msg);
    } catch (err) {
      log.error('Failed to parse session:message', err);
    }
  });

  await subscriber.subscribe('session:reconnect', (raw) => {
    try {
      const msg: OrchestratorMessage = JSON.parse(raw);
      handleReconnect(msg);
    } catch (err) {
      log.error('Failed to parse session:reconnect', err);
    }
  });

  await subscriber.subscribe('session:cancel', (raw) => {
    try {
      const msg: OrchestratorMessage = JSON.parse(raw);
      handleCancel(msg);
    } catch (err) {
      log.error('Failed to parse session:cancel', err);
    }
  });

  // Also subscribe to disconnect events (from WS handler)
  await subscriber.subscribe('session:disconnect', (raw) => {
    try {
      const { sessionId, userId } = JSON.parse(raw);
      log.info(`User disconnected: user=${userId} session=${sessionId}`);
      // Process will be marked idle and eventually cleaned up by idle timer
    } catch (err) {
      log.error('Failed to parse session:disconnect', err);
    }
  });

  // Start process pool
  poolManager.start();

  // Periodic stats logging
  setInterval(() => {
    const stats = poolManager.getStats();
    log.info(`Pool stats: ${stats.total} total, ${stats.byState.idle} idle, ${stats.byState.busy} busy, ~${stats.memoryEstimate}MB`);
  }, 60_000);

  log.info('Session Orchestrator running');
  log.info(`Listening on Redis channels: session:message, session:reconnect, session:cancel, session:disconnect`);
}

// Graceful shutdown
async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down...`);
  await poolManager.stop();
  await db.end();
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

bootstrap().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
