import {
  AgentIntegrationError,
  type AgentSingleQueryRequest,
} from '@garcon/server-agent-interface';

export interface SingleQueryControlOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export function singleQueryRuntimeOptions(
  request: AgentSingleQueryRequest,
): Record<string, unknown> & SingleQueryControlOptions {
  return {
    ...request.settings.values,
    thinkingMode: request.thinkingMode,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    signal: request.signal,
  };
}

export async function withSingleQueryControl<T>(
  options: { readonly signal?: unknown; readonly timeoutMs?: unknown },
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = options.signal instanceof AbortSignal ? options.signal : null;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();

  const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
  const timeout = timeoutMs === null
    ? null
    : setTimeout(() => controller.abort(new AgentIntegrationError(
      'TIMEOUT',
      `Single query timed out after ${timeoutMs}ms.`,
      true,
    )), timeoutMs);
  timeout?.unref?.();

  let removeAbortRejection = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const rejectAborted = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAborted, { once: true });
    removeAbortRejection = () => controller.signal.removeEventListener('abort', rejectAborted);
  });

  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (timeout) clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
    removeAbortRejection();
  }
}

function normalizedTimeoutMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
}
