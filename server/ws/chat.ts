// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to ChatExecutionCoordinator and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
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
import type {
  ResendCandidate,
  TranscriptReplayResult,
} from '../../common/chat-view.js';
import type { ChatTransientFeedSnapshot } from '../../common/chat-transient-feed.js';
import { createLogger } from '../lib/log.js';
import type { ChatExecutionQueries } from '../chat-execution/chat-execution-coordinator.js';
import type { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.js';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';
import {
  StaleTranscriptViewError,
  InvalidTranscriptReplayRequestError,
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
    throughOrdinal?: number,
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
const MAX_TRANSCRIPT_REPLAY_FRAME_BYTES = 1024 * 1024;

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
    if (!sendWebSocketJson(this.#ws, data)) {
      throw new WebSocketResponseDroppedError();
    }
  }
}

class WebSocketResponseDroppedError extends Error {
  override readonly name = 'WebSocketResponseDroppedError';

  constructor() {
    super('WebSocket response was not accepted by the socket');
  }
}

class TranscriptReplayFrameLimitError extends Error {
  override readonly name = 'TranscriptReplayFrameLimitError';

  constructor() {
    super('A transcript replay row exceeds the WebSocket response limit');
  }
}

interface ChatSubscribedPageInput {
  readonly clientRequestId: string;
  readonly chatId: string;
  readonly replay: TranscriptReplayResult;
  readonly resendCandidates: ResendCandidate[];
  readonly transientFeed: ChatTransientFeedSnapshot;
}

function chatSubscribedPage(
  input: ChatSubscribedPageInput,
  messageCount: number,
): ChatSubscribedMessage {
  const { replay } = input;
  const nextAfterOrdinal = messageCount === replay.messages.length
    ? replay.nextAfterOrdinal
    : replay.messages[messageCount]!.ordinal - 1;
  return new ChatSubscribedMessage(
    input.clientRequestId,
    input.chatId,
    replay.transcriptViewId,
    replay.messages.slice(0, messageCount),
    replay.firstOrdinal,
    nextAfterOrdinal,
    nextAfterOrdinal,
    replay.throughOrdinal,
    nextAfterOrdinal < replay.throughOrdinal,
    input.resendCandidates,
    input.transientFeed,
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitChatSubscribedPage(input: ChatSubscribedPageInput): ChatSubscribedMessage {
  const complete = chatSubscribedPage(input, input.replay.messages.length);
  if (serializedBytes(complete) <= MAX_TRANSCRIPT_REPLAY_FRAME_BYTES) return complete;

  const afterOrdinal = input.replay.firstOrdinal - 1;
  let lower = 0;
  let upper = input.replay.messages.length - 1;
  let fitted: ChatSubscribedMessage | null = null;
  while (lower <= upper) {
    const messageCount = Math.floor((lower + upper) / 2);
    const candidate = chatSubscribedPage(input, messageCount);
    if (candidate.nextAfterOrdinal <= afterOrdinal && candidate.hasMore) {
      lower = messageCount + 1;
      continue;
    }
    if (serializedBytes(candidate) <= MAX_TRANSCRIPT_REPLAY_FRAME_BYTES) {
      fitted = candidate;
      lower = messageCount + 1;
    } else {
      upper = messageCount - 1;
    }
  }
  if (!fitted) throw new TranscriptReplayFrameLimitError();
  return fitted;
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

function replayErrorCode(error: unknown): ClientRequestErrorCode {
  if (error instanceof StaleTranscriptViewError) return 'STALE_TRANSCRIPT_VIEW';
  if (error instanceof InvalidTranscriptReplayRequestError) {
    return 'REQUEST_VALIDATION_FAILED';
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
      if (error instanceof WebSocketResponseDroppedError) throw error;
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

  async #handleChatSubscribe(
    data: ChatSubscribeRequest,
    chatId: string,
    writer: WebSocketWriter,
  ): Promise<void> {
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
      const viewId = transcriptViewId(data.transcriptViewId);
      const replay = data.throughOrdinal === undefined
        ? await this.#chatViews.readReplay(chatId, viewId, data.afterOrdinal)
        : await this.#chatViews.readReplay(
            chatId,
            viewId,
            data.afterOrdinal,
            data.throughOrdinal,
          );
      const response = fitChatSubscribedPage({
        clientRequestId,
        chatId,
        replay,
        resendCandidates: this.#processing.phase(chatId) === null
          ? [...this.#chatViews.resendCandidates(chatId)]
          : [],
        transientFeed: this.#transientFeeds.snapshot({
          chatId,
          transcriptViewId: replay.transcriptViewId,
        }),
      });
      writer.send(response);
    } catch (error: unknown) {
      if (error instanceof WebSocketResponseDroppedError) throw error;
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: replayErrorCode(error),
        message: (error as Error).message || 'Failed to replay chat messages',
        retryable: !(
          error instanceof StaleTranscriptViewError
          || error instanceof InvalidTranscriptReplayRequestError
          || error instanceof TranscriptReplayFrameLimitError
        ),
        chatId,
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
      if (error instanceof WebSocketResponseDroppedError) throw error;
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
      const raw = rawData as Record<string, unknown>;
      const data = parseClientWsMessage(raw);
      if (!data) {
        this.#handleMalformedRequest(raw, writer);
        return;
      }
      await this.#requestHandlers[data.type](data, writer);
    } catch (error: unknown) {
      if (error instanceof WebSocketResponseDroppedError) throw error;
      logger.error('ws: chat error:', (error as Error).message);
      writer.send(new WsFaultMessage((error as Error).message));
    }
  }

  #handleMalformedRequest(data: Record<string, unknown>, writer: WebSocketWriter): void {
    if (data?.type !== 'chat-subscribe') return;
    const clientRequestId = typeof data.clientRequestId === 'string' && data.clientRequestId
      ? data.clientRequestId
      : null;
    const chatId = typeof data.chatId === 'string' && data.chatId ? data.chatId : null;
    if (!clientRequestId) {
      logger.warn('ws: chat-subscribe arrived without a client request id', { chatId });
      writer.send(new WsFaultMessage('chat-subscribe requires a clientRequestId'));
      return;
    }
    if (!chatId) {
      this.#sendMissingSessionError(writer, 'chat-subscribe');
      return;
    }
    this.#sendRequestError(writer, {
      clientRequestId,
      requestType: 'chat-subscribe',
      code: 'REQUEST_VALIDATION_FAILED',
      message: 'Invalid chat-subscribe request',
      retryable: false,
      chatId,
    });
  }

  #sendMissingSessionError(writer: WebSocketWriter, type: string): void {
    writer.send(new WsFaultMessage(`Missing chatId for "${type}"`));
  }

  #handleClose(_ws: WS, code?: number, reason?: string): void {
    logger.info('ws: chat client disconnected', code ?? '', reason ? `(${reason})` : '');
  }
}
