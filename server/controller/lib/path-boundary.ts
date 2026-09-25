import path from 'node:path';
import { getProjectBasePath } from '../config.js';
import { jsonError } from '../../common/http-error.js';
import { assertRealWithinBase, ProjectBoundaryError, PROJECT_BOUNDARY_ERROR_CODE, PROJECT_BOUNDARY_ERROR_MESSAGE } from '../../common/path-boundary.js';

export function isWithinProjectBase(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(getProjectBasePath());
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return resolved === base || resolved.startsWith(prefix);
}

export async function assertRealWithinProjectBase(targetPath: string): Promise<string> {
  return assertRealWithinBase(path.resolve(getProjectBasePath()), targetPath);
}

export function assertWithinProjectBase(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!isWithinProjectBase(resolved)) throw new ProjectBoundaryError();
  return resolved;
}

export function projectBoundaryErrorResponse(): Response {
  return jsonError(PROJECT_BOUNDARY_ERROR_MESSAGE, 403, PROJECT_BOUNDARY_ERROR_CODE);
}
