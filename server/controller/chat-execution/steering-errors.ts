import { DomainError } from '../../common/domain-error.js';


export const STEER_NOT_DELIVERED_MESSAGE = 'Steering input was not delivered.';
export const STEER_OUTCOME_UNKNOWN_MESSAGE =
  'Steering delivery could not be confirmed. Check the chat before sending it again.';
export const QUEUE_STEER_FINALIZATION_FAILED_MESSAGE =
  'Steering was accepted, but the queued message could not be finalized. The queue was paused for review.';
export const QUEUE_STEER_RECOVERY_FAILED_MESSAGE =
  'Steering was not delivered, and the queued message could not be restored safely. Refresh before continuing.';

export function steeringUnsupportedError(): DomainError {
  return new DomainError('OPERATION_UNSUPPORTED', 'This agent does not support steering', 422);
}

export function steerTurnChangedError(): DomainError {
  return new DomainError(
    'STEER_TURN_CHANGED',
    'The active turn changed before steering could be applied',
    409,
  );
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
