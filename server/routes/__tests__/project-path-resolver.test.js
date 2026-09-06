import { describe, expect, it } from 'bun:test';
import { resolveAccessibleProjectPath } from '../project-path-resolver.ts';

const PROJECT_PATH = '/workspace/project';

describe('resolveAccessibleProjectPath', () => {
  it('rejects non-directory project roots with a typed response', async () => {
    const result = await resolveAccessibleProjectPath(
      PROJECT_PATH,
      async () => ({ kind: 'unavailable', reason: 'not-a-directory' }),
    );

    expect(result.error?.status).toBe(400);
    await expect(result.error?.json()).resolves.toMatchObject({
      errorCode: 'PROJECT_PATH_NOT_DIRECTORY',
      retryable: false,
    });
  });

  it('preserves the permission-denied response contract', async () => {
    const result = await resolveAccessibleProjectPath(
      PROJECT_PATH,
      async () => ({ kind: 'unavailable', reason: 'permission-denied' }),
    );

    expect(result.error?.status).toBe(403);
    await expect(result.error?.json()).resolves.toMatchObject({
      error: `Project folder cannot be accessed: ${PROJECT_PATH}`,
      errorCode: 'VALIDATION_FAILED',
      retryable: false,
    });
  });
});
