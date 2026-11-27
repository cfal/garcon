import { DomainError, ValidationDomainError } from '../../common/domain-error.js';

export function workflowInvalid(message: string): DomainError {
  return new ValidationDomainError(message);
}

export function workflowConflict(message: string): DomainError {
  return new DomainError('WORKFLOW_CONFLICT', message, 409);
}

export function workflowNotFound(subject: string): DomainError {
  return new DomainError('WORKFLOW_NOT_FOUND', `${subject} was not found.`, 404);
}

export function workflowLimit(message: string): DomainError {
  return new DomainError('WORKFLOW_LIMIT', message, 409);
}
