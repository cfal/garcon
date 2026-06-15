// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to QueueManager and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import {
  ChatLogResponseMessage,
  ChatSessionsRunningMessage, WsFaultMessage,
  ClientRequestErrorMessage,
  ChatSubscribedMessage,
  ChatGenerationResetMessage,
  ChatReloadedMessage,
} from '../../common/ws-events.ts';
import type { ClientRequestErrorCode } from '../../common/ws-events.ts';
import type { PendingUserInput } from '../../common/pending-user-input.js';
import {
  parseClientWsMessage,
  ChatLogQueryRequest,
  ChatSubscribeRequest,
  ChatReloadRequest,
  ChatRunningQueryRequest,
} from '../../common/ws-requests.ts';
import type { ClientWsMessage } from '../../common/ws-requests.ts';
import type { IChatRegistry } from '../chats/store.js';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../lib/pagination.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { ChatNativeReloader } from '../chats/chat-native-reload.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ChatReplayResult } from '../../common/chat-view.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('ws:chat');

const PERMISSION_DEDUP_TTL_MS = 30_000;

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

type AgentRegistryDep = Pick<
  AgentRegistryServiceContract,
  'getRunningSessions'
>;

type ChatViewsDep = ChatViewPageReader & {
  readReplay(chatId: string, generationId: string, afterSeq: number): ChatReplayResult | null;
};
type NativeReloaderDep = Pick<ChatNativeReloader, 'reloadFromNative'>;

type PendingInputsDep = Pick<PendingUserInputServiceContract, 'reconcile' | 'listForChat'>;

type WsRequestHandler = (data: ClientWsMessage, writer: WebSocketWriter) => Promise<void> | void;
type ChatIdRequest = { type: string; chatId?: string | null };

interface ChatHandlerDeps {
  agents: AgentRegistryDep;
  chatViews: ChatViewsDep;
  nativeReloader: NativeReloaderDep;
  registry: IChatRegistry;
  pendingInputs: PendingInputsDep;
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

export class ChatHandler {
  #agents: AgentRegistryDep;
  #chatViews: ChatViewsDep;
  #nativeReloader: NativeReloaderDep;
  #pendingInputs: PendingInputsDep;
  #registry: IChatRegistry;
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;

  constructor({
    agents,
    chatViews,
    nativeReloader,
    registry,
    pendingInputs,
  }: ChatHandlerDeps) {
    this.#agents = agents;
    this.#chatViews = chatViews;
    this.#nativeReloader = nativeReloader;
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

  async #handleGetMessages(data: ChatLogQueryRequest, chatId: string, writer: WebSocketWriter): Promise<void> {
    const clientRequestId = data.clientRequestId;
    if (!clientRequestId) return;

    const requestType = 'chat-log-query';

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

      const { limit } = parsePagination(data.limit, null, { maxLimit: CHAT_MESSAGES_MAX_LIMIT });

      await this.#pendingInputs.reconcile(chatId);
      const result = await this.#chatViews.getOrCreatePage(chatId, limit, data.beforeSeq);

      writer.send(new ChatLogResponseMessage(
        clientRequestId,
        chatId,
        result.generationId,
        result.messages,
        this.#pendingInputs.listForChat(chatId) as PendingUserInput[],
        result.lastSeq,
        result.pageOldestSeq,
        result.hasMore,
        limit,
      ));
    } catch (error: unknown) {
      logger.error(`ws: error reading messages for ${chatId}:`, (error as Error).message);
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: 'HISTORY_LOAD_FAILED',
        message: (error as Error).message || 'Failed to load chat history',
        retryable: true, chatId,
      });
    }
  }

  #handleGetRunningSessions(data: ChatRunningQueryRequest, writer: WebSocketWriter): void {
    writer.send(new ChatSessionsRunningMessage(
      this.#agents.getRunningSessions(),
      data.clientRequestId ?? undefined,
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
        code: message.includes('running') ? 'CHAT_RUNNING' : 'HISTORY_LOAD_FAILED',
        message,
        retryable: true, chatId,
      });
    }
  }

  #createRequestHandlers(): Record<ClientWsMessage['type'], WsRequestHandler> {
    return {
      'chat-log-query': (data, writer) => this.#withChatId(data as ChatLogQueryRequest, writer, (chatId) => {
        return this.#handleGetMessages(data as ChatLogQueryRequest, chatId, writer);
      }),
      'chat-subscribe': (data, writer) => this.#withChatId(data as ChatSubscribeRequest, writer, (chatId) => {
        return this.#handleChatSubscribe(data as ChatSubscribeRequest, chatId, writer);
      }),
      'chat-reload': (data, writer) => this.#withChatId(data as ChatReloadRequest, writer, (chatId) => {
        return this.#handleChatReload(data as ChatReloadRequest, chatId, writer);
      }),
      'chats-running-query': (data, writer) => this.#handleGetRunningSessions(data as ChatRunningQueryRequest, writer),
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
