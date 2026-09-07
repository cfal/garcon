import type {
  GitReviewRouteMetrics,
  GitReviewRoutePhaseName,
} from './types.js';

export async function measureGitReviewPhase<T>(
  metrics: GitReviewRouteMetrics | undefined,
  name: GitReviewRoutePhaseName,
  operation: () => Promise<T> | T,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordGitReviewPhase(metrics, name, performance.now() - startedAt);
  }
}

export function measureGitReviewPhaseSync<T>(
  metrics: GitReviewRouteMetrics | undefined,
  name: GitReviewRoutePhaseName,
  operation: () => T,
): T {
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    recordGitReviewPhase(metrics, name, performance.now() - startedAt);
  }
}

function recordGitReviewPhase(
  metrics: GitReviewRouteMetrics | undefined,
  name: GitReviewRoutePhaseName,
  durationMs: number,
): void {
  if (!metrics) return;
  const existing = metrics.phases.find((phase) => phase.name === name);
  if (existing) existing.durationMs += durationMs;
  else metrics.phases.push({ name, durationMs });
}
