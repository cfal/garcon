const SAMPLE_INTERVAL_MS = 100;
const REPORT_THRESHOLD_MS = 250;
// Finished activities kept so a stall can name work that ended while the loop was held.
const RECENT_ACTIVITY_LIMIT = 64;
const REPORTED_ACTIVITY_LIMIT = 8;

export interface EventLoopStallOptions {
  readonly intervalMs?: number;
  readonly thresholdMs?: number;
}

export interface EventLoopStall {
  readonly stallMs: number;
  // Tracked work that was running while the loop was held: activities that finished
  // during the stall, most recent first, then those still running. The stall came from
  // one of them or from untracked work, such as a garbage collection.
  readonly activities: readonly string[];
  readonly heapUsedMb: number;
}

interface Activity {
  readonly label: string;
  endedAt: number | null;
}

const running = new Set<Activity>();
const recent: Activity[] = [];

// Records work that may hold the event loop, such as a route or a queued task, so a
// stall report can name it. Returns the function that marks it finished.
export function trackActivity(label: string): () => void {
  const activity: Activity = { label, endedAt: null };
  running.add(activity);
  return () => {
    if (!running.delete(activity)) return;
    activity.endedAt = performance.now();
    recent.push(activity);
    if (recent.length > RECENT_ACTIVITY_LIMIT) recent.shift();
  };
}

export async function withActivity<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  const finish = trackActivity(label);
  try {
    return await work();
  } finally {
    finish();
  }
}

function activitiesDuring(windowStart: number): string[] {
  const labels = new Set<string>();
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const activity = recent[index]!;
    if (activity.endedAt! < windowStart) break;
    labels.add(activity.label);
  }
  for (const activity of [...running].reverse()) labels.add(activity.label);
  return [...labels].slice(0, REPORTED_ACTIVITY_LIMIT);
}

// Reports event-loop stalls. A stall delays every socket, heartbeat, and timer in
// the process, so peers can mistake a busy process for a dead one.
export function monitorEventLoopStalls(
  onStall: (stall: EventLoopStall) => void,
  options: EventLoopStallOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? SAMPLE_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? REPORT_THRESHOLD_MS;
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const stallMs = now - expected;
    // The loop was held from at least the missed tick until now.
    const windowStart = expected;
    expected = now + intervalMs;
    if (stallMs < thresholdMs) return;
    onStall({
      stallMs: Math.round(stallMs),
      activities: activitiesDuring(windowStart),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
