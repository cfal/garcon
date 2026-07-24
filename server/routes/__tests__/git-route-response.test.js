import { describe, expect, test } from 'bun:test';
import {
  measureGitRoutePhase,
  traceGitJsonResponse,
} from '../git-route-response.ts';

describe('git route response timing', () => {
  test('reports safe total, git, phase, and serialization timings', async () => {
    const phases = [];
    const value = await measureGitRoutePhase(phases, 'resolve', () => 42);
    expect(value).toBe(42);

    const response = traceGitJsonResponse(
      'comparison-files',
      performance.now() - 10,
      [{ args: ['diff'], durationMs: 4, stdoutBytes: 12, stderrBytes: 0 }],
      { status: 'ready' },
      { phases, fileCount: 1, rowCount: 2 },
    );

    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('server-timing')).toMatch(
      /^total;dur=\d+\.\d, git;dur=4\.0, resolve;dur=\d+\.\d, serialize;dur=\d+\.\d$/,
    );
    expect(await response.json()).toEqual({ status: 'ready' });
  });
});
