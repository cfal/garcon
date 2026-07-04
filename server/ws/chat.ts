// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to QueueManager and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import {
  ChatSessionsRunningMessage,
  WsFaultMessage,
  ClientRequestErrorMessage,
  ChatSubscribedMessage,
  ChatGenerationResetMessage,
  ChatReloadedMessage,
  WsPongMessage,
} from '../../common/ws-events.ts';
import type { ClientRequestErrorCode } from '../../common/ws-events.ts';
import {
  parseClientWsMessage,
  ChatSubscribeRequest,
  ChatReloadRequest,
  ChatRunningQueryRequest,
  WsPingRequest,
} from '../../common/ws-requests.ts';
import type { ClientWsMessage } from '../../common/ws-requests.ts';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatNativeReloader } from '../chats/chat-native-reload.js';
import { isDomainError } from '../lib/domain-error.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ChatReplayResult } from '../../common/chat-view.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('ws:chat');

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

type AgentRegistryDep = Pick<
  AgentRegistryServiceContract,
  'getRunningSessions'
>;

type NativeReloaderDep = Pick<ChatNativeReloader, 'reloadFromNative'>;
type ChatViewsDep = {
  readReplay(chatId: string, generationId: string, afterSeq: number): ChatReplayResult | null;
};

type WsRequestHandler = (data: ClientWsMessage, writer: WebSocketWriter) => Promise<void> | void;
type ChatIdRequest = { type: string; chatId?: string | null };

interface ChatHandlerDeps {
  agents: AgentRegistryDep;
  chatViews: ChatViewsDep;
  nativeReloader: NativeReloaderDep;
  registry: IChatRegistry;
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
  #registry: IChatRegistry;
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;

  constructor({
    agents,
    chatViews,
    nativeReloader,
    registry,
  }: ChatHandlerDeps) {
    this.#agents = agents;
    this.#chatViews = chatViews;
    this.#nativeReloader = nativeReloader;
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

  #handleGetRunningSessions(data: ChatRunningQueryRequest, writer: WebSocketWriter): void {
    writer.send(new ChatSessionsRunningMessage(
      this.#agents.getRunningSessions(),
      data.clientRequestId ?? undefined,
    ));
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
      'chats-running-query': (data, writer) => this.#handleGetRunningSessions(data as ChatRunningQueryRequest, writer),
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
