import { TicketDomainError, validateTicketInput } from "../../../server/common/ticket-error.ts";
import { ticketString } from "../../../common/ticket-validation.ts";
import type { Ticket, TicketComment, TicketErrorCode } from "../../../common/tickets.ts";

function project(error: TicketDomainError) {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    currentTicket: error.currentTicket,
    currentComment: error.currentComment,
  };
}

export function ticketDomainErrorFixture(
  code: TicketErrorCode,
  message: string,
  currentTicket?: Ticket,
  currentComment?: TicketComment,
) {
  return project(new TicketDomainError(code, message, currentTicket, currentComment));
}

export function validateTicketInputFixture(value: unknown, plain = false) {
  try {
    return validateTicketInput(() => {
      if (plain) throw new Error("synthetic non-ticket error");
      return ticketString(value, "directory");
    });
  } catch (error) {
    if (error instanceof TicketDomainError) return project(error);
    throw error;
  }
}
