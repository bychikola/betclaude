import { createHash, randomUUID } from 'node:crypto';

// ============================================================
// Shared utilities
// ============================================================

/** Generate a unique session ID */
export function generateId(prefix = 'sess'): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/** Hash a string for safe use in Redis keys / file paths */
export function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** Sanitize user input before sending to Claude CLI */
export function sanitizeInput(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // control chars except \n, \t
    .replace(/\r?\n{4,}/g, '\n\n\n')               // max 3 consecutive newlines
    .trim()
    .slice(0, 8000); // max message length
}

/** Sleep utility */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format bytes to human readable */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

/** Truncate string to max length with ellipsis */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/** Simple logger with levels */
export function createLogger(namespace: string) {
  const prefix = `[${namespace}]`;
  return {
    info: (msg: string, ...args: unknown[]) =>
      console.log(`${prefix} INFO  ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) =>
      console.warn(`${prefix} WARN  ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) =>
      console.error(`${prefix} ERROR ${msg}`, ...args),
    debug: (msg: string, ...args: unknown[]) =>
      process.env.DEBUG && console.debug(`${prefix} DEBUG ${msg}`, ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
