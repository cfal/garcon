import {
  parseTranscriptAnchorRequest,
  TranscriptAnchorRequestError,
  type TranscriptAnchorPage,
  type TranscriptAnchorRequest,
} from '../../../common/transcript-anchor-page.js';
import type { ResendCandidate } from '../../../common/chat-view.js';
import { jsonError } from '../../common/http-error.js';
import type { TranscriptAnchorPageReader } from '../chats/chat-message-reader.js';
import type { ChatProcessingActivity } from '../chats/chat-processing-activity.js';
import type { IChatRegistry } from '../chats/store.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { transcriptHistoryError } from './transcript-history-error.js';

export function createCombinedMessageRoutes(deps: {
  registry: Pick<IChatRegistry, 'getChat'>;
  reader: TranscriptAnchorPageReader;
  processing: Pick<ChatProcessingActivity, 'phase'>;
  resendCandidates(chatId: string): readonly ResendCandidate[];
}): RouteMap {
  return {
    '/api/v1/chats/combined-messages': {
      POST: withJsonBody(async (body: unknown, request) => {
        let input: TranscriptAnchorRequest;
        try {
          input = parseTranscriptAnchorRequest(body);
        } catch (error) {
          if (error instanceof TranscriptAnchorRequestError) {
            return jsonError(error.message, 400, 'VALIDATION_FAILED', false);
          }
          throw error;
        }
        const { chatId } = input;
        if (!deps.registry.getChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
        try {
          const page = await deps.reader.anchorPage(input, request.signal);
          if (!deps.registry.getChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
          if (input.transcriptViewId !== undefined && page.transcriptViewId !== input.transcriptViewId) {
            return jsonError('Transcript view changed while paging', 409, 'STALE_TRANSCRIPT_VIEW', false);
          }
          return Response.json({
            ...page,
            historyState: { kind: 'complete' },
            chatId,
            resendCandidates: input.direction === 'backward' && input.cursorOrdinal === undefined
              && deps.processing.phase(chatId) === null ? [...deps.resendCandidates(chatId)] : [],
          } satisfies TranscriptAnchorPage);
        } catch (error) {
          return transcriptHistoryError(error, chatId, request.signal);
        }
      }),
    },
  };
}
