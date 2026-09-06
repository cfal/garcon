import { describe, expect, it } from 'bun:test';
import {
  resolveStartProjectPath,
  resolveUpdatedProjectPath,
} from '../command-project-path.ts';

const PROJECT_PATH = '/workspace/project';

describe('command project path resolution', () => {
  it('returns the canonical path from a successful inspection', async () => {
    const inspect = async () => ({
      kind: 'available',
      effectiveProjectKey: '/real/project',
    });

    await expect(resolveStartProjectPath(PROJECT_PATH, inspect)).resolves.toBe('/real/project');
    await expect(resolveUpdatedProjectPath(PROJECT_PATH, inspect)).resolves.toBe('/real/project');
  });

  it('preserves caller-specific errors for every unavailable reason', async () => {
    const cases = [
      {
        reason: 'not-found',
        start: {
          code: 'VALIDATION_FAILED',
          status: 404,
          message: `Project path not found: ${PROJECT_PATH}`,
        },
        update: {
          code: 'PROJECT_PATH_NOT_FOUND',
          status: 404,
          message: `Project path not found: ${PROJECT_PATH}`,
        },
      },
      {
        reason: 'not-a-directory',
        start: {
          code: 'VALIDATION_FAILED',
          status: 400,
          message: `Project path is not a directory: ${PROJECT_PATH}`,
        },
        update: {
          code: 'PROJECT_PATH_NOT_DIRECTORY',
          status: 400,
          message: `Project path is not a directory: ${PROJECT_PATH}`,
        },
      },
      {
        reason: 'outside-base',
        start: {
          code: 'PROJECT_PATH_OUTSIDE_BASE',
          status: 403,
          message: 'Project path is outside the allowed base directory',
        },
        update: {
          code: 'PROJECT_PATH_OUTSIDE_BASE',
          status: 403,
          message: 'Project path is outside the allowed base directory',
        },
      },
      {
        reason: 'permission-denied',
        start: {
          code: 'VALIDATION_FAILED',
          status: 403,
          message: `Project folder cannot be accessed: ${PROJECT_PATH}`,
        },
        update: {
          code: 'VALIDATION_FAILED',
          status: 403,
          message: `Project folder cannot be accessed: ${PROJECT_PATH}`,
        },
      },
    ];

    for (const entry of cases) {
      const inspect = async () => ({ kind: 'unavailable', reason: entry.reason });
      await expect(resolveStartProjectPath(PROJECT_PATH, inspect)).rejects.toMatchObject(entry.start);
      await expect(resolveUpdatedProjectPath(PROJECT_PATH, inspect)).rejects.toMatchObject(
        entry.update,
      );
    }
  });
});
