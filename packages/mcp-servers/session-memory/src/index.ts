/**
 * Session Memory MCP Server
 *
 * Provides Claude CLI with access to conversation history, user profile,
 * and sandboxed filesystem operations.
 *
 * Implements the MCP (Model Context Protocol) over stdio transport.
 */

import { Pool } from 'pg';
import { createClient } from 'redis';
import { createLogger, sanitizeInput } from '@betclaude/shared';
import { randomUUID } from 'node:crypto';

const log = createLogger('mcp:session-memory');

// ============================================================
// MCP Protocol implementation (stdio JSON-RPC 2.0)
// ============================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Tools we expose
const TOOLS = [
  {
    name: 'save_conversation',
    description: 'Save a conversation exchange to the session history',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        role: { type: 'string', enum: ['user', 'assistant', 'system'] },
        content: { type: 'string', description: 'Message content' },
        metadata: { type: 'object', description: 'Optional metadata' },
      },
      required: ['sessionId', 'role', 'content'],
    },
  },
  {
    name: 'load_history',
    description: 'Load conversation history for a session',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID' },
        limit: { type: 'number', description: 'Maximum messages to load', default: 20 },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_user_profile',
    description: 'Get the current user profile and preferences',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_user_sessions',
    description: 'Get user\'s recent chat sessions',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum sessions to return', default: 10 },
      },
      required: [],
    },
  },
  {
    name: 'save_file',
    description: 'Save content to a file in the sandboxed session directory',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the sandboxed session directory',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name' },
      },
      required: ['filename'],
    },
  },
];

// ============================================================
// Server
// ============================================================

class SessionMemoryServer {
  private db: Pool;
  private redis: ReturnType<typeof createClient>;
  private userId: string;

  constructor(userId: string) {
    this.userId = userId;
    this.db = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'betclaude',
      user: process.env.DB_USER || 'betclaude',
      password: process.env.DB_PASSWORD || 'betclaude_dev',
      max: 3,
    });
    this.redis = createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    });
  }

  async start() {
    await this.redis.connect();

    // Read JSON-RPC requests from stdin
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const req: JsonRpcRequest = JSON.parse(line);
            this.handleRequest(req);
          } catch {
            // Skip invalid JSON
          }
        }
      }
    });

    process.stdin.on('end', () => {
      this.shutdown();
    });

    log.info(`Session Memory MCP server started for user ${this.userId}`);
  }

  private async handleRequest(req: JsonRpcRequest) {
    try {
      let result: unknown;

      switch (req.method) {
        case 'initialize':
          result = {
            protocolVersion: '0.2.0',
            serverInfo: { name: 'session-memory', version: '0.1.0' },
            capabilities: { tools: {} },
          };
          break;

        case 'tools/list':
          result = { tools: TOOLS };
          break;

        case 'tools/call':
          result = await this.callTool(
            (req.params as any)?.name,
            (req.params as any)?.arguments || {}
          );
          break;

        case 'resources/list':
          result = { resources: [] };
          break;

        case 'notifications/initialized':
          // No response needed for notifications
          return;

        default:
          this.sendError(req.id, -32601, `Method not found: ${req.method}`);
          return;
      }

      this.sendResponse({ jsonrpc: '2.0', id: req.id, result });
    } catch (err: any) {
      log.error(`Error handling ${req.method}: ${err.message}`);
      this.sendError(req.id, -32603, err.message);
    }
  }

  private async callTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'save_conversation':
        return this.saveConversation(args);
      case 'load_history':
        return this.loadHistory(args);
      case 'get_user_profile':
        return this.getUserProfile();
      case 'get_user_sessions':
        return this.getUserSessions(args);
      case 'save_file':
        return this.saveFile(args);
      case 'read_file':
        return this.readFile(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // Tool implementations

  private async saveConversation(args: any): Promise<any> {
    const content = sanitizeInput(args.content);
    const id = randomUUID();

    await this.db.query(
      `INSERT INTO chat_messages (id, session_id, user_id, role, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, args.sessionId, this.userId, args.role, content, JSON.stringify(args.metadata || {})]
    );

    // Update session message count
    await this.db.query(
      `UPDATE sessions SET message_count = message_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [args.sessionId]
    );

    return { content: [{ type: 'text', text: JSON.stringify({ saved: true, messageId: id }) }] };
  }

  private async loadHistory(args: any): Promise<any> {
    const result = await this.db.query(
      `SELECT role, content, metadata, created_at
       FROM chat_messages
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [args.sessionId, args.limit || 20]
    );

    const messages = result.rows.reverse();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ messages, count: messages.length }),
      }],
    };
  }

  private async getUserProfile(): Promise<any> {
    const result = await this.db.query(
      `SELECT id, email, username, role, subscription, created_at
       FROM users WHERE id = $1`,
      [this.userId]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'User not found' }) }] };
    }

    const user = result.rows[0];

    // Get favorite sports
    const sports = await this.db.query(
      `SELECT sport, COUNT(*) as cnt
       FROM sessions WHERE user_id = $1 AND sport IS NOT NULL
       GROUP BY sport ORDER BY cnt DESC LIMIT 5`,
      [this.userId]
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...user,
          preferredSports: sports.rows.map((r) => r.sport),
        }),
      }],
    };
  }

  private async getUserSessions(args: any): Promise<any> {
    const result = await this.db.query(
      `SELECT id, title, sport, status, message_count, created_at, updated_at
       FROM sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [this.userId, args.limit || 10]
    );

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ sessions: result.rows }),
      }],
    };
  }

  private async saveFile(args: any): Promise<any> {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const sandboxDir = join(tmpdir(), 'betclaude', 'sandbox', this.userId);
    await mkdir(sandboxDir, { recursive: true });

    const filepath = join(sandboxDir, args.filename);
    await writeFile(filepath, args.content, 'utf8');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ saved: true, path: filepath }),
      }],
    };
  }

  private async readFile(args: any): Promise<any> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const sandboxDir = join(tmpdir(), 'betclaude', 'sandbox', this.userId);
    const filepath = join(sandboxDir, args.filename);

    try {
      const content = await readFile(filepath, 'utf8');
      return { content: [{ type: 'text', text: content }] };
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'File not found' }) }] };
    }
  }

  // ============================================================
  // Protocol helpers
  // ============================================================

  private sendResponse(response: JsonRpcResponse) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }

  private sendError(id: string | number, code: number, message: string) {
    this.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  private async shutdown() {
    await this.db.end();
    await this.redis.quit();
    process.exit(0);
  }
}

// ============================================================
// Entry
// ============================================================

const userId = process.env.USER_ID || 'default';
const server = new SessionMemoryServer(userId);
server.start().catch((err) => {
  log.error('Fatal error', err);
  process.exit(1);
});
