import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { POOL_DEFAULTS } from '@betclaude/shared';
import type { ClaudeProcessState, McpServerConfig } from '@betclaude/shared';
import { createLogger } from '@betclaude/shared';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const log = createLogger('pool-mgr');

// ============================================================
// Types
// ============================================================

export interface ClaudeProcess {
  id: string;
  userId: string;
  sessionId: string;
  process: ChildProcess;
  state: ClaudeProcessState;
  workDir: string;
  mcpConfig: McpServerConfig[];
  createdAt: Date;
  lastActivityAt: Date;
  messageCount: number;
  tokenBudget: number;
  idleTimer?: NodeJS.Timeout;
  maxSessionTimer?: NodeJS.Timeout;
}

interface PoolStats {
  total: number;
  byState: Record<ClaudeProcessState, number>;
  byUser: Record<string, number>;
  memoryEstimate: number;
}

// ============================================================
// Pool Manager
// ============================================================

export class ProcessPoolManager extends EventEmitter {
  private processes: Map<string, ClaudeProcess> = new Map();
  private maxTotal: number;
  private maxPerUser: number;
  private idleTimeoutMs: number;
  private maxSessionMs: number;
  private gracefulShutdownMs: number;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(opts?: {
    maxTotal?: number;
    maxPerUser?: number;
    idleTimeoutMs?: number;
    maxSessionMs?: number;
    gracefulShutdownMs?: number;
  }) {
    super();
    this.maxTotal = opts?.maxTotal ?? POOL_DEFAULTS.MAX_TOTAL_PROCESSES;
    this.maxPerUser = opts?.maxPerUser ?? POOL_DEFAULTS.MAX_PROCESSES_PER_USER;
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? POOL_DEFAULTS.IDLE_TIMEOUT_MS;
    this.maxSessionMs = opts?.maxSessionMs ?? POOL_DEFAULTS.MAX_SESSION_DURATION_MS;
    this.gracefulShutdownMs = opts?.gracefulShutdownMs ?? POOL_DEFAULTS.GRACEFUL_SHUTDOWN_MS;
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /** Start health check loop */
  start(): void {
    this.healthCheckInterval = setInterval(() => {
      this.runHealthChecks();
    }, POOL_DEFAULTS.HEALTH_CHECK_INTERVAL_MS);
    log.info('Process Pool Manager started');
  }

  /** Stop all processes gracefully */
  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    log.info(`Stopping ${this.processes.size} processes...`);
    const shutdowns = Array.from(this.processes.values()).map((p) =>
      this.destroyProcess(p.id, 'pool_shutdown')
    );

    await Promise.allSettled(shutdowns);
    log.info('All processes stopped');
  }

  // ============================================================
  // Process Management
  // ============================================================

