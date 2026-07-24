import type { GitCommandTrace } from '../git/types.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:git');

export type GitRoutePhaseName =
  | 'resolve'
  | 'summary-git'
  | 'document-register'
  | 'freshness-before'
  | 'body-cache'
  | 'body-git'
  | 'body-split'
  | 'patch-scan'
  | 'freshness-after'
  | 'serialize';

export interface GitRoutePhase {
  name: GitRoutePhaseName;
  durationMs: number;
}

export interface GitRouteResponseMetrics {
  phases?: GitRoutePhase[];
  fileCount?: number;
  rowCount?: number;
  cacheHits?: number;
  batchCount?: number;
  bisectionCount?: number;
}

export async function measureGitRoutePhase<T>(
  phases: GitRoutePhase[],
  name: GitRoutePhaseName,
  operation: () => Promise<T> | T,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    phases.push({ name, durationMs: performance.now() - startedAt });
  }
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
  metrics: GitRouteResponseMetrics = {},
): Response {
  const serializeStartedAt = performance.now();
  const json = JSON.stringify(body) ?? 'null';
  const phases = [
    ...(metrics.phases ?? []),
    { name: 'serialize' as const, durationMs: performance.now() - serializeStartedAt },
  ];
  const durationMs = performance.now() - startedAt;
  const slowestCommand = trace.reduce<GitCommandTrace | undefined>(
    (slowest, command) => (!slowest || command.durationMs > slowest.durationMs ? command : slowest),
    undefined,
  );
  logger.debug('git workbench route', {
    route,
    durationMs: Math.round(durationMs),
    commandCount: trace.length,
    slowestCommand,
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
