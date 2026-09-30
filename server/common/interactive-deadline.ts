import type { ExecutorCallOptions } from '@garcon/server-agent-interface';

// An operation holding a chat lock waits at most this long in total for a
// reconnecting executor. Browsers give each request 30 seconds, so the server
// answers first, and a Stop or Delete queued behind the lock still completes.
export const INTERACTIVE_EXECUTOR_WAIT_MS = 20_000;
export const SENT_READ_GRACE_MS = 5_000;

// Starts an operation's deadline, shared by all of its executor calls, which pass
// it as `dispatchDeadline` so they stop waiting for a reconnecting executor there.
export function interactiveDeadline(): number {
  return performance.now() + INTERACTIVE_EXECUTOR_WAIT_MS;
}

// A read-only call waits for a reconnecting executor until the deadline and, once
// sent, may run until SENT_READ_GRACE_MS past it, so a read sent late after a
// reconnect still gets time to answer. All of an operation's reads end by then.
// Without a deadline a read keeps its own.
export function readBefore(deadline: number | undefined, signal?: AbortSignal): ExecutorCallOptions {
  if (deadline === undefined) return { signal };
  return {
    signal,
    dispatchDeadline: deadline,
    timeoutMs: Math.max(1, Math.ceil(deadline + SENT_READ_GRACE_MS - performance.now())),
  };
}
