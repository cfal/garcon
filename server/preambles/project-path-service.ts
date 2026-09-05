import { promises as fs } from 'node:fs';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { PreambleDomainError } from './errors.js';

function accessError(error: unknown, projectPath: string): PreambleDomainError | null {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    return new PreambleDomainError(
      'PREAMBLE_PROJECT_PATH_NOT_FOUND',
      `Project path not found: ${projectPath}`,
      404,
    );
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new PreambleDomainError(
      'PREAMBLE_PROJECT_PATH_INACCESSIBLE',
      `Project path is not accessible: ${projectPath}`,
      403,
    );
  }
  return null;
}

export class PreambleProjectPathService {
  async resolve(projectPath: string): Promise<string> {
    let canonicalPath: string;
    try {
      canonicalPath = await assertRealWithinProjectBase(projectPath.trim());
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        throw new PreambleDomainError(
          'PREAMBLE_PROJECT_PATH_OUTSIDE_BASE',
          'Project path is outside the allowed base directory',
          403,
        );
      }
      const mapped = accessError(error, projectPath);
      if (mapped) throw mapped;
      throw error;
    }
    try {
      if (!(await fs.stat(canonicalPath)).isDirectory()) {
        throw new PreambleDomainError(
          'PREAMBLE_PROJECT_PATH_NOT_DIRECTORY',
          `Project path is not a directory: ${canonicalPath}`,
          400,
        );
      }
    } catch (error) {
      if (error instanceof PreambleDomainError) throw error;
      const mapped = accessError(error, canonicalPath);
      if (mapped) throw mapped;
      throw error;
    }
    return canonicalPath;
  }
}
