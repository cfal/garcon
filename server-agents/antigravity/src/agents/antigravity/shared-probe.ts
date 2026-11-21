// Lets concurrent callers that would run an identical CLI probe share one
// process; the entry clears once the probe settles.
export function sharedProbe<T>(inFlight: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = start().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
