import { DomainError } from '../../common/domain-error.js';

export function reviewStorageUnavailable(): DomainError {
  return new DomainError('PULL_REQUEST_REVIEW_STORAGE_UNAVAILABLE', 'Pull request review storage is unavailable until the controller restarts.', 503);
}

export function reviewInvalid(message: string): DomainError {
  return new DomainError('PULL_REQUEST_REVIEW_VALIDATION_FAILED', message, 400);
}

export function reviewNotFound(subject: 'Repository' | 'Review' | 'Pull request'): DomainError {
  return new DomainError('PULL_REQUEST_REVIEW_NOT_FOUND', `${subject} not found`, 404);
}

export function reviewConflict(message: string): DomainError {
  return new DomainError('PULL_REQUEST_REVIEW_CONFLICT', message, 409);
}
