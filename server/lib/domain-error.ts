export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status = 400, retryable = false, options?: ErrorOptions) {
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

export const ACTIVE_INPUT_NOT_DELIVERED_MESSAGE = 'Active input was not delivered. Retry the request.';
export const ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE =
  'Active input delivery could not be confirmed after acceptance. Check the chat before sending it again.';

export class ActiveInputDeliveryError extends DomainError {
  readonly deliveryAccepted: boolean;

  constructor(error: unknown, deliveryAccepted: boolean) {
    super(
      'INTERNAL_ERROR',
      deliveryAccepted ? ACTIVE_INPUT_OUTCOME_UNKNOWN_MESSAGE : ACTIVE_INPUT_NOT_DELIVERED_MESSAGE,
      500,
      !deliveryAccepted,
      { cause: error },
    );
    this.name = 'ActiveInputDeliveryError';
    this.deliveryAccepted = deliveryAccepted;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
