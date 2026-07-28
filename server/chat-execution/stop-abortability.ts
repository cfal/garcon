import type { AgentTurnRunnerPort } from './types.ts';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import { createLogger } from '../lib/log.js';

const logger = createLogger('queue');
const STOP_ABORTABLE_WARNING_MS = 10_000;

export async function waitUntilStopAbortable(
  chatId: string,
  attempt: QueueExecutionAttempt,
  turnRunner: AgentTurnRunnerPort,
  isCurrentAttempt: () => boolean,
): Promise<boolean> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const warningTimer = setTimeout(() => {
    logger.warn('queue: Stop waiting for abortability', {
      chatId,
      attempt: attempt.identity(),
      waitMs: Date.now() - startedAt,
    });
  }, STOP_ABORTABLE_WARNING_MS);
  warningTimer.unref();
  const runtimeAbortable = turnRunner.waitUntilTurnAbortable(
    chatId,
    attempt.identity(),
    controller.signal,
  ).then(
    (isAbortable) => {
      if (isAbortable && isCurrentAttempt()) attempt.markAbortable();
      return isAbortable;
    },
    () => false,
  );
  try {
    return await Promise.race([attempt.waitUntilAbortable(), runtimeAbortable]);
  } finally {
    clearTimeout(warningTimer);
    controller.abort();
  }
}
