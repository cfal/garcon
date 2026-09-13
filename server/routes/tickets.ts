import { parseHttpTicketMutationRequest } from '../../common/ticket-commands.js';
import { ticketQueryParams } from '../../common/ticket-query.js';
import { ticketRecord, ticketString } from '../../common/ticket-validation.js';
import { deriveTicketCaller } from '../tickets/contracts.js';
import { TicketDomainError, validateTicketInput } from '../tickets/errors.js';
import { ticketErrorResponse, ticketJson, readTicketBody, requireTicketPrincipal } from '../tickets/http.js';
import { resolveTicketProjectDefault } from '../tickets/project-default.js';
import type { TicketRuntime } from '../tickets/setup.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { markRouteNoStore } from '../lib/http-route.js';

function authenticated(handler: RouteHandler): RouteHandler {
  return markRouteNoStore(async (request, url, server, context) => {
    try {
      requireTicketPrincipal(context);
      request.signal.throwIfAborted();
      return await handler(request, url, server, context);
    } catch (error) {
      return ticketErrorResponse(error);
    }
  });
}

export function createTicketRoutes(tickets: TicketRuntime,
  projectDefault = resolveTicketProjectDefault): RouteMap {
  const query = (url: URL) => validateTicketInput(() => ticketQueryParams(url.searchParams));
  return {
    '/api/v1/tickets/bootstrap': { GET: authenticated((_request, url, _server, context) => {
      validateTicketInput(() => ticketRecord(query(url), []));
      return ticketJson(tickets.service.bootstrap(deriveTicketCaller(requireTicketPrincipal(context)).authority));
    }) },
    '/api/v1/tickets': { GET: authenticated((_request, url) => ticketJson(tickets.service.list(query(url)))) },
    '/api/v1/tickets/counts': { GET: authenticated((_request, url) => ticketJson(tickets.service.counts(query(url)))) },
    '/api/v1/tickets/detail': { GET: authenticated((_request, url, _server, context) =>
      ticketJson(tickets.service.read(query(url), deriveTicketCaller(requireTicketPrincipal(context)).authority))) },
    '/api/v1/tickets/comments': { GET: authenticated((_request, url, _server, context) =>
      ticketJson(tickets.service.comments(query(url), deriveTicketCaller(requireTicketPrincipal(context)).authority))) },
    '/api/v1/tickets/history': { GET: authenticated((_request, url) => ticketJson(tickets.service.history(query(url)))) },
    '/api/v1/tickets/facets': { GET: authenticated((_request, url) => {
      const raw = validateTicketInput(() => ticketRecord(query(url), ['field', 'prefix']));
      if (raw.field !== 'project' && raw.field !== 'label') {
        throw new TicketDomainError('TICKET_VALIDATION_FAILED', 'Facet field must be project or label.');
      }
      const prefix = validateTicketInput(() => ticketString(raw.prefix ?? '', 'prefix'));
      return ticketJson(tickets.service.facets(raw.field, prefix));
    }) },
    '/api/v1/tickets/project-default': { POST: authenticated(async (request) => {
      const raw = await readTicketBody(request);
      const directory = validateTicketInput(() => ticketString(ticketRecord(raw, ['directory']).directory, 'directory'));
      return ticketJson(await projectDefault(directory, request.signal));
    }) },
    '/api/v1/tickets/mutate': { POST: authenticated(async (request, _url, _server, context) => {
      const raw = await readTicketBody(request);
      const envelope = validateTicketInput(() => parseHttpTicketMutationRequest(raw));
      const caller = deriveTicketCaller(requireTicketPrincipal(context), envelope.fromChatId);
      const result = tickets.service.executeHttp(envelope, caller, request.signal);
      return ticketJson(result, envelope.payload.action === 'create' ? 201 : 200);
    }) },
  };
}
