import { parseSetChatParentRequest } from '../../../common/chat-parent-contracts.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { ChatParentMutationService } from '../chats/chat-parent-mutation-service.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

export function createChatParentRoutes(chatParents: Pick<ChatParentMutationService, 'set'>): RouteMap {
  return {
    '/api/v1/chats/parent': {
      PUT: withJsonBody(async (value: unknown) => {
        const input = parseSetChatParentRequest(value);
        if (!input) return jsonError('Valid chatId and parentChatId (or null) are required', 400);
        try {
          return Response.json(await chatParents.set(input));
        } catch (error) {
          return jsonErrorFromUnknown(error);
        }
      }),
    },
  };
}
