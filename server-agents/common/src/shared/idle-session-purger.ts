export const DEFAULT_IDLE_SESSION_MAX_AGE_MS = 30 * 60 * 1000;
export const DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS = 5 * 60 * 1000;

export interface IdleSessionPurgeOptions<TSession> {
  sessions(): Iterable<[string, TSession]>;
  isRunning(session: TSession): boolean;
  lastActivityAt(session: TSession): number;
  purge(sessionId: string, session: TSession): void;
}

export function purgeIdleSessions<TSession>(
  options: IdleSessionPurgeOptions<TSession>,
  now = Date.now(),
  maxIdleMs = DEFAULT_IDLE_SESSION_MAX_AGE_MS,
): number {
  let purged = 0;
  for (const [sessionId, session] of options.sessions()) {
    if (options.isRunning(session)) continue;
    if (now - options.lastActivityAt(session) < maxIdleMs) continue;
    options.purge(sessionId, session);
    purged += 1;
  }
  return purged;
}

export class IdleSessionPurger<TSession> {
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: IdleSessionPurgeOptions<TSession>,
    private readonly timing: {
      intervalMs?: number;
      maxIdleMs?: number;
    } = {},
  ) {}

  start(): void {
    if (this.#timer) return;
    const intervalMs = this.timing.intervalMs ?? DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS;
    const maxIdleMs = this.timing.maxIdleMs ?? DEFAULT_IDLE_SESSION_MAX_AGE_MS;
    this.#timer = setInterval(() => {
      purgeIdleSessions(this.options, Date.now(), maxIdleMs);
    }, intervalMs);
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

