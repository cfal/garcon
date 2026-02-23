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
import { resolveMissingNativePath } from '../chats/resolve-native-path.js';

const PERMISSION_DEDUP_TTL = 30_000;

class WebSocketWriter {
  constructor(ws) {
    this.ws = ws;
  }
  send(data) {
    sendWebSocketJson(this.ws, data);
  }
}

export class ChatHandler {
  #providers;
  #queue;
  #historyCache;
  #registry;
  #recentPermissionDecisions = new Map();

  // providers: ProviderRegistry
  // queue: QueueManager (orchestrator)
  // historyCache: HistoryCache
  // registry: ChatRegistry
  constructor(providers, queue, historyCache, registry) {
    this.#providers = providers;
    this.#queue = queue;
    this.#historyCache = historyCache;
    this.#registry = registry;
  }

  createHandler() {
    return {
      open: (ws) => this.#handleOpen(ws),
      message: (ws, data) => this.#handleMessage(ws, data),
      close: (ws, code, reason) => this.#handleClose(ws, code, reason),
    };
  }

  async #handleAgentCommand(data, chatId, writer) {
    console.log(`chat: ${data.provider || 'unknown'} message:`, data.command || '[continue/resume]');
    console.log('chat: project:', data.options?.projectPath || data.options?.cwd || 'unknown');

    if (!/^\d+$/.test(String(chatId))) {
      writer.send(new AgentRunFailedMessage(chatId, 'Invalid session ID format'));
      return;
    }

    try {
      await this.#queue.submit(chatId, data.command, data.options || {});
    } catch (error) {
      writer.send(new AgentRunFailedMessage(chatId, error.message));
    }
  }

  async #handleAbortSession(data, chatId) {
    console.log('chat: abort session request:', chatId);
    await this.#queue.abort(chatId);
  }

  #handlePermissionResponse(data) {
    if (!data.permissionRequestId || !data.chatId) return;

    if (this.#recentPermissionDecisions.has(data.permissionRequestId)) {
      console.warn('ws: duplicate permission-decision for', data.permissionRequestId, '- ignoring');
      return;
    }
    this.#recentPermissionDecisions.set(data.permissionRequestId, Date.now());
    setTimeout(() => this.#recentPermissionDecisions.delete(data.permissionRequestId), PERMISSION_DEDUP_TTL);

    const decision = {
      allow: Boolean(data.allow),
      alwaysAllow: Boolean(data.alwaysAllow),
    };

    this.#providers.resolvePermission(data.chatId, data.permissionRequestId, decision);
  }

  #sendRequestError(writer, { clientRequestId, requestType, code, message, retryable, chatId }) {
    writer.send(new ClientRequestErrorMessage(
      clientRequestId, requestType, code, message, Boolean(retryable), chatId,
    ));
  }

  async #handleGetMessages(data, chatId, writer) {
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

      if (!session.nativePath) {
        const resolvedPath = await resolveMissingNativePath(session);
        if (!resolvedPath) {
          this.#sendRequestError(writer, {
            clientRequestId, requestType,
            code: 'NATIVE_PATH_UNRESOLVED',
            message: `Could not resolve native path for chat ${chatId}`,
            retryable: true, chatId,
          });
          return;
        }
        session.nativePath = resolvedPath;
        await this.#registry.updateChat(chatId, { nativePath: resolvedPath });
      }

      const limit = parseInt(String(data.limit || '20'), 10);
      const offset = parseInt(String(data.offset || '0'), 10);

      await this.#historyCache.ensureLoaded(chatId);
      const result = this.#historyCache.getPaginatedMessages(chatId, limit, offset);

      writer.send(new ChatLogResponseMessage(
        clientRequestId, chatId, result.messages, result.total,
        result.hasMore, result.offset, result.limit,
      ));
    } catch (error) {
      console.error(`ws: error reading messages for ${chatId}:`, error.message);
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: 'HISTORY_LOAD_FAILED',
        message: error.message || 'Failed to load chat history',
        retryable: true, chatId,
      });
    }
  }

  #handleGetRunningSessions(data, writer) {
    writer.send(new ChatSessionsRunningMessage(this.#providers.getRunningSessions()));
  }

  #handleOpen(ws) {
    console.log('ws: chat client connected');
    ws.subscribe('chat');
  }

  async #handleMessage(ws, rawData) {
    const writer = new WebSocketWriter(ws);
    try {
      const data = parseClientWsMessage(rawData);
      if (!data) return;
      const chatId = 'chatId' in data ? data.chatId || null : null;

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
        this.#queue.triggerDrain(chatId, {
          projectPath: data.projectPath,
          cwd: data.projectPath,
          permissionMode: data.permissionMode,
          toolsSettings: data.toolsSettings,
        }).catch((err) => {
          console.error('queue: resume drain error:', err.message);
        });
      } else if (data instanceof QueueQueryRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        const queue = await this.#queue.readChatQueue(chatId);
        writer.send(new QueueStateUpdatedMessage(chatId, queue));
      }
    } catch (error) {
      console.error('ws: chat error:', error.message);
      writer.send(new WsFaultMessage(error.message));
    }
  }

  #sendMissingSessionError(writer, type) {
    writer.send(new WsFaultMessage(`Missing chatId for "${type}"`));
  }

  #handleClose(ws, code, reason) {
    console.log('ws: chat client disconnected', code ?? '', reason ? `(${reason})` : '');
  }
}
