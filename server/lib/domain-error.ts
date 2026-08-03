import type { ErrorCode } from '../../common/error-codes.ts';
import type {
  CommandErrorCode,
  SteerDeliveryOutcome,
} from '../../common/chat-command-contracts.ts';
import {
  cloneStoredChatExecutionControl,
  type StoredChatExecutionControlState,
} from '../chat-execution/control-state.ts';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, status = 400, retryable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class ValidationDomainError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, 400);
    this.name = 'ValidationDomainError';
  }
}

export const STEER_NOT_DELIVERED_MESSAGE = 'Steering input was not delivered.';
export const STEER_OUTCOME_UNKNOWN_MESSAGE =
  'Steering delivery could not be confirmed. Check the chat before sending it again.';
export const QUEUE_STEER_FINALIZATION_FAILED_MESSAGE =
  'Steering was accepted, but the queued message could not be finalized. The queue was paused for review.';
export const QUEUE_STEER_RECOVERY_FAILED_MESSAGE =
  'Steering was not delivered, and the queued message could not be restored safely. Refresh before continuing.';
export const GOAL_CONTROL_NOT_DELIVERED_MESSAGE = 'Goal control was not delivered. Retry the request.';
export const GOAL_CONTROL_OUTCOME_UNKNOWN_MESSAGE =
  'Goal control delivery could not be confirmed after acceptance. Check the chat before sending it again.';
export const TRANSCRIPT_UNAVAILABLE_MESSAGE = 'Chat transcript is unavailable.';
export const TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Chat transcript is temporarily unavailable. Retry the request.';

export function transcriptUnavailableMessage(retryable: boolean): string {
  return retryable
    ? TRANSCRIPT_TEMPORARILY_UNAVAILABLE_MESSAGE
    : TRANSCRIPT_UNAVAILABLE_MESSAGE;
}

export class SteerDeliveryError extends DomainError {
  readonly outcome: 'not-sent' | 'unknown';

  constructor(error: unknown, outcome: 'not-sent' | 'unknown') {
    super(
      outcome === 'unknown' ? 'STEER_OUTCOME_UNKNOWN' : 'STEER_NOT_DELIVERED',
      outcome === 'unknown' ? STEER_OUTCOME_UNKNOWN_MESSAGE : STEER_NOT_DELIVERED_MESSAGE,
      500,
      false,
      { cause: error },
    );
    this.name = 'SteerDeliveryError';
    this.outcome = outcome;
  }
}

export class QueueEntrySteerError extends DomainError {
  override readonly code: CommandErrorCode;
  readonly deliveryOutcome: SteerDeliveryOutcome;
  readonly control?: StoredChatExecutionControlState;

  constructor(
    code: CommandErrorCode,
    message: string,
    status: number,
    deliveryOutcome: SteerDeliveryOutcome,
    control?: StoredChatExecutionControlState,
    options?: ErrorOptions,
  ) {
    super(code, message, status, false, options);
    this.name = 'QueueEntrySteerError';
    this.code = code;
    this.deliveryOutcome = deliveryOutcome;
    this.control = control ? cloneStoredChatExecutionControl(control) : undefined;
  }
}

export class GoalControlDeliveryError extends DomainError {
  readonly deliveryAccepted: boolean;

  constructor(error: unknown, deliveryAccepted: boolean) {
    super(
      deliveryAccepted ? 'GOAL_CONTROL_OUTCOME_UNKNOWN' : 'GOAL_CONTROL_NOT_DELIVERED',
      deliveryAccepted ? GOAL_CONTROL_OUTCOME_UNKNOWN_MESSAGE : GOAL_CONTROL_NOT_DELIVERED_MESSAGE,
      500,
      !deliveryAccepted,
      { cause: error },
    );
    this.name = 'GoalControlDeliveryError';
    this.deliveryAccepted = deliveryAccepted;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
