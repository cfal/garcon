import { ExecutorSessionLostError } from '../../common/executor-disconnect.js';

const SESSION_LOSS_ATTEMPTS = 3;

// Runs an execution setup step again when its executor session was lost, even if
// the loss left its outcome unknown. Only steps that are safe to repeat use it:
// read-only calls, or registrations that take a fresh identity on each attempt.
// The retry waits for the replacement session, so it never reuses the lost one.
export async function retryAfterSessionLoss<T>(step: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (!(error instanceof ExecutorSessionLostError) || attempt >= SESSION_LOSS_ATTEMPTS) throw error;
      signal?.throwIfAborted();
    }
  }
}
