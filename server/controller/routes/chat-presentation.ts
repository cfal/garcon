import { CONVERSATION_PRESENTATION } from '../../../common/automation.js';
import { parsePromoteChatRequest, type PromoteChatResponse } from '../../../common/chat-presentation-contracts.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { IChatRegistry } from '../chats/store.js';
import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';

export function createChatPresentationRoutes(deps: {
  registry: Pick<IChatRegistry, 'updateChat'>;
  chatMutationLock: Pick<KeyedPromiseLock, 'runExclusive'>;
  settings: { ensureInNormal(chatId: string): Promise<void>; emitListChanged(reason: string, chatId: string): void };
  chatListProjector: Pick<ChatListProjector, 'buildOne'>;
}): RouteMap {
  return {
    '/api/v1/chats/promote': { POST: withJsonBody(async (body: unknown) => {
      const request = parsePromoteChatRequest(body);
      if (!request) return jsonError('Invalid promotion request', 400, 'VALIDATION_FAILED', false);
      try {
        return await deps.chatMutationLock.runExclusive(`chat:${request.chatId}`, async () => {
          const chat = await deps.registry.updateChat(request.chatId,
            { presentation: CONVERSATION_PRESENTATION }, { flush: true });
          if (!chat) return jsonError('Chat not found', 404, 'SESSION_NOT_FOUND', false);
          // List publication follows durable presentation; automation policy is untouched.
          let entry = deps.chatListProjector.buildOne(request.chatId);
          if (entry?.orderGroup === 'orphan') {
            await deps.settings.ensureInNormal(request.chatId);
            entry = deps.chatListProjector.buildOne(request.chatId);
          } else {
            deps.settings.emitListChanged('chat-presentation-changed', request.chatId);
          }
          if (!entry) return jsonError('Chat not found', 404, 'SESSION_NOT_FOUND', false);
          return Response.json({ success: true, chat: entry } satisfies PromoteChatResponse);
        });
      } catch (error) { return jsonErrorFromUnknown(error); }
    }) },
  };
}
