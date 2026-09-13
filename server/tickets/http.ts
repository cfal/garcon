import type { Ticket, TicketComment, TicketErrorCode } from '../../common/tickets.js';
import { TICKET_LIMITS } from '../../common/tickets.js';
import type { HttpRouteContext, ServerPrincipal } from '../lib/http-route-types.js';
import { isDomainError } from '../lib/domain-error.js';
import { createLogger } from '../lib/log.js';
import { TicketDomainError } from './errors.js';

export function requireTicketPrincipal(context?: HttpRouteContext): ServerPrincipal {
  if (!context?.principal) throw new TicketDomainError('TICKET_UNAUTHORIZED', 'Sign in to use Tickets.');
  return context.principal;
}

export function ticketJson(value: unknown, status = 200): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > TICKET_LIMITS.httpBytes) {
    throw new TicketDomainError('TICKET_RESULT_TOO_LARGE', 'Ticket response exceeds the transport limit. Request less content.');
  }
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function ticketErrorResponse(error: unknown): Response {
  if (isDomainError(error)) {
    const conflict = error instanceof TicketDomainError ? error : null;
    const payload: { success: false; error: string; errorCode: string; retryable: boolean;
      currentTicket?: Ticket; currentComment?: TicketComment } = {
      success: false, error: error.message, errorCode: error.code, retryable: error.retryable,
      ...(conflict?.currentTicket ? { currentTicket: conflict.currentTicket } : {}),
      ...(conflict?.currentComment ? { currentComment: conflict.currentComment } : {}),
    };
    return ticketJson(payload, error.status);
  }
  createLogger('tickets').warn('Unexpected ticket request failure.');
  return ticketJson({ success: false, error: 'Ticket request could not be completed.',
    errorCode: 'TICKET_INTERNAL_ERROR' satisfies TicketErrorCode, retryable: false }, 500);
}

export async function readTicketBody(request: Request): Promise<unknown> {
  const tooLarge = () => new TicketDomainError('TICKET_REQUEST_TOO_LARGE',
    'Encoded ticket request exceeds 64 KiB. Reduce the submitted body.');
  const length = request.headers.get('content-length');
  if (length && Number(length) > TICKET_LIMITS.requestBytes) throw tooLarge();
  if (!request.body) throw new TicketDomainError('TICKET_VALIDATION_FAILED', 'A JSON body is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  let finished = false;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > TICKET_LIMITS.requestBytes) throw tooLarge();
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new TicketDomainError('TICKET_VALIDATION_FAILED', 'A valid UTF-8 JSON body is required.');
    }
    throw error;
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
