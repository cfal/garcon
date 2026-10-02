import { jsonError } from '../../common/http-error.js';
import { PROJECT_BOUNDARY_ERROR_CODE, PROJECT_BOUNDARY_ERROR_MESSAGE } from '../../common/path-boundary.js';

export function projectBoundaryErrorResponse(): Response {
  return jsonError(PROJECT_BOUNDARY_ERROR_MESSAGE, 403, PROJECT_BOUNDARY_ERROR_CODE);
}
