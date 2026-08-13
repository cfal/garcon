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
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
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
type PendingInputsDep = Pick<PendingUserInputServiceContract, 'listForTransport'>;
type ChatViewsDep = {
  readReplay(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
  ): Promise<TranscriptReplayResult>;
  resendCandidates(chatId: string): readonly import('../../common/chat-view.js').ResendCandidate[];
};
// Serves the manual reload as a fresh view over the authoritative projection.
type ProjectionReload = (chatId: string) => Promise<import('../../common/chat-view.js').TranscriptPage>;

type WsRequestHandler = (data: ClientWsMessage, writer: WebSocketWriter) => Promise<void> | void;
type ChatIdRequest = { type: string; chatId?: string | null };

interface ChatHandlerDeps {
  serverInstanceId: string;
  processing: Pick<ChatProcessingActivity, 'snapshot'>;
  chatViews: ChatViewsDep;
  projectionReload: ProjectionReload;
  queue: QueueDep;
  pendingInputs: PendingInputsDep;
  transientFeeds: Pick<ChatTransientFeedStore, 'snapshot' | 'currentSnapshot' | 'rebaseGeneration'>;
  registry: IChatRegistry;
}

const RECONNECT_CONTROL_READ_CONCURRENCY = 8;

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
  #processing: Pick<ChatProcessingActivity, 'snapshot'>;
  #chatViews: ChatViewsDep;
  #projectionReload: ProjectionReload;
  #queue: QueueDep;
  #pendingInputs: PendingInputsDep;
  #transientFeeds: Pick<ChatTransientFeedStore, 'snapshot' | 'currentSnapshot' | 'rebaseGeneration'>;
  #registry: IChatRegistry;
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;

  constructor({
    serverInstanceId,
    processing,
    chatViews,
    projectionReload,
    queue,
    pendingInputs,
    transientFeeds,
    registry,
  }: ChatHandlerDeps) {
    this.#serverInstanceId = serverInstanceId;
    this.#processing = processing;
    this.#chatViews = chatViews;
    this.#projectionReload = projectionReload;
    this.#queue = queue;
    this.#pendingInputs = pendingInputs;
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
    if (!clientRequestId) return;
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
      const replay = await this.#chatViews.readReplay(
        chatId,
        transcriptViewId(data.transcriptViewId),
        data.afterOrdinal,
      );
      writer.send(new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        replay.transcriptViewId,
        replay.messages,
        replay.firstOrdinal,
        replay.lastOrdinal,
        [...this.#chatViews.resendCandidates(chatId)],
        this.#pendingInputs.listForTransport(chatId),
        this.#transientFeeds.snapshot({
          chatId,
          agentOwnershipEpoch: session.agentOwnershipEpoch,
          generationId: replay.transcriptViewId,
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
      const previousFeed = this.#transientFeeds.currentSnapshot(chatId);
      const reload = await this.#projectionReload(chatId);
      // The reload replaced the browser generation; carry the transient rows
      // into it so later subscribes see one matching snapshot.
      if (previousFeed && previousFeed.generationId !== reload.transcriptViewId) {
        this.#transientFeeds.rebaseGeneration({
          chatId,
          agentOwnershipEpoch: session.agentOwnershipEpoch,
          previousGenerationId: previousFeed.generationId,
          generationId: reload.transcriptViewId,
        });
      }
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
