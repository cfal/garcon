import { ticketSource, TicketValidationError } from '../../common/ticket-validation.js';
import type { TicketSource } from '../../common/tickets.js';
import type { IChatRegistry } from '../chats/store.js';
import type { TicketSourceReader } from '../chats/chat-message-reader.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { markRouteNoStore } from '../lib/http-route.js';
import type { RouteMap } from '../lib/http-route-types.js';

function parseSourceQuery(searchParams: URLSearchParams): TicketSource {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of searchParams) {
    if (key in raw) throw new ValidationDomainError('Duplicate source field');
    raw[key] = key === 'ordinal' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  }
  return ticketSource(raw);
}

export function createChatTicketSourceRoutes(
  registry: Pick<IChatRegistry, 'hasChat'>,
  reader: TicketSourceReader,
): RouteMap {
  return {
    '/api/v1/chats/ticket-source': {
      GET: markRouteNoStore(async (request, url) => {
        const response = await resolve(request, url);
        response.headers.set('Cache-Control', 'no-store');
        return response;
      }),
    },
  };

  async function resolve(request: Request, url: URL): Promise<Response> {
    try {
      const source = parseSourceQuery(url.searchParams);
      request.signal.throwIfAborted();
      if (!registry.hasChat(source.chatId)) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }
      const result = await reader.resolveTicketSource(source, request.signal);
      request.signal.throwIfAborted();
      if (!registry.hasChat(source.chatId)) {
        return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      }
      return Response.json(result);
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 });
      if (error instanceof TicketValidationError) {
        return jsonErrorFromUnknown(new ValidationDomainError(error.message));
      }
      return jsonErrorFromUnknown(error);
    }
  }
}
