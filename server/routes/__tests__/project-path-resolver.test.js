import { describe, expect, it } from 'bun:test';
import { projectUnavailableResponse } from '../project-path-resolver.ts';

const PROJECT_PATH = '/workspace/project';

describe('workspace project error mapping', () => {
  it('rejects non-directory project roots with a typed response', async () => {
    const result = projectUnavailableResponse(PROJECT_PATH, 'not-a-directory');

    expect(result.status).toBe(400);
    await expect(result.json()).resolves.toMatchObject({
      errorCode: 'PROJECT_PATH_NOT_DIRECTORY',
      retryable: false,
    });
  });

  it('preserves the permission-denied response contract', async () => {
    const result = projectUnavailableResponse(PROJECT_PATH, 'permission-denied');

    expect(result.status).toBe(403);
    await expect(result.json()).resolves.toMatchObject({
      error: `Project folder cannot be accessed: ${PROJECT_PATH}`,
      errorCode: 'VALIDATION_FAILED',
      retryable: false,
    });
  });
});
