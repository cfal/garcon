export interface ReaderWaiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

export function raceAgainstSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function enqueueReaderWaiter<T>(options: {
  readonly waiters: ReaderWaiter<T>[];
  readonly admissionSignal?: AbortSignal;
  readonly executionSignal: AbortSignal;
  readonly onExecutionTimeout: () => void;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      options.admissionSignal?.removeEventListener('abort', onAdmissionAbort);
      options.executionSignal.removeEventListener('abort', onExecutionAbort);
    };
    const settleResolve = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const waiter: ReaderWaiter<T> = { resolve: settleResolve, reject: settleReject };
    const removeWaiter = () => {
      const index = options.waiters.indexOf(waiter);
      if (index >= 0) options.waiters.splice(index, 1);
    };
    const onAdmissionAbort = () => {
      removeWaiter();
      settleReject(new DOMException('Aborted', 'AbortError'));
    };
    const onExecutionAbort = () => {
      removeWaiter();
      options.onExecutionTimeout();
      settleReject(new Error('SEARCH_TIMEOUT'));
    };

    options.waiters.push(waiter);
    options.admissionSignal?.addEventListener('abort', onAdmissionAbort, { once: true });
    options.executionSignal.addEventListener('abort', onExecutionAbort, { once: true });
    if (options.admissionSignal?.aborted) onAdmissionAbort();
    else if (options.executionSignal.aborted) onExecutionAbort();
  });
}
