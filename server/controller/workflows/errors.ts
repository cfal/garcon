import { WorkflowValidationError } from '../../../common/workflow-validation.js';
import { DomainError } from '../../common/domain-error.js';

export function workflowUnavailable(): DomainError {
  return new DomainError('WORKFLOW_UNAVAILABLE', 'Workflow storage is unavailable. Ordinary chats remain available.', 503);
}
export function workflowConflict(message: string): never { throw new DomainError('WORKFLOW_CONFLICT', message, 409); }
export function validateWorkflowInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof WorkflowValidationError) throw new DomainError('WORKFLOW_INVALID_PLAN', error.message, 400);
    throw error;
  }
}
