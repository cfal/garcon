// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to QueueManager and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import {
  QueueStateUpdatedMessage,
  AgentRunFailedMessage, ChatLogResponseMessage,
  ChatSessionsRunningMessage, WsFaultMessage,
  ClientRequestErrorMessage,
} from '../../common/ws-events.ts';
import type { ClientRequestErrorCode } from '../../common/ws-events.ts';
import {
  parseClientWsMessage,
  AgentRunRequest,
  AgentStopRequest,
  PermissionDecisionRequest,
  PermissionModeSetRequest,
  ThinkingModeSetRequest,
  ModelSetRequest,
  ChatLogQueryRequest,
  ChatRunningQueryRequest,
  QueueEnqueueRequest,
  QueueDropRequest,
  QueueClearRequest,
  QueuePauseRequest,
  QueueResumeRequest,
  QueueQueryRequest,
} from '../../common/ws-requests.ts';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { QueueState } from '../../common/queue-state.ts';
import type { ChatMessage } from '../../common/chat-types.ts';
import type { PersistedChatExecutionConfig, RunProviderTurnOptions } from '../providers/types.js';
import { requireChatExecutionConfig } from '../providers/types.js';

const PERMISSION_DEDUP_TTL = 30_000;

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

interface ProviderRegistryDep {
  getRunningSessions(): {
    claude: Array<{ id: string; [key: string]: unknown }>;
    codex: Array<{ id: string; [key: string]: unknown }>;
    opencode: Array<{ id: string; [key: string]: unknown }>;
  };
  resolvePermission(chatId: string, permissionRequestId: string, decision: { allow: boolean; alwaysAllow: boolean }): void;
  setPermissionMode(chatId: string, mode: PermissionMode): Promise<void>;
  setModel(chatId: string, model: string): Promise<void>;
}

interface QueueManagerDep {
  submit(chatId: string, command: string, options: RunProviderTurnOptions): Promise<void>;
  abort(chatId: string): Promise<boolean>;
  triggerDrain(chatId: string, options: RunProviderTurnOptions): Promise<void>;
  readChatQueue(chatId: string): Promise<QueueState>;
  enqueueChat(chatId: string, content: string): Promise<unknown>;
  dequeueChat(chatId: string, entryId: string): Promise<unknown>;
  clearChatQueue(chatId: string): Promise<unknown>;
  pauseChatQueue(chatId: string): Promise<unknown>;
  resumeChatQueue(chatId: string): Promise<unknown>;
}

interface HistoryCacheDep {
  ensureLoaded(chatId: string): Promise<void>;
  getPaginatedMessages(chatId: string, limit: number, offset: number): {
    messages: ChatMessage[];
    total: number;
    hasMore: boolean;
    offset: number;
    limit: number;
  };
}

interface ChatRegistryDep {
  getChat(chatId: string): PersistedChatExecutionConfig | null;
  updateChat(chatId: string, updates: Record<string, unknown>): void | Promise<void>;
}

class WebSocketWriter {
  #ws: WS;
  constructor(ws: WS) {
    this.#ws = ws;
  }
  send(data: unknown): void {
    sendWebSocketJson(this.#ws, data);
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
  #providers: ProviderRegistryDep;
  #queue: QueueManagerDep;
  #historyCache: HistoryCacheDep;
  #registry: ChatRegistryDep;
  #recentPermissionDecisions = new Map<string, number>();

  constructor(
    providers: ProviderRegistryDep,
    queue: QueueManagerDep,
    historyCache: HistoryCacheDep,
    registry: ChatRegistryDep,
  ) {
    this.#providers = providers;
    this.#queue = queue;
    this.#historyCache = historyCache;
    this.#registry = registry;
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

  async #handleAgentCommand(data: AgentRunRequest, chatId: string, writer: WebSocketWriter): Promise<void> {
    console.log('chat: message:', data.command || '[continue/resume]');

    if (!/^\d+$/.test(String(chatId))) {
      writer.send(new AgentRunFailedMessage(chatId, 'Invalid session ID format'));
      return;
    }

    try {
      await this.#queue.submit(chatId, data.command, {
        images: data.images,
        permissionMode: data.permissionMode,
        thinkingMode: data.thinkingMode,
        model: data.model,
      });
    } catch (error: unknown) {
      writer.send(new AgentRunFailedMessage(chatId, (error as Error).message));
    }
  }

