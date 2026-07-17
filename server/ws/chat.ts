// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to QueueManager and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import {
  ReconnectStateMessage,
  WsFaultMessage,
  ClientRequestErrorMessage,
  ChatSubscribedMessage,
  ChatGenerationResetMessage,
  ChatReloadedMessage,
  WsPongMessage,
} from '../../common/ws-events.ts';
import type { ClientRequestErrorCode, ReconnectProcessingResult } from '../../common/ws-events.ts';
import {
  parseClientWsMessage,
  ChatSubscribeRequest,
  ChatReloadRequest,
  ReconnectStateQueryRequest,
  WsPingRequest,
} from '../../common/ws-requests.ts';
import type { ClientWsMessage } from '../../common/ws-requests.ts';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatNativeReloader } from '../chats/chat-native-reload.js';
import { isDomainError } from '../lib/domain-error.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ChatReplayResult } from '../../common/chat-view.js';
import { createLogger } from '../lib/log.js';
import type { ChatQueueService } from '../queue.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import { toClientQueueState } from '../queue-state.js';
import { mapWithConcurrencyResult } from '../lib/concurrency.js';

const logger = createLogger('ws:chat');

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

type AgentRegistryDep = Pick<
  AgentRegistryServiceContract,
  'getRunningChatIdsSnapshot'
>;

type NativeReloaderDep = Pick<ChatNativeReloader, 'reloadFromNative'>;
type QueueDep = Pick<ChatQueueService, 'readChatQueue'>;
type PendingInputsDep = Pick<PendingUserInputServiceContract, 'listForChat'>;
type ChatViewsDep = {
  readReplay(chatId: string, generationId: string, afterSeq: number): ChatReplayResult | null;
};

type WsRequestHandler = (data: ClientWsMessage, writer: WebSocketWriter) => Promise<void> | void;
type ChatIdRequest = { type: string; chatId?: string | null };

interface ChatHandlerDeps {
  agents: AgentRegistryDep;
  chatViews: ChatViewsDep;
  nativeReloader: NativeReloaderDep;
  queue: QueueDep;
  pendingInputs: PendingInputsDep;
  registry: IChatRegistry;
}

const RECONNECT_QUEUE_READ_CONCURRENCY = 8;

function readReconnectProcessingResult(
  agents: AgentRegistryDep,
): ReconnectProcessingResult {
  try {
    return {
      outcome: 'snapshot',
      runningChatIds: agents.getRunningChatIdsSnapshot(),
    };
  } catch (error: unknown) {
    logger.warn(
      'reconnect processing snapshot unavailable:',
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
    this.#ws.publish('chat', JSON.stringify(data));
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
  #agents: AgentRegistryDep;
  #chatViews: ChatViewsDep;
  #nativeReloader: NativeReloaderDep;
  #queue: QueueDep;
  #pendingInputs: PendingInputsDep;
  #registry: IChatRegistry;
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;

  constructor({
    agents,
    chatViews,
    nativeReloader,
    queue,
    pendingInputs,
    registry,
  }: ChatHandlerDeps) {
    this.#agents = agents;
    this.#chatViews = chatViews;
    this.#nativeReloader = nativeReloader;
    this.#queue = queue;
    this.#pendingInputs = pendingInputs;
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
      const queueResults = await mapWithConcurrencyResult(
        data.queueChatIds,
        RECONNECT_QUEUE_READ_CONCURRENCY,
        async (chatId) => {
          if (!this.#registry.getChat(chatId)) {
            return { chatId, outcome: 'not-found' as const };
          }
          try {
            return {
              chatId,
              outcome: 'snapshot' as const,
              queue: toClientQueueState(await this.#queue.readChatQueue(chatId)),
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
      const processing = readReconnectProcessingResult(this.#agents);
      writer.send(new ReconnectStateMessage(
        processing,
        queueResults,
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
      const replay = this.#chatViews.readReplay(chatId, data.generationId, data.afterSeq);
      if (!replay) {
        writer.send(new ChatSubscribedMessage(
          clientRequestId,
          chatId,
          null,
          'snapshot-required',
          [],
          0,
          this.#pendingInputs.listForChat(chatId),
        ));
        return;
      }
      writer.send(new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        replay.generationId,
        replay.mode,
        replay.messages,
        replay.lastSeq,
        this.#pendingInputs.listForChat(chatId),
      ));
    } catch (error: unknown) {
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: 'HISTORY_LOAD_FAILED',
        message: (error as Error).message || 'Failed to replay chat messages',
        retryable: true, chatId,
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
      const reload = await this.#nativeReloader.reloadFromNative(chatId, 'manual-reload');
      writer.send(new ChatReloadedMessage(
        clientRequestId,
        chatId,
        reload.generationId,
        reload.messages,
        reload.lastSeq,
        reload.pageOldestSeq,
        reload.hasMore,
      ));
      writer.publish(new ChatGenerationResetMessage(
        chatId,
        reload.generationId,
        'manual-reload',
        reload.lastSeq,
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
