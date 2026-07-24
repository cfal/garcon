import type {
  GitCommandTrace,
  GitReviewRouteMetrics,
  GitReviewRoutePhase,
  GitReviewRoutePhaseName,
} from '../git/types.js';
import { measureGitReviewPhase } from '../git/review-performance.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:git');

export type GitRoutePhaseName = GitReviewRoutePhaseName;
export type GitRoutePhase = GitReviewRoutePhase;
export type GitRouteResponseMetrics = GitReviewRouteMetrics;

export async function measureGitRoutePhase<T>(
  phases: GitRoutePhase[],
  name: GitRoutePhaseName,
  operation: () => Promise<T> | T,
): Promise<T> {
  return measureGitReviewPhase({ phases }, name, operation);
}

function serverTimingHeader(
  totalDurationMs: number,
  trace: GitCommandTrace[],
  phases: GitRoutePhase[],
): string {
  const gitDurationMs = trace.reduce((total, command) => total + command.durationMs, 0);
  return [
    `total;dur=${totalDurationMs.toFixed(1)}`,
    `git;dur=${gitDurationMs.toFixed(1)}`,
    ...phases.map((phase) => `${phase.name};dur=${phase.durationMs.toFixed(1)}`),
  ].join(', ');
}

export function traceGitJsonResponse(
  route: string,
  startedAt: number,
  trace: GitCommandTrace[],
  body: unknown,
  metrics: GitRouteResponseMetrics = { phases: [] },
): Response {
  const serializeStartedAt = performance.now();
  const json = JSON.stringify(body) ?? 'null';
  const phases = [
    ...metrics.phases,
    { name: 'serialize' as const, durationMs: performance.now() - serializeStartedAt },
  ];
  const durationMs = performance.now() - startedAt;
  const gitDurationMs = trace.reduce((total, command) => total + command.durationMs, 0);
  const slowestCommand = trace.reduce<GitCommandTrace | undefined>(
    (slowest, command) => (!slowest || command.durationMs > slowest.durationMs ? command : slowest),
    undefined,
  );
  logger.debug('git workbench route', {
    route,
    status:
      typeof body === 'object' && body !== null && 'status' in body
        ? String(body.status)
        : 'ready',
    durationMs: Math.round(durationMs),
    commandCount: trace.length,
    gitDurationMs: Math.round(gitDurationMs),
    maxGitDurationMs: Math.round(slowestCommand?.durationMs ?? 0),
    slowestGitCommand: slowestCommand?.args[0] ?? null,
    responseBytes: Buffer.byteLength(json),
    phases: phases.map((phase) => ({
      name: phase.name,
      durationMs: Math.round(phase.durationMs),
    })),
    ...(metrics.fileCount !== undefined ? { fileCount: metrics.fileCount } : {}),
    ...(metrics.rowCount !== undefined ? { rowCount: metrics.rowCount } : {}),
    ...(metrics.cacheHits !== undefined ? { cacheHits: metrics.cacheHits } : {}),
    ...(metrics.batchCount !== undefined ? { batchCount: metrics.batchCount } : {}),
    ...(metrics.bisectionCount !== undefined ? { bisectionCount: metrics.bisectionCount } : {}),
  });
  return new Response(json, {
    headers: {
      'content-type': 'application/json',
      'server-timing': serverTimingHeader(durationMs, trace, phases),
    },
  });
}
