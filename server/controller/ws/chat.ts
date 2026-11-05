// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to ChatExecutionCoordinator and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import type { PrimaryWebSocket } from './primary-delivery.js';
import {
  ReconnectStateMessage,
  WsFaultMessage,
  ClientRequestErrorMessage,
  ChatReloadedMessage,
  ChatReloadProgressMessage,
  WsPongMessage,
} from '../../../common/ws-events.ts';
import type {
  ChatProcessingSnapshotResult,
  ChatReloadProgress,
  ClientRequestErrorCode,
} from '../../../common/ws-events.ts';
import {
  parseClientWsMessage,
  ChatReloadRequest,
  ChatReloadCancelRequest,
  ReconnectStateQueryRequest,
  WsPingRequest,
} from '../../../common/ws-requests.ts';
import type { ClientWsMessage } from '../../../common/ws-requests.ts';
import type { IChatRegistry } from '../chats/store.js';
import { isDomainError } from '../../common/domain-error.js';
import type { ChatProcessingActivity } from '../chats/chat-processing-activity.js';
import { createLogger } from '../../common/log.js';
import type { ChatExecutionQueries } from '../chat-execution/chat-execution-coordinator.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.js';
import { mapWithConcurrencyResult } from '../../common/concurrency.js';
const logger = createLogger('ws:chat');

type WS = PrimaryWebSocket;

type QueueDep = Pick<ChatExecutionQueries, 'readChatExecutionControl'>;
// Serves the manual reload as a fresh view over the authoritative ledger.
type TranscriptReload = (chatId: string, options: {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: ChatReloadProgress) => void;
}) => Promise<{ readonly transcriptViewId: string; readonly lastOrdinal: number }>;

type WsRequestHandler = (
  data: ClientWsMessage,
  writer: WebSocketWriter,
  ws: WS,
) => Promise<void> | void;
type ChatIdRequest = ChatReloadRequest | ChatReloadCancelRequest;

interface ChatHandlerDeps {
  serverInstanceId: string;
  processing: Pick<ChatProcessingActivity, 'phase' | 'snapshot'>;
  transcriptReload: TranscriptReload;
  queue: QueueDep;
  registry: IChatRegistry;
}

const RECONNECT_CONTROL_READ_CONCURRENCY = 8;
const RELOAD_PROGRESS_INTERVAL_MS = 1_000;

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

interface RequestErrorParams {
  clientRequestId: string;
  requestType: string;
  code: ClientRequestErrorCode;
  message: string;
  retryable: boolean;
  chatId?: string;
}

