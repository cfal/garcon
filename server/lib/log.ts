type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type LogMethod = Exclude<LogLevel, 'silent'>;

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

const DEFAULT_LOG_LEVEL: LogLevel = 'info';

function configuredLevel(): LogLevel {
  const raw = process.env.GARCON_LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return DEFAULT_LOG_LEVEL;
  if (raw in LOG_LEVEL_RANK) return raw as LogLevel;
  return DEFAULT_LOG_LEVEL;
}

function shouldLog(method: LogMethod): boolean {
  return LOG_LEVEL_RANK[method] >= LOG_LEVEL_RANK[configuredLevel()];
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;

  function emit(method: LogMethod, args: unknown[]): void {
    if (!shouldLog(method)) return;
    console[method](prefix, ...args);
  }

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}
