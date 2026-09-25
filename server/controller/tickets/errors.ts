import { TicketDomainError } from '../../common/ticket-error.js';

export function ticketStorageUnavailable(): TicketDomainError {
  return new TicketDomainError('TICKET_STORAGE_UNAVAILABLE', 'Ticket storage is unavailable. Restart the server or restore a valid database.');
}

export function nextTicketCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) {
    throw new TicketDomainError('TICKET_LIMIT_REACHED', 'The ticket counter limit has been reached.');
  }
  return value + 1;
}