// Sends the latest progress now, on every phase change, and once a second, so
// the client's liveness check also covers lock waits and slow phases. A
// dropped progress frame never fails the reload.
function reportReloadProgress(send: (progress: ChatReloadProgress) => void): {
  readonly update: (progress: ChatReloadProgress) => void;
  readonly stop: () => void;
} {
  let latest: ChatReloadProgress = { phase: 'preparing', rows: 0 };
  const deliver = () => {
    try {
      send(latest);
    } catch (error: unknown) {
      if (!(error instanceof WebSocketResponseDroppedError)) throw error;
    }
  };
  deliver();
  const timer = setInterval(deliver, RELOAD_PROGRESS_INTERVAL_MS);
  return {
    update(progress) {
      const phaseChanged = progress.phase !== latest.phase;
      latest = progress;
      if (phaseChanged) deliver();
    },
    stop: () => clearInterval(timer),
  };
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
  #transcriptReload: TranscriptReload;
  #queue: QueueDep;
  #registry: IChatRegistry;
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;
  // Only the requesting socket may cancel a reload. A closed socket does not
  // cancel it: the replacement reaches every client as a view replacement.
  readonly #reloads = new WeakMap<WS, Map<string, { chatId: string; controller: AbortController }>>();

  constructor({
    serverInstanceId,
    processing,
    transcriptReload,
    queue,
    registry,
  }: ChatHandlerDeps) {
    this.#serverInstanceId = serverInstanceId;
    this.#processing = processing;
    this.#transcriptReload = transcriptReload;
    this.#queue = queue;
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

  async #handleChatReload(
    data: ChatReloadRequest,
    chatId: string,
    writer: WebSocketWriter,
    ws: WS,
  ): Promise<void> {
    const clientRequestId = data.clientRequestId;
    if (!clientRequestId) return;
    const requestType = 'chat-reload';
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
    let reloads = this.#reloads.get(ws);
    if (!reloads) this.#reloads.set(ws, reloads = new Map());
    if (reloads.has(clientRequestId)) {
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: 'REQUEST_VALIDATION_FAILED',
        message: 'A reload with this request ID is already running',
        retryable: false, chatId,
      });
      return;
    }
    const controller = new AbortController();
    reloads.set(clientRequestId, { chatId, controller });
    const progress = reportReloadProgress((update) => writer.send(new ChatReloadProgressMessage(
      clientRequestId, chatId, update.phase, update.rows,
    )));
    try {
      const reload = await this.#transcriptReload(chatId, {
        signal: controller.signal,
        onProgress: progress.update,
      });
      writer.send(new ChatReloadedMessage(
        clientRequestId,
        chatId,
        reload.transcriptViewId,
        reload.lastOrdinal,
      ));
    } catch (error: unknown) {
      if (error instanceof WebSocketResponseDroppedError) throw error;
      if (controller.signal.aborted) {
        this.#sendRequestError(writer, {
          clientRequestId, requestType,
          code: 'REQUEST_CANCELLED',
          message: 'Reload cancelled',
          retryable: true, chatId,
        });
        return;
      }
      const message = (error as Error).message || 'Failed to reload chat';
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: reloadErrorCode(error),
        message,
        retryable: isDomainError(error) ? error.retryable : true, chatId,
      });
    } finally {
      progress.stop();
      reloads.delete(clientRequestId);
    }
  }

  #handleChatReloadCancel(data: ChatReloadCancelRequest, chatId: string, ws: WS): void {
    if (!data.reloadRequestId) return;
    const reload = this.#reloads.get(ws)?.get(data.reloadRequestId);
    if (reload?.chatId === chatId) reload.controller.abort();
  }

  #createRequestHandlers(): Record<ClientWsMessage['type'], WsRequestHandler> {
    return {
      'chat-reload': (data, writer, ws) => this.#withChatId(data as ChatReloadRequest, writer, (chatId) => {
        return this.#handleChatReload(data as ChatReloadRequest, chatId, writer, ws);
      }),
      'chat-reload-cancel': (data, writer, ws) => this.#withChatId(data as ChatReloadCancelRequest, writer, (chatId) => {
        this.#handleChatReloadCancel(data as ChatReloadCancelRequest, chatId, ws);
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
      this.#sendMissingSessionError(
        writer, data.type, data.type === 'chat-reload-cancel' ? null : data.clientRequestId,
      );
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
        return;
      }
      await this.#requestHandlers[data.type](data, writer, ws);
    } catch (error: unknown) {
      if (error instanceof WebSocketResponseDroppedError) throw error;
      logger.error('ws: chat error:', (error as Error).message);
      writer.send(new WsFaultMessage((error as Error).message));
    }
  }

  #sendMissingSessionError(
    writer: WebSocketWriter,
    type: ChatIdRequest['type'],
    clientRequestId: string | null,
  ): void {
    const message = `Missing chatId for "${type}"`;
    if (clientRequestId) {
      this.#sendRequestError(writer, {
        clientRequestId, requestType: type, code: 'MISSING_CHAT_ID', message, retryable: false,
      });
      return;
    }
    writer.send(new WsFaultMessage(message));
  }

  #handleClose(_ws: WS, code?: number, reason?: string): void {
    logger.info('ws: chat client disconnected', code ?? '', reason ? `(${reason})` : '');
  }
}
