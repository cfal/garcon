import type { CommandErrorCode } from '../../../common/chat-command-contracts.js';
import { CommandValidationError } from './command-validation-error.js';

export type PermissionDecisionErrorCode = Extract<
  CommandErrorCode,
  'PERMISSION_NOT_ACTIONABLE' | 'PERMISSION_DECISION_NOT_DELIVERED' | 'PERMISSION_DECISION_OUTCOME_UNKNOWN'
>;

const FAILURES: Record<PermissionDecisionErrorCode, {
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
}> = {
  PERMISSION_NOT_ACTIONABLE: {
    message: 'This permission request is no longer actionable',
    status: 409,
    retryable: false,
  },
  PERMISSION_DECISION_NOT_DELIVERED: {
    message: 'The executor is unavailable, so the permission decision was not sent. The request is still pending; answer it again once the executor reconnects.',
    status: 503,
    retryable: true,
  },
  PERMISSION_DECISION_OUTCOME_UNKNOWN: {
    message: 'Permission decision delivery could not be confirmed. Inspect the chat before deciding what to do next.',
    status: 500,
    retryable: false,
  },
};

export function permissionDecisionError(code: PermissionDecisionErrorCode): CommandValidationError {
  const failure = FAILURES[code];
  return new CommandValidationError(code, failure.message, failure.status, failure.retryable);
}
