import { CommandValidationError } from './command-validation-error.js';
import type { ProjectUnavailableReason } from '../../common/project-resolution.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';

export async function resolveStartProjectPath(projectPath: string | undefined): Promise<string> {
  const requestedPath = requiredProjectPath(projectPath);
  const resolution = await inspectProjectDirectory(requestedPath);
  if (resolution.kind === 'unavailable') throw startPathError(requestedPath, resolution.reason);
  return resolution.effectiveProjectKey;
}

export async function resolveUpdatedProjectPath(projectPath: string): Promise<string> {
  const requestedPath = requiredProjectPath(projectPath);
  const resolution = await inspectProjectDirectory(requestedPath);
  if (resolution.kind === 'unavailable') throw updatePathError(requestedPath, resolution.reason);
  return resolution.effectiveProjectKey;
}

function requiredProjectPath(projectPath: string | undefined): string {
  const requestedPath = String(projectPath || '').trim();
  if (!requestedPath) {
    throw new CommandValidationError('VALIDATION_FAILED', 'projectPath is required');
  }
  return requestedPath;
}

function projectPathNotFound(
  code: 'VALIDATION_FAILED' | 'PROJECT_PATH_NOT_FOUND',
  projectPath: string,
): CommandValidationError {
  return new CommandValidationError(code, `Project path not found: ${projectPath}`, 404);
}

function startPathError(
  projectPath: string,
  reason: ProjectUnavailableReason,
): CommandValidationError {
  if (reason === 'not-found') return projectPathNotFound('VALIDATION_FAILED', projectPath);
  if (reason === 'not-a-directory') {
    return new CommandValidationError(
      'VALIDATION_FAILED',
      `Project path is not a directory: ${projectPath}`,
      400,
    );
  }
  if (reason === 'outside-base') return outsideBaseError();
  return inaccessiblePathError(projectPath);
}

function updatePathError(
  projectPath: string,
  reason: ProjectUnavailableReason,
): CommandValidationError {
  if (reason === 'not-found') return projectPathNotFound('PROJECT_PATH_NOT_FOUND', projectPath);
  if (reason === 'not-a-directory') {
    return new CommandValidationError(
      'PROJECT_PATH_NOT_DIRECTORY',
      `Project path is not a directory: ${projectPath}`,
      400,
    );
  }
  if (reason === 'outside-base') return outsideBaseError();
  return inaccessiblePathError(projectPath);
}

function outsideBaseError(): CommandValidationError {
  return new CommandValidationError(
    'PROJECT_PATH_OUTSIDE_BASE',
    'Project path is outside the allowed base directory',
    403,
  );
}

function inaccessiblePathError(projectPath: string): CommandValidationError {
  return new CommandValidationError(
    'VALIDATION_FAILED',
    `Project folder cannot be accessed: ${projectPath}`,
    403,
  );
}
