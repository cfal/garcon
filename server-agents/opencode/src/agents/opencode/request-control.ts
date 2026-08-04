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
  let rejectCallerAbort!: (reason: unknown) => void;
  const callerAbort = new Promise<never>((_, reject) => {
    rejectCallerAbort = reject;
  });
  const abortFromCaller = () => {
    controller.abort(callerSignal?.reason);
    rejectCallerAbort(controller.signal.reason);
  };
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) abortFromCaller();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const operationResult = controller.signal.aborted
      ? Promise.reject(controller.signal.reason)
      : operation(controller.signal);
    return await Promise.race([
      operationResult,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new OpenCodeTimeoutError(label, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
      callerAbort,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}