  /** Spawn a new Claude CLI process for a session */
  async createProcess(
    userId: string,
    sessionId: string,
    mcpConfig: McpServerConfig[]
  ): Promise<ClaudeProcess> {
    // Check limits
    const userCount = this.getUserProcessCount(userId);
    if (userCount >= this.maxPerUser) {
      throw new Error(`User ${userId} has reached max process limit (${this.maxPerUser})`);
    }

    if (this.processes.size >= this.maxTotal) {
      // Try to kill oldest idle process
      const evicted = await this.evictOldestIdle();
      if (!evicted) {
        throw new Error(`Pool full (${this.maxTotal} processes), no idle processes to evict`);
      }
    }

    // Create working directory for this session
    const procId = `claude_${randomUUID().slice(0, 8)}`;
    const workDir = join(tmpdir(), 'betclaude', procId);
    await mkdir(workDir, { recursive: true });

    // Write MCP config file
    const mcpConfigPath = join(workDir, '.mcp.json');
    await writeFile(
      mcpConfigPath,
      JSON.stringify({ mcpServers: this.buildMcpServerMap(mcpConfig) }, null, 2)
    );

    // Spawn Claude CLI
    const child = spawn('claude', [
      '--mcp-config', mcpConfigPath,
      '--output-format', 'stream-json',
      '--max-turns', '50',
      '--no-color',
    ], {
      cwd: workDir,
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: sessionId,
        CLAUDE_USER_ID: userId,
        HOME: workDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const proc: ClaudeProcess = {
      id: procId,
      userId,
      sessionId,
      process: child,
      state: 'starting',
      workDir,
      mcpConfig,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      messageCount: 0,
      tokenBudget: POOL_DEFAULTS.TOKEN_BUDGET_DEFAULT,
    };

    this.processes.set(procId, proc);

    // Set max session timer
    proc.maxSessionTimer = setTimeout(() => {
      log.info(`Max session duration reached for ${procId}`);
      this.destroyProcess(procId, 'max_duration');
    }, this.maxSessionMs);

    // Handle process events
    child.on('spawn', () => {
      proc.state = 'ready';
      this.emit('process:ready', proc);
      log.info(`Process ${procId} ready (PID: ${child.pid})`);
    });

    child.on('exit', (code, signal) => {
      log.info(`Process ${procId} exited: code=${code} signal=${signal}`);
      proc.state = 'dead';
      this.emit('process:exit', proc, code, signal);
      this.cleanupProcess(procId);
    });

    child.on('error', (err) => {
      log.error(`Process ${procId} error: ${err.message}`);
      proc.state = 'dead';
      this.emit('process:error', proc, err);
      this.cleanupProcess(procId);
    });

    child.stderr?.on('data', (data: Buffer) => {
      this.emit('process:stderr', proc, data.toString());
    });

    return proc;
  }

  /** Get or create a process */
  async getOrCreate(
    userId: string,
    sessionId: string | undefined,
    mcpConfig: McpServerConfig[]
  ): Promise<{ proc: ClaudeProcess; isNew: boolean }> {
    // Try reconnect to existing session
    if (sessionId) {
      const existing = this.findBySession(sessionId);
      if (existing && existing.state !== 'dead') {
        existing.lastActivityAt = new Date();
        existing.state = 'ready';
        this.resetIdleTimer(existing);
        this.emit('process:reconnect', existing);
        return { proc: existing, isNew: false };
      }
    }

    // Find an existing idle process for this user
    const userProcesses = this.findByUser(userId);
    const idleProc = userProcesses.find((p) => p.state === 'idle');
    if (idleProc) {
      idleProc.lastActivityAt = new Date();
      idleProc.state = 'ready';
      this.resetIdleTimer(idleProc);
      return { proc: idleProc, isNew: false };
    }

    // Create new
    const newSessionId = sessionId || `sess_${randomUUID().slice(0, 8)}`;
    const proc = await this.createProcess(userId, newSessionId, mcpConfig);
    return { proc, isNew: true };
  }

  /** Send a message to a process's stdin */
  sendInput(procId: string, input: string): boolean {
    const proc = this.processes.get(procId);
    if (!proc || proc.state === 'dead') {
      return false;
    }

    proc.state = 'busy';
    proc.lastActivityAt = new Date();
    proc.messageCount++;
    proc.process.stdin?.write(input + '\n');
    this.resetIdleTimer(proc);
    return true;
  }

  /** Mark process as idle after response */
  markIdle(procId: string): void {
    const proc = this.processes.get(procId);
    if (proc && proc.state === 'busy') {
      proc.state = 'idle';
      this.startIdleTimer(proc);
    }
  }

  /** Destroy a process */
  async destroyProcess(procId: string, reason: string): Promise<void> {
    const proc = this.processes.get(procId);
    if (!proc) return;

    log.info(`Destroying process ${procId}: ${reason}`);
    proc.state = 'draining';
    this.emit('process:destroy', proc, reason);

    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    if (proc.maxSessionTimer) clearTimeout(proc.maxSessionTimer);

    // Graceful: SIGTERM first
    proc.process.stdin?.end();
    proc.process.kill('SIGTERM');

    // Force kill after grace period
    setTimeout(() => {
      if (proc.process.exitCode === null) {
        log.warn(`Force killing process ${procId}`);
        proc.process.kill('SIGKILL');
      }
    }, this.gracefulShutdownMs);

    // Cleanup workdir
    try {
      await rm(proc.workDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }

    this.cleanupProcess(procId);
  }

  // ============================================================
  // Queries
  // ============================================================

  getProcess(procId: string): ClaudeProcess | undefined {
    return this.processes.get(procId);
  }

  findByUser(userId: string): ClaudeProcess[] {
    return Array.from(this.processes.values()).filter((p) => p.userId === userId);
  }

  findBySession(sessionId: string): ClaudeProcess | undefined {
    return Array.from(this.processes.values()).find((p) => p.sessionId === sessionId);
  }

  getUserProcessCount(userId: string): number {
    return this.findByUser(userId).filter((p) => p.state !== 'dead').length;
  }

  getStats(): PoolStats {
    const byState: Record<ClaudeProcessState, number> = {
      starting: 0, ready: 0, busy: 0, idle: 0, draining: 0, dead: 0,
    };
    const byUser: Record<string, number> = {};
    let total = 0;

    for (const proc of this.processes.values()) {
      total++;
      byState[proc.state]++;
      byUser[proc.userId] = (byUser[proc.userId] || 0) + 1;
    }

    return {
      total,
      byState,
      byUser,
      memoryEstimate: total * POOL_DEFAULTS.PROCESS_MEMORY_MB,
    };
  }

  getProcessIds(): string[] {
    return Array.from(this.processes.keys());
  }

  // ============================================================
  // Private
  // ============================================================

  private startIdleTimer(proc: ClaudeProcess): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = setTimeout(() => {
      log.info(`Idle timeout for process ${proc.id}`);
      this.destroyProcess(proc.id, 'idle_timeout');
    }, this.idleTimeoutMs);
  }

  private resetIdleTimer(proc: ClaudeProcess): void {
    if (proc.idleTimer) {
      clearTimeout(proc.idleTimer);
      proc.idleTimer = undefined;
    }
  }

  private cleanupProcess(procId: string): void {
    const proc = this.processes.get(procId);
    if (proc) {
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      if (proc.maxSessionTimer) clearTimeout(proc.maxSessionTimer);
      this.processes.delete(procId);
    }
  }

  private async evictOldestIdle(): Promise<boolean> {
    let oldest: ClaudeProcess | null = null;
    for (const proc of this.processes.values()) {
      if (proc.state === 'idle') {
        if (!oldest || proc.lastActivityAt < oldest.lastActivityAt) {
          oldest = proc;
        }
      }
    }

    if (oldest) {
      await this.destroyProcess(oldest.id, 'evicted');
      return true;
    }
    return false;
  }

  private runHealthChecks(): void {
    for (const proc of this.processes.values()) {
      if (proc.state === 'dead') {
        this.cleanupProcess(proc.id);
        continue;
      }

      // Check if process is still alive
      if (proc.process.exitCode !== null || proc.process.killed) {
        log.warn(`Process ${proc.id} appears dead (exitCode: ${proc.process.exitCode})`);
        proc.state = 'dead';
        this.cleanupProcess(proc.id);
        continue;
      }

      // Check for stalled processes
      const stallThreshold = 10 * 60 * 1000; // 10 minutes
      if (
        proc.state === 'busy' &&
        Date.now() - proc.lastActivityAt.getTime() > stallThreshold
      ) {
        log.warn(`Process ${proc.id} stalled for >10min, killing`);
        this.destroyProcess(proc.id, 'stalled');
      }
    }
  }

  private buildMcpServerMap(
    configs: McpServerConfig[]
  ): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
    const map: Record<string, any> = {};
    for (const cfg of configs) {
      if (cfg.enabled) {
        map[cfg.name] = {
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
        };
      }
    }
    return map;
  }
}
