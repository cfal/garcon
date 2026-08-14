// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to ChatExecutionCoordinator and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import { publishWebSocketPayload } from './transport.js';
import {
  ReconnectStateMessage,
  WsFaultMessage,
  ClientRequestErrorMessage,
  ChatSubscribedMessage,
  ChatReloadedMessage,
  WsPongMessage,
} from '../../common/ws-events.ts';
import type {
  ChatProcessingSnapshotResult,
  ClientRequestErrorCode,
} from '../../common/ws-events.ts';
import {
  parseClientWsMessage,
  ChatSubscribeRequest,
  ChatReloadRequest,
  ReconnectStateQueryRequest,
  WsPingRequest,
} from '../../common/ws-requests.ts';
import type { ClientWsMessage } from '../../common/ws-requests.ts';
import type { IChatRegistry } from '../chats/store.js';
import { isDomainError } from '../lib/domain-error.js';
import type { ChatProcessingActivity } from '../chats/chat-processing-activity.js';
import type { TranscriptReplayResult } from '../../common/chat-view.js';
import { createLogger } from '../lib/log.js';
import type { ChatExecutionQueries } from '../chat-execution/chat-execution-coordinator.js';
import type { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.js';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';
import {
  StaleTranscriptViewError,
  transcriptViewId,
  type TranscriptViewId,
} from '../ledger/index.js';

const logger = createLogger('ws:chat');

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

type QueueDep = Pick<ChatExecutionQueries, 'readChatExecutionControl'>;
type ChatViewsDep = {
  readReplay(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
  ): Promise<TranscriptReplayResult>;
  resendCandidates(chatId: string): readonly import('../../common/chat-view.js').ResendCandidate[];
};
// Serves the manual reload as a fresh view over the authoritative ledger.
type TranscriptReload = (chatId: string) => Promise<import('../../common/chat-view.js').TranscriptPage>;

type WsRequestHandler = (data: ClientWsMessage, writer: WebSocketWriter) => Promise<void> | void;
type ChatIdRequest = { type: string; chatId?: string | null };

interface ChatHandlerDeps {
  serverInstanceId: string;
  processing: Pick<ChatProcessingActivity, 'phase' | 'snapshot'>;
  chatViews: ChatViewsDep;
  transcriptReload: TranscriptReload;
  queue: QueueDep;
  transientFeeds: Pick<ChatTransientFeedStore, 'snapshot'>;
  registry: IChatRegistry;
}

const RECONNECT_CONTROL_READ_CONCURRENCY = 8;
const SLOW_REPLAY_WARNING_MS = 2_000;

function readProcessingSnapshot(
  processing: Pick<ChatProcessingActivity, 'snapshot'>,
): ChatProcessingSnapshotResult {
  try {
    return {
      outcome: 'snapshot',
      chats: processing.snapshot(),
    };
  } catch (error: unknown) {
    logger.warn(
      'processing snapshot unavailable:',
      error instanceof Error ? error.message : String(error),
    );
    return { outcome: 'unavailable' };
  }
}

class WebSocketWriter {
  #ws: WS;
  constructor(ws: WS) {
    this.#ws = ws;
  }
  send(data: unknown): void {
    sendWebSocketJson(this.#ws, data);
  }
  publish(data: unknown): void {
    publishWebSocketPayload(this.#ws, 'chat', JSON.stringify(data));
  }
}

interface RequestErrorParams {
  clientRequestId: string;
  requestType: string;
  code: ClientRequestErrorCode;
  message: string;
  retryable: boolean;
  chatId?: string;
}

function reloadErrorCode(error: unknown): ClientRequestErrorCode {
  if (isDomainError(error) && (error.code === 'CHAT_RUNNING' || error.code === 'HISTORY_LOAD_FAILED')) {
    return error.code;
  }
  return 'HISTORY_LOAD_FAILED';
}

export class ChatHandler {
  #serverInstanceId: string;
  #processing: Pick<ChatProcessingActivity, 'phase' | 'snapshot'>;
  #chatViews: ChatViewsDep;
  #transcriptReload: TranscriptReload;
  #queue: QueueDep;
  #transientFeeds: Pick<ChatTransientFeedStore, 'snapshot'>;
  #registry: IChatRegistry;
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;

  constructor({
    serverInstanceId,
    processing,
    chatViews,
    transcriptReload,
    queue,
    transientFeeds,
    registry,
  }: ChatHandlerDeps) {
    this.#serverInstanceId = serverInstanceId;
    this.#processing = processing;
    this.#chatViews = chatViews;
    this.#transcriptReload = transcriptReload;
    this.#queue = queue;
    this.#transientFeeds = transientFeeds;
    this.#registry = registry;
    this.#requestHandlers = this.#createRequestHandlers();
  }

  createHandler(): {
    open: (ws: WS) => void;
    message: (ws: WS, data: unknown) => Promise<void>;
    close: (ws: WS, code?: number, reason?: string) => void;
  } {
    return {
      open: (ws) => this.#handleOpen(ws),
      message: (ws, data) => this.#handleMessage(ws, data),
      close: (ws, code, reason) => this.#handleClose(ws, code, reason),
    };
  }

  // A subscribe answers from the ledger, so it settles in milliseconds. One that does not is
  // holding a client on a request that looks answered to nobody, and the silence is the whole
  // symptom; saying so is what separates a stuck read from a request that never arrived.
  async #watchSlowReplay<T>(chatId: string, replay: Promise<T>): Promise<T> {
    const timer = setTimeout(
      () => logger.warn('ws: chat-subscribe replay is still pending', {
        chatId,
        afterMs: SLOW_REPLAY_WARNING_MS,
      }),
      SLOW_REPLAY_WARNING_MS,
    );
    try {
      return await replay;
    } finally {
      clearTimeout(timer);
    }
  }

  #sendRequestError(writer: WebSocketWriter, params: RequestErrorParams): void {
    writer.send(new ClientRequestErrorMessage(
      params.clientRequestId, params.requestType, params.code,
      params.message, Boolean(params.retryable), params.chatId,
    ));
  }

  async #handleReconnectState(
    data: ReconnectStateQueryRequest,
    writer: WebSocketWriter,
  ): Promise<void> {
    try {
      const controlResults = await mapWithConcurrencyResult(
        data.controlChatIds,
        RECONNECT_CONTROL_READ_CONCURRENCY,
        async (chatId) => {
          if (!this.#registry.getChat(chatId)) {
            return { chatId, outcome: 'not-found' as const };
          }
          try {
            return {
              chatId,
              outcome: 'snapshot' as const,
              control: toClientChatExecutionControlState(
                await this.#queue.readChatExecutionControl(chatId),
              ),
            };
          } catch (error: unknown) {
            logger.warn(
              'queue reconnect snapshot unavailable:',
              chatId,
              error instanceof Error ? error.message : String(error),
            );
            return { chatId, outcome: 'unavailable' as const };
          }
        },
      );
      const processing = readProcessingSnapshot(this.#processing);
      writer.send(new ReconnectStateMessage(
        processing,
        controlResults,
        this.#serverInstanceId,
        data.clientRequestId ?? undefined,
      ));
    } catch (error: unknown) {
      logger.error(
        'reconnect state query failed:',
        error instanceof Error ? error.message : String(error),
      );
      if (typeof data.clientRequestId === 'string') {
        this.#sendRequestError(writer, {
          clientRequestId: data.clientRequestId,
          requestType: 'reconnect-state-query',
          code: 'INTERNAL_ERROR',
          message: 'Failed to reconcile reconnect state',
          retryable: true,
        });
        return;
      }
      writer.send(new WsFaultMessage('Failed to reconcile reconnect state'));
    }
  }

  #handleWsPing(data: WsPingRequest, writer: WebSocketWriter): void {
    if (!data.clientRequestId) return;
    writer.send(new WsPongMessage(
      data.clientRequestId,
      data.sentAt,
      new Date().toISOString(),
      readProcessingSnapshot(this.#processing),
      this.#serverInstanceId,
    ));
  }

  async #handleChatSubscribe(data: ChatSubscribeRequest, chatId: string, writer: WebSocketWriter): Promise<void> {
    const clientRequestId = data.clientRequestId;
    if (!clientRequestId) {
      // The client is waiting on a correlated answer it can never receive otherwise.
      logger.warn('ws: chat-subscribe arrived without a client request id', { chatId });
      writer.send(new WsFaultMessage('chat-subscribe requires a clientRequestId'));
      return;
    }
    const requestType = 'chat-subscribe';
    try {
      const session = this.#registry.getChat(chatId);
      if (!session) {
        this.#sendRequestError(writer, {
          clientRequestId, requestType,
          code: 'SESSION_NOT_FOUND',
          message: `Chat not found: ${chatId}`,
          retryable: false, chatId,
        });
        return;
      }
      const replay = await this.#watchSlowReplay(chatId, this.#chatViews.readReplay(
        chatId,
        transcriptViewId(data.transcriptViewId),
        data.afterOrdinal,
      ));
      writer.send(new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        replay.transcriptViewId,
        replay.messages,
        replay.firstOrdinal,
        replay.lastOrdinal,
        this.#processing.phase(chatId) === null
          ? [...this.#chatViews.resendCandidates(chatId)]
          : [],
        this.#transientFeeds.snapshot({
          chatId,
          transcriptViewId: replay.transcriptViewId,
        }),
      ));
    } catch (error: unknown) {
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: error instanceof StaleTranscriptViewError
          ? 'STALE_TRANSCRIPT_VIEW'
          : 'HISTORY_LOAD_FAILED',
        message: (error as Error).message || 'Failed to replay chat messages',
        retryable: !(error instanceof StaleTranscriptViewError), chatId,
      });
    }
  }

  async #handleChatReload(data: ChatReloadRequest, chatId: string, writer: WebSocketWriter): Promise<void> {
    const clientRequestId = data.clientRequestId;
    if (!clientRequestId) return;
    const requestType = 'chat-reload';
    try {
      const session = this.#registry.getChat(chatId);
      if (!session) {
        this.#sendRequestError(writer, {
          clientRequestId, requestType,
          code: 'SESSION_NOT_FOUND',
          message: `Chat not found: ${chatId}`,
          retryable: false, chatId,
        });
        return;
      }
      const reload = await this.#transcriptReload(chatId);
      writer.send(new ChatReloadedMessage(
        clientRequestId,
        chatId,
        reload.transcriptViewId,
        reload.messages,
        reload.lastOrdinal,
        reload.pageOldestOrdinal,
        reload.pageNewestOrdinal,
        reload.hasMore,
      ));
    } catch (error: unknown) {
      const message = (error as Error).message || 'Failed to reload chat';
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: reloadErrorCode(error),
        message,
        retryable: isDomainError(error) ? error.retryable : true, chatId,
      });
    }
  }

  #createRequestHandlers(): Record<ClientWsMessage['type'], WsRequestHandler> {
    return {
      'chat-subscribe': (data, writer) => this.#withChatId(data as ChatSubscribeRequest, writer, (chatId) => {
        return this.#handleChatSubscribe(data as ChatSubscribeRequest, chatId, writer);
      }),
      'chat-reload': (data, writer) => this.#withChatId(data as ChatReloadRequest, writer, (chatId) => {
        return this.#handleChatReload(data as ChatReloadRequest, chatId, writer);
      }),
      'reconnect-state-query': (data, writer) => this.#handleReconnectState(data as ReconnectStateQueryRequest, writer),
      'ws-ping': (data, writer) => this.#handleWsPing(data as WsPingRequest, writer),
    };
  }

  async #withChatId(
    data: ChatIdRequest,
    writer: WebSocketWriter,
    handler: (chatId: string) => Promise<void> | void,
  ): Promise<void> {
    const chatId = typeof data.chatId === 'string' && data.chatId ? data.chatId : null;
    if (!chatId) {
      this.#sendMissingSessionError(writer, data.type);
      return;
    }
    await handler(chatId);
  }

  #handleOpen(ws: WS): void {
    logger.info('ws: chat client connected');
    ws.subscribe('chat');
  }

  async #handleMessage(ws: WS, rawData: unknown): Promise<void> {
    const writer = new WebSocketWriter(ws);
    try {
      const data = parseClientWsMessage(rawData as Record<string, unknown>);
      if (!data) return;
      await this.#requestHandlers[data.type](data, writer);
    } catch (error: unknown) {
      logger.error('ws: chat error:', (error as Error).message);
      writer.send(new WsFaultMessage((error as Error).message));
    }
  }

  #sendMissingSessionError(writer: WebSocketWriter, type: string): void {
    writer.send(new WsFaultMessage(`Missing chatId for "${type}"`));
  }

  #handleClose(_ws: WS, code?: number, reason?: string): void {
    logger.info('ws: chat client disconnected', code ?? '', reason ? `(${reason})` : '');
  }
}
