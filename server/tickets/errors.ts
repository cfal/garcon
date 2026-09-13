import type { Ticket, TicketComment, TicketErrorCode } from '../../common/tickets.js';
import { TicketValidationError } from '../../common/ticket-validation.js';
import { DomainError } from '../lib/domain-error.js';

export const TICKET_ERROR_POLICY: Readonly<Record<TicketErrorCode, { status: number; retryable: boolean }>> = {
  TICKET_VALIDATION_FAILED: { status: 400, retryable: false },
  TICKET_UNAUTHORIZED: { status: 401, retryable: false },
  TICKET_FORBIDDEN: { status: 403, retryable: false },
  TICKET_COMMANDS_DISABLED: { status: 403, retryable: false },
  TICKET_NOT_FOUND: { status: 404, retryable: false },
  TICKET_COMMENT_NOT_FOUND: { status: 404, retryable: false },
  TICKET_CHAT_NOT_FOUND: { status: 404, retryable: false },
  TICKET_STORE_CHANGED: { status: 409, retryable: false },
  TICKET_REVISION_CONFLICT: { status: 409, retryable: false },
  TICKET_COMMENT_REVISION_CONFLICT: { status: 409, retryable: false },
  TICKET_ALREADY_CLAIMED: { status: 409, retryable: false },
  TICKET_REQUEST_CONFLICT: { status: 409, retryable: false },
  TICKET_COLLECTION_CHANGED: { status: 409, retryable: true },
  TICKET_RELATIONSHIP_CYCLE: { status: 409, retryable: false },
  TICKET_INVALID_TRANSITION: { status: 409, retryable: false },
  TICKET_LIMIT_REACHED: { status: 409, retryable: false },
  TICKET_SOURCE_UNAVAILABLE: { status: 409, retryable: false },
  TICKET_REQUEST_TOO_LARGE: { status: 413, retryable: false },
  TICKET_RESULT_TOO_LARGE: { status: 413, retryable: false },
  TICKET_PROJECT_UNAVAILABLE: { status: 503, retryable: true },
  TICKET_STORAGE_UNAVAILABLE: { status: 503, retryable: false },
  TICKET_INTERNAL_ERROR: { status: 500, retryable: false },
};

export class TicketDomainError extends DomainError {
  override readonly code: TicketErrorCode;

  constructor(code: TicketErrorCode, message: string,
    readonly currentTicket?: Ticket, readonly currentComment?: TicketComment) {
    const policy = TICKET_ERROR_POLICY[code];
    super(code, message, policy.status, policy.retryable);
    this.code = code;
    this.name = 'TicketDomainError';
  }
}

export function validateTicketInput<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof TicketValidationError) throw new TicketDomainError('TICKET_VALIDATION_FAILED', error.message);
    throw error;
  }
}

export function ticketStorageUnavailable(): TicketDomainError {
  return new TicketDomainError('TICKET_STORAGE_UNAVAILABLE', 'Ticket storage is unavailable. Restart the server or restore a valid database.');
}

export function nextTicketCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) {
    throw new TicketDomainError('TICKET_LIMIT_REACHED', 'The ticket counter limit has been reached.');
  }
  return value + 1;
}