  async #handleAbortSession(_data: AgentStopRequest, chatId: string): Promise<void> {
    console.log('chat: abort session request:', chatId);
    await this.#queue.abort(chatId);
  }

  #handlePermissionResponse(data: PermissionDecisionRequest): void {
    if (!data.permissionRequestId || !data.chatId) return;

    if (this.#recentPermissionDecisions.has(data.permissionRequestId)) {
      console.warn('ws: duplicate permission-decision for', data.permissionRequestId, '- ignoring');
      return;
    }
    this.#recentPermissionDecisions.set(data.permissionRequestId, Date.now());
    setTimeout(() => this.#recentPermissionDecisions.delete(data.permissionRequestId!), PERMISSION_DEDUP_TTL);

    const decision = {
      allow: Boolean(data.allow),
      alwaysAllow: Boolean(data.alwaysAllow),
    };

    this.#providers.resolvePermission(data.chatId, data.permissionRequestId, decision);
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

      const limit = parseInt(String(data.limit || '20'), 10);
      const offset = parseInt(String(data.offset || '0'), 10);

      await this.#historyCache.ensureLoaded(chatId);
      const result = this.#historyCache.getPaginatedMessages(chatId, limit, offset);

      writer.send(new ChatLogResponseMessage(
        clientRequestId, chatId, result.messages, result.total,
        result.hasMore, result.offset, result.limit,
      ));
    } catch (error: unknown) {
      console.error(`ws: error reading messages for ${chatId}:`, (error as Error).message);
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: 'HISTORY_LOAD_FAILED',
        message: (error as Error).message || 'Failed to load chat history',
        retryable: true, chatId,
      });
    }
  }

  #handleGetRunningSessions(_data: ChatRunningQueryRequest, writer: WebSocketWriter): void {
    writer.send(new ChatSessionsRunningMessage(this.#providers.getRunningSessions()));
  }

  #handleOpen(ws: WS): void {
    console.log('ws: chat client connected');
    ws.subscribe('chat');
  }

  async #handleMessage(ws: WS, rawData: unknown): Promise<void> {
    const writer = new WebSocketWriter(ws);
    try {
      const data = parseClientWsMessage(rawData as Record<string, unknown>);
      if (!data) return;
      const chatId = 'chatId' in data ? (data.chatId as string) || null : null;

      if (data instanceof AgentRunRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#handleAgentCommand(data, chatId, writer);
      } else if (data instanceof AgentStopRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#handleAbortSession(data, chatId);
      } else if (data instanceof PermissionDecisionRequest) {
        this.#handlePermissionResponse(data);
      } else if (data instanceof PermissionModeSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.mode === 'string') {
          await this.#registry.updateChat(chatId, { permissionMode: data.mode });
          await this.#providers.setPermissionMode(chatId, data.mode);
        }
      } else if (data instanceof ThinkingModeSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.mode === 'string') {
          await this.#registry.updateChat(chatId, { thinkingMode: data.mode });
        }
      } else if (data instanceof ModelSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (data.model) {
          await this.#registry.updateChat(chatId, { model: data.model });
          await this.#providers.setModel(chatId, data.model);
        }
      } else if (data instanceof ChatLogQueryRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#handleGetMessages(data, chatId, writer);
      } else if (data instanceof ChatRunningQueryRequest) {
        this.#handleGetRunningSessions(data, writer);
      } else if (data instanceof QueueEnqueueRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.content !== 'string' || !data.content.trim()) {
          return writer.send(new WsFaultMessage('queue-enqueue requires non-empty string content'));
        }
        await this.#queue.enqueueChat(chatId, data.content);
        this.#queue.triggerDrain(chatId, this.#drainOptions(chatId)).catch((err: Error) => {
          console.error('queue: enqueue drain error:', err.message);
        });
      } else if (data instanceof QueueDropRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (!data.entryId) {
          return writer.send(new WsFaultMessage('queue-dequeue requires entryId'));
        }
        await this.#queue.dequeueChat(chatId, data.entryId);
      } else if (data instanceof QueueClearRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#queue.clearChatQueue(chatId);
      } else if (data instanceof QueuePauseRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#queue.pauseChatQueue(chatId);
      } else if (data instanceof QueueResumeRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#queue.resumeChatQueue(chatId);
        this.#queue.triggerDrain(chatId, this.#drainOptions(chatId)).catch((err: Error) => {
          console.error('queue: resume drain error:', err.message);
        });
      } else if (data instanceof QueueQueryRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        const queue = await this.#queue.readChatQueue(chatId);
        writer.send(new QueueStateUpdatedMessage(chatId, queue));
      }
    } catch (error: unknown) {
      console.error('ws: chat error:', (error as Error).message);
      writer.send(new WsFaultMessage((error as Error).message));
    }
  }

  // Builds drain options from persisted chat settings for queued turns.
  #drainOptions(chatId: string): RunProviderTurnOptions {
    const entry = requireChatExecutionConfig(chatId, this.#registry.getChat(chatId));
    return {
      permissionMode: entry.permissionMode,
      thinkingMode: entry.thinkingMode,
      model: entry.model,
    };
  }

  #sendMissingSessionError(writer: WebSocketWriter, type: string): void {
    writer.send(new WsFaultMessage(`Missing chatId for "${type}"`));
  }

  #handleClose(_ws: WS, code?: number, reason?: string): void {
    console.log('ws: chat client disconnected', code ?? '', reason ? `(${reason})` : '');
  }
}
