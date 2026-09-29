const SAMPLE_INTERVAL_MS = 100;
const REPORT_THRESHOLD_MS = 250;

export interface EventLoopStallOptions {
  readonly intervalMs?: number;
  readonly thresholdMs?: number;
}

// Reports event-loop stalls. A stall delays every socket, heartbeat, and timer in
// the process, so peers can mistake a busy process for a dead one.
export function monitorEventLoopStalls(
  onStall: (stallMs: number) => void,
  options: EventLoopStallOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? REPORT_THRESHOLD_MS;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const stallMs = now - expected;
    expected = now + intervalMs;
    if (stallMs >= thresholdMs) onStall(Math.round(stallMs));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
