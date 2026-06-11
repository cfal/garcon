import path from 'path';
import { getProjectBasePath } from '../config.js';

export const PROJECT_BOUNDARY_ERROR_CODE = 'outside_project_base';
export const PROJECT_BOUNDARY_ERROR_MESSAGE = 'Path is outside the allowed base directory';

export class ProjectBoundaryError extends Error {
  readonly errorCode = PROJECT_BOUNDARY_ERROR_CODE;
  readonly status = 403;

  constructor(message = PROJECT_BOUNDARY_ERROR_MESSAGE) {
    super(message);
    this.name = 'ProjectBoundaryError';
  }
}

function normalizedProjectBase(): string {
  return path.resolve(getProjectBasePath());
}

export function isWithinProjectBase(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const projectBasePath = normalizedProjectBase();
  const projectBasePathPrefix = projectBasePath.endsWith(path.sep)
    ? projectBasePath
    : `${projectBasePath}${path.sep}`;
  return resolved === projectBasePath || resolved.startsWith(projectBasePathPrefix);
}

export function assertWithinProjectBase(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!isWithinProjectBase(resolved)) {
    throw new ProjectBoundaryError();
  }
  return resolved;
}

export function isProjectBoundaryError(error: unknown): error is ProjectBoundaryError {
  return error instanceof ProjectBoundaryError;
}

export function projectBoundaryErrorResponse(): Response {
  return Response.json(
    {
      error: PROJECT_BOUNDARY_ERROR_MESSAGE,
      errorCode: PROJECT_BOUNDARY_ERROR_CODE,
    },
    { status: 403 },
  );
}
