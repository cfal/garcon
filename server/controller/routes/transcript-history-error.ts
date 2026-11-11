import type { UnavailableChatHistoryResponse } from '../../../common/chat-view.js';
import { DomainError } from '../../common/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import { createLogger } from '../../common/log.js';
import { TranscriptHistoryUnavailableError } from '../chats/errors.js';
import { safeFenceDiagnostic, StaleTranscriptViewError } from '../ledger/errors.js';

const logger = createLogger('routes:chats');

export function transcriptHistoryError(error: unknown, chatId: string, signal: AbortSignal): Response {
  if (signal.aborted) return new Response(null, { status: 499 });
  // Fence causes can contain private paths or content and must bypass generic logging.
  if (error instanceof TranscriptHistoryUnavailableError && error.historyState.errorCode === 'LEDGER_FENCED') {
    logger.warn('Transcript ledger read is fenced.', safeFenceDiagnostic(error.cause));
    return Response.json({
      historyState: error.historyState,
      chatId,
      messages: [],
    } satisfies UnavailableChatHistoryResponse);
  }
  logger.error(`sessions: error reading messages for ${chatId}:`, (error as Error).message);
  if (error instanceof StaleTranscriptViewError) {
    return jsonError('Transcript view changed while paging', 409, 'STALE_TRANSCRIPT_VIEW', false);
  }
  if (error instanceof DomainError && error.code === 'CARRYOVER_HISTORY_UNAVAILABLE') {
    return Response.json({
      historyState: { kind: 'degraded', errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE', retryable: false },
      chatId,
      messages: [],
    } satisfies UnavailableChatHistoryResponse);
  }
  if (error instanceof TranscriptHistoryUnavailableError) {
    return Response.json({
      historyState: error.historyState,
      chatId,
      messages: [],
    } satisfies UnavailableChatHistoryResponse);
  }
  return jsonErrorFromUnknown(error);
}
