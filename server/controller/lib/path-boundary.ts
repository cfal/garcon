import path from 'node:path';
import { getProjectBasePath } from '../config.js';
import { jsonError } from '../../common/http-error.js';
import { assertRealWithinBase, PROJECT_BOUNDARY_ERROR_CODE, PROJECT_BOUNDARY_ERROR_MESSAGE } from '../../common/path-boundary.js';

export async function assertRealWithinProjectBase(targetPath: string): Promise<string> {
  return assertRealWithinBase(path.resolve(getProjectBasePath()), targetPath);
}

export function projectBoundaryErrorResponse(): Response {
  return jsonError(PROJECT_BOUNDARY_ERROR_MESSAGE, 403, PROJECT_BOUNDARY_ERROR_CODE);
}
