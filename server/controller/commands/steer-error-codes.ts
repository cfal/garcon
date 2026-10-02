import type { CommandErrorCode } from '../../../common/chat-command-contracts.js';

const STEER_ERROR_STATUSES: Readonly<Partial<Record<CommandErrorCode, number>>> = {
  VALIDATION_FAILED: 400,
  SESSION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  OPERATION_UNSUPPORTED: 422,
  SERVER_SHUTTING_DOWN: 503,
  EXECUTOR_UNAVAILABLE: 503,
  STEER_NOT_DELIVERED: 500,
  STEER_OUTCOME_UNKNOWN: 500,
  STEER_PROVIDER_REJECTED: 409,
  STEER_TURN_UNAVAILABLE: 409,
  STEER_TURN_CHANGED: 409,
  STEER_TURN_NOT_STEERABLE: 409,
  STEER_CAPACITY_EXHAUSTED: 503,
};

const QUEUE_STEER_ERROR_STATUSES: Readonly<Partial<Record<CommandErrorCode, number>>> = {
  ...STEER_ERROR_STATUSES,
  QUEUE_ENTRY_NOT_FOUND: 404,
  QUEUE_ENTRY_ALREADY_SENT: 409,
  QUEUE_ENTRY_IN_FLIGHT: 409,
  QUEUE_ENTRY_REVISION_CONFLICT: 409,
  QUEUE_ENTRY_REORDER_CONFLICT: 409,
  QUEUE_STEER_FINALIZATION_FAILED: 500,
  QUEUE_STEER_RECOVERY_FAILED: 500,
};

export function steerErrorCode(value: string | undefined): CommandErrorCode {
  if (value !== undefined && Object.hasOwn(STEER_ERROR_STATUSES, value)) return value as CommandErrorCode;
  return 'INTERNAL_ERROR';
}

export function queueSteerErrorCode(value: string | undefined): CommandErrorCode {
  if (value !== undefined && Object.hasOwn(QUEUE_STEER_ERROR_STATUSES, value)) return value as CommandErrorCode;
  return 'INTERNAL_ERROR';
}

export function steerErrorStatus(code: CommandErrorCode): number {
  return QUEUE_STEER_ERROR_STATUSES[code] ?? 500;
}
