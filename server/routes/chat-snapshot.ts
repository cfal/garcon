import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT,
  CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT,
  type ChatSnapshotResponse,
  type ChatSnapshotTranscript,
} from '../../common/chat-snapshot.js';
import { parseChatId, type ChatId } from '../../common/chat-id.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.js';
import type { ChatExecutionQueries } from '../chat-execution/types.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import { transcriptUnavailableMessage } from '../lib/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { createLogger, type Logger } from '../lib/log.js';

const defaultLogger = createLogger('routes:chat-snapshot');

interface ChatSnapshotRouteDeps {
  summaries: Pick<ChatListProjector, 'buildSummary'>;
  execution: Pick<ChatExecutionQueries, 'readChatExecutionControl'>;
  chatViews: Pick<ChatViewPageReader, 'getOrCreatePage'>;
  pendingInputs: Pick<
    PendingUserInputServiceContract,
    'reconcileRetainedHistory' | 'listForTransport'
  >;
  logger?: Pick<Logger, 'error'>;
  now?: () => Date;
}

export function createChatSnapshotRoutes(deps: ChatSnapshotRouteDeps): RouteMap {
  return {
    '/api/v1/chats/snapshot': {
      GET: async (_request, url) => {
        const chatId = parseSnapshotChatId(url.searchParams.get('chatId'));
        if (chatId instanceof Response) return noStore(chatId);
        const messageLimit = parseMessageLimit(url.searchParams.get('limit'));
        if (messageLimit instanceof Response) return noStore(messageLimit);

        try {
          const observedAt = (deps.now?.() ?? new Date()).toISOString();
          const summary = deps.summaries.buildSummary(chatId);
          if (!summary) {
            return noStore(jsonError(
              'Session not found',
              404,
              'SESSION_NOT_FOUND',
              false,
            ));
          }
          const control = toClientChatExecutionControlState(
            await deps.execution.readChatExecutionControl(chatId),
          );
          const transcript = await readTranscript(deps, chatId, messageLimit);
          await deps.pendingInputs.reconcileRetainedHistory(chatId);
          const response = {
            observedAt,
            messageLimit,
            chat: summary.chat,
            processingPhase: summary.processingPhase,
            control,
            pendingUserInputs: deps.pendingInputs.listForTransport(chatId),
            transcript,
          } satisfies ChatSnapshotResponse;
          return noStore(Response.json(response));
        } catch (error) {
          (deps.logger ?? defaultLogger).error(`snapshot failed for chat ${chatId}:`, error);
          return noStore(jsonErrorFromUnknown(error));
        }
      },
    },
  };
}

async function readTranscript(
  deps: ChatSnapshotRouteDeps,
  chatId: string,
  messageLimit: number,
): Promise<ChatSnapshotTranscript> {
  if (messageLimit === 0) return { availability: 'not-requested' };
  try {
    const page = await deps.chatViews.getOrCreatePage(chatId, messageLimit);
    return { availability: 'available', ...page };
  } catch (error) {
    if (
      error instanceof AgentIntegrationError
      && error.code === 'TRANSCRIPT_UNAVAILABLE'
    ) {
      return {
        availability: 'unavailable',
        errorCode: error.code,
        retryable: error.retryable,
        message: transcriptUnavailableMessage(error.retryable),
      };
    }
    throw error;
  }
}

function parseSnapshotChatId(value: string | null): ChatId | Response {
  try {
    return parseChatId(value);
  } catch {
    return jsonError(
      'chatId must be a canonical Garcon chat ID',
      400,
      'VALIDATION_FAILED',
      false,
    );
  }
}

function parseMessageLimit(value: string | null): number | Response {
  if (value === null) return CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT;
  if (!/^\d+$/.test(value)) return messageLimitError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT) {
    return messageLimitError();
  }
  return parsed;
}

function messageLimitError(): Response {
  return jsonError(
    `limit must be an integer from 0 through ${CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT}`,
    400,
    'VALIDATION_FAILED',
    false,
  );
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
