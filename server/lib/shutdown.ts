export interface RunningSessionRef {
  id?: unknown;
}

export type RunningSessionsByAgent = Record<string, RunningSessionRef[]>;

export interface AbortRunningSessionsOptions {
  runningSessions: RunningSessionsByAgent;
  additionalChatIds?: readonly string[];
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

export async function waitForShutdownTaskWithTimeout(
  task: Promise<unknown>,
  timeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutReached = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const completed = await Promise.race([
    task.then(() => true, () => false),
    timeoutReached,
  ]);
  if (timeout) clearTimeout(timeout);
  return completed;
}

export async function waitForShutdownPhasesWithTimeout(
  phases: readonly (() => Promise<unknown>)[],
  timeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
): Promise<{ completed: boolean; errors: unknown[] }> {
  const errors: unknown[] = [];
  let stopAfterCurrentPhase = false;
  const task = (async () => {
    for (const phase of phases) {
      if (stopAfterCurrentPhase) break;
      try {
        await phase();
      } catch (error) {
        errors.push(error);
      }
    }
  })();
  const completed = await waitForShutdownTaskWithTimeout(task, timeoutMs);
  if (!completed) stopAfterCurrentPhase = true;
  return { completed, errors: [...errors] };
}

export function shutdownExitCode(options: { abortTimedOut: boolean; cleanupFailed: boolean }): number {
  return options.abortTimedOut || options.cleanupFailed ? 1 : 0;
}

function runningChatIds(
  runningSessions: RunningSessionsByAgent,
  additionalChatIds: readonly string[] = [],
): string[] {
  const ids = new Set(additionalChatIds.filter(Boolean));
  for (const sessions of Object.values(runningSessions)) {
    for (const session of sessions) {
      if (typeof session.id === 'string' && session.id) ids.add(session.id);
    }
  }
  return [...ids];
}

export async function abortRunningSessionsWithTimeout({
  runningSessions,
  additionalChatIds,
  abortSession,
  timeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
  onAbortError,
}: AbortRunningSessionsOptions): Promise<AbortRunningSessionsResult> {
  const chatIds = runningChatIds(runningSessions, additionalChatIds);
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

  const completed = await waitForShutdownTaskWithTimeout(aborts, timeoutMs);
  return { attempted: chatIds.length, completed, timedOut: !completed };
}
