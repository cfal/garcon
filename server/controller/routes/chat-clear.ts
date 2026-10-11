import { parseClearChatRequest } from '../../../common/chat-clear.js';
import { CommandRequestValidationError } from '../../../common/command-request-validation.js';
import { ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { TranscriptClearService } from '../ledger/clear.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

export function createChatClearRoutes(service: Pick<TranscriptClearService, 'clear'>): RouteMap {
  return {
    '/api/v1/chats/clear': {
      POST: withJsonBody(async (body, request) => {
        try {
          return Response.json(await service.clear(parseClearChatRequest(body), request.signal));
        } catch (error) {
          return jsonErrorFromUnknown(error instanceof CommandRequestValidationError
            ? new ValidationDomainError(error.message) : error);
        }
      }),
    },
  };
}
