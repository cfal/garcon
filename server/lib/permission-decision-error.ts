import type { CommandErrorCode } from '../../common/chat-command-contracts.js';
import { CommandValidationError } from './command-validation-error.js';

export type PermissionDecisionErrorCode = Extract<
  CommandErrorCode,
  'PERMISSION_NOT_ACTIONABLE' | 'PERMISSION_DECISION_OUTCOME_UNKNOWN'
>;

const MESSAGES: Record<PermissionDecisionErrorCode, string> = {
  PERMISSION_NOT_ACTIONABLE: 'This permission request is no longer actionable',
  PERMISSION_DECISION_OUTCOME_UNKNOWN:
    'Permission decision delivery could not be confirmed. Inspect the chat before deciding what to do next.',
};

export function permissionDecisionError(code: PermissionDecisionErrorCode): CommandValidationError {
  return new CommandValidationError(
    code,
    MESSAGES[code],
    code === 'PERMISSION_NOT_ACTIONABLE' ? 409 : 500,
    false,
  );
}
