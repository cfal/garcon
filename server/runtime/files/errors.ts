import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { hasNodeErrorCode } from '../../common/errors.js';
import { isProjectBoundaryError } from '../../common/path-boundary.js';

export function fileOperationError(error: unknown): unknown {
  if (isProjectBoundaryError(error)) return new DomainError('FILE_OUTSIDE_ROOT', 'Path must be under project root', 403);
  if (hasNodeErrorCode(error, 'ENOENT') || hasNodeErrorCode(error, 'ENOTDIR')) {
    return new DomainError('FILE_NOT_FOUND', 'File or directory not found', 404);
  }
  if (hasNodeErrorCode(error, 'EACCES') || hasNodeErrorCode(error, 'EPERM')) {
    return new DomainError('FILE_PERMISSION_DENIED', 'Permission denied', 403);
  }
  if (hasNodeErrorCode(error, 'ELOOP')) return fileRevisionConflict();
  return error;
}

// Other failures keep their codes so the shared mapping reports missing parents and permissions.
export function directoryCreationError(error: unknown): unknown {
  if (hasNodeErrorCode(error, 'EEXIST')) {
    return new DomainError('FILE_ALREADY_EXISTS', 'A file or directory with that name already exists', 409);
  }
  if (hasNodeErrorCode(error, 'ENAMETOOLONG') || hasNodeErrorCode(error, 'EINVAL')) {
    return new ValidationDomainError('Directory name is not valid on this filesystem');
  }
  if (hasNodeErrorCode(error, 'EROFS')) return new DomainError('FILE_PERMISSION_DENIED', 'Permission denied', 403);
  return error;
}

export function fileRevisionConflict(): DomainError {
  return new DomainError('FILE_REVISION_CONFLICT', 'File changed on disk', 409);
}
