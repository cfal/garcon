export class OpenCodeTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'OpenCodeTimeoutError';
  }
}

export async function withAbortableTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new OpenCodeTimeoutError(label, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
