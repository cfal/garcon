import { AgentCallError, type AgentDeliveryOutcome } from '@garcon/server-agent-interface';

// Fails a run whose remote transcript binding could not resume after the
// executor connection was lost.
export const EXECUTOR_DISCONNECTED_MID_TURN = 'Executor disconnected mid-turn. The turn may still be running on the executor. Reload from native history after it finishes to recover missing output.';

// Fails a run whose start, resume, or compaction the executor never began:
// the request or its cancellation was lost with the connection, or the executor
// went offline while the run was still being set up.
export const EXECUTOR_DISCONNECTED_BEFORE_START = {
  code: 'EXECUTOR_UNAVAILABLE',
  message: 'The executor connection was lost before this turn started. Send it again.',
} as const;

// A remote call that failed because its executor session was lost: dropped
// while it was being sent, or outstanding when the session retired. Setup steps
// may retry it; the retry waits for the replacement session.
export class ExecutorSessionLostError extends AgentCallError {
  constructor(outcome: AgentDeliveryOutcome, message: string) {
    super(outcome, message);
    this.name = 'ExecutorSessionLostError';
  }
}
