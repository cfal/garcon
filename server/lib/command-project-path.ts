import { promises as fs } from 'node:fs';
import { CommandValidationError } from './command-validation-error.js';
import { hasNodeErrorCode } from './errors.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from './path-boundary.js';

export async function resolveStartProjectPath(projectPath: string | undefined): Promise<string> {
  const requestedPath = requiredProjectPath(projectPath);
  const resolvedPath = await resolveCanonicalProjectPath(requestedPath, 'VALIDATION_FAILED');
  try {
    await fs.access(resolvedPath);
  } catch {
    throw projectPathNotFound('VALIDATION_FAILED', resolvedPath);
  }
  return resolvedPath;
}

export async function resolveUpdatedProjectPath(projectPath: string): Promise<string> {
  const requestedPath = requiredProjectPath(projectPath);
  const resolvedPath = await resolveCanonicalProjectPath(requestedPath, 'PROJECT_PATH_NOT_FOUND');
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT') || hasNodeErrorCode(error, 'ENOTDIR')) {
      throw projectPathNotFound('PROJECT_PATH_NOT_FOUND', resolvedPath);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new CommandValidationError(
      'PROJECT_PATH_NOT_DIRECTORY',
      `Project path is not a directory: ${resolvedPath}`,
      400,
    );
  }
  return resolvedPath;
}

function requiredProjectPath(projectPath: string | undefined): string {
  const requestedPath = String(projectPath || '').trim();
  if (!requestedPath) {
    throw new CommandValidationError('VALIDATION_FAILED', 'projectPath is required');
  }
  return requestedPath;
}

async function resolveCanonicalProjectPath(
  requestedPath: string,
  notFoundCode: 'VALIDATION_FAILED' | 'PROJECT_PATH_NOT_FOUND',
): Promise<string> {
  try {
    return await assertRealWithinProjectBase(requestedPath);
  } catch (error) {
    if (isProjectBoundaryError(error)) {
      throw new CommandValidationError(
        'PROJECT_PATH_OUTSIDE_BASE',
        'Project path is outside the allowed base directory',
        403,
      );
    }
    if (hasNodeErrorCode(error, 'ENOENT') || hasNodeErrorCode(error, 'ENOTDIR')) {
      throw projectPathNotFound(notFoundCode, requestedPath);
    }
    throw error;
  }
}

function projectPathNotFound(
  code: 'VALIDATION_FAILED' | 'PROJECT_PATH_NOT_FOUND',
  projectPath: string,
): CommandValidationError {
  return new CommandValidationError(code, `Project path not found: ${projectPath}`, 404);
}
