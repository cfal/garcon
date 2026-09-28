// Fails a run whose remote transcript binding could not resume after the
// executor connection was lost.
export const EXECUTOR_DISCONNECTED_MID_TURN = 'Executor disconnected mid-turn. The turn may still be running on the executor. Reload from native history after it finishes to recover missing output.';

// Fails a run whose start, resume, or compaction the executor never began,
// because the request or its cancellation was lost with the connection.
export const EXECUTOR_DISCONNECTED_BEFORE_START = {
  code: 'EXECUTOR_UNAVAILABLE',
  message: 'The executor connection was lost before this turn started. Send it again.',
} as const;
