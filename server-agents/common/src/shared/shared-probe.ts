// Lets concurrent callers that would run an identical probe share one
// operation; the entry clears once it settles.
export function sharedProbe<T>(inFlight: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = start().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

// Stops waiting on a shared probe when the caller aborts, without ending the
// probe for the other callers that share it.
export function waitUnlessAborted<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
