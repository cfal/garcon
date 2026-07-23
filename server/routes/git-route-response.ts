import type { GitCommandTrace } from '../git/types.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:git');

export function traceGitJsonResponse(
  route: string,
  startedAt: number,
  trace: GitCommandTrace[],
  body: unknown,
): Response {
  const json = JSON.stringify(body) ?? 'null';
  const slowestCommand = trace.reduce<GitCommandTrace | undefined>(
    (slowest, command) => (!slowest || command.durationMs > slowest.durationMs ? command : slowest),
    undefined,
  );
  logger.debug('git workbench route', {
    route,
    durationMs: Math.round(performance.now() - startedAt),
    commandCount: trace.length,
    slowestCommand,
    responseBytes: Buffer.byteLength(json),
  });
  return new Response(json, {
    headers: { 'content-type': 'application/json' },
  });
}
