import { InvalidChatIdError, parseChatId } from '../../common/chat-id.js';
import {
  CommandRequestValidationError,
} from '../../common/command-request-validation.js';
import { parseAddChatRowRequest } from '../../common/chat-row-contracts.js';
import type { ChatRowService } from '../chats/chat-row-service.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

export function createChatRowRoutes(service: ChatRowService): RouteMap {
  async function getTarget(request: Request, url: URL): Promise<Response> {
    try {
      const rawChatId = url.searchParams.get('chatId');
      if (!rawChatId) throw new ValidationDomainError('chatId query parameter is required');
      return noStore(Response.json(await service.target(parseChatId(rawChatId), request.signal)));
    } catch (error) {
      return noStore(jsonErrorFromUnknown(normalizeChatRowRouteError(error)));
    }
  }

  async function postRow(body: unknown, request: Request): Promise<Response> {
    try {
      return noStore(Response.json(await service.add(parseAddChatRowRequest(body), request.signal)));
    } catch (error) {
      return noStore(jsonErrorFromUnknown(normalizeChatRowRouteError(error)));
    }
  }

  return {
    '/api/v1/chats/rows': {
      GET: getTarget,
      POST: withJsonBody(postRow),
    },
  };
}

function normalizeChatRowRouteError(error: unknown): unknown {
  if (error instanceof CommandRequestValidationError || error instanceof InvalidChatIdError) {
    return new ValidationDomainError(error.message);
  }
  return error;
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
