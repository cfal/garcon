import { parseChatId } from '../../common/chat-id.js';
import {
  HANDOFF_CONTEXT_WINDOW_MAX_TOKENS,
  HANDOFF_CONTEXT_WINDOW_MIN_TOKENS,
  isHandoffContextWindowTokens,
} from '../../common/handoff-sizing.js';
import type { HandoffArtifactService } from '../chats/handoff-artifact/service.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import {
  noStore,
  normalizeChatIdError,
  requiredSingleParameter,
} from './chat-read-helpers.js';

export function createChatHandoffArtifactRoutes(service: HandoffArtifactService): RouteMap {
  async function getArtifact(request: Request, url: URL): Promise<Response> {
    try {
      const chatId = parseChatId(requiredSingleParameter(url.searchParams, 'chatId'));
      const contextWindowTokens = parseContextWindowQuery(
        requiredSingleParameter(url.searchParams, 'contextWindowTokens'),
      );
      return noStore(Response.json(await service.create(
        { chatId, contextWindowTokens },
        request.signal,
      )));
    } catch (error) {
      return noStore(jsonErrorFromUnknown(normalizeChatIdError(error)));
    }
  }

  return {
    '/api/v1/chats/handoff-artifact': { GET: getArtifact },
  };
}

function parseContextWindowQuery(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new ValidationDomainError('contextWindowTokens must be a base-10 integer');
  }
  const parsed = Number(value);
  if (!isHandoffContextWindowTokens(parsed)) {
    throw new ValidationDomainError(
      `contextWindowTokens must be between ${HANDOFF_CONTEXT_WINDOW_MIN_TOKENS} and ${HANDOFF_CONTEXT_WINDOW_MAX_TOKENS}`,
    );
  }
  return parsed;
}
