export interface RunningSessionRef {
  id?: unknown;
}

export type RunningSessionsByAgent = Record<string, RunningSessionRef[]>;

export interface AbortRunningSessionsOptions {
  runningSessions: RunningSessionsByAgent;
  abortSession(chatId: string): Promise<unknown>;
  timeoutMs?: number;
  onAbortError?(chatId: string, error: unknown): void;
}

export interface AbortRunningSessionsResult {
  attempted: number;
  completed: boolean;
  timedOut: boolean;
}

const DEFAULT_ABORT_TIMEOUT_MS = 3000;

export function shutdownExitCode(options: { abortTimedOut: boolean; cleanupFailed: boolean }): number {
  return options.abortTimedOut || options.cleanupFailed ? 1 : 0;
}

function runningChatIds(runningSessions: RunningSessionsByAgent): string[] {
  const ids: string[] = [];
  for (const sessions of Object.values(runningSessions)) {
    for (const session of sessions) {
      if (typeof session.id === 'string' && session.id) ids.push(session.id);
    }
  }
  return ids;
}

export async function abortRunningSessionsWithTimeout({
  runningSessions,
  abortSession,
  timeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
  onAbortError,
}: AbortRunningSessionsOptions): Promise<AbortRunningSessionsResult> {
  const chatIds = runningChatIds(runningSessions);
  if (chatIds.length === 0) {
    return { attempted: 0, completed: true, timedOut: false };
  }

  const aborts = Promise.allSettled(chatIds.map(async (chatId) => {
    try {
      await abortSession(chatId);
    } catch (error) {
      onAbortError?.(chatId, error);
    }
  }));

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutReached = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });

  const completed = await Promise.race([
    aborts.then(() => true),
    timeoutReached,
  ]);

  if (timeout) clearTimeout(timeout);
  return { attempted: chatIds.length, completed, timedOut: !completed };
}
