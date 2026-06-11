// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to QueueManager and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import {
  QueueStateUpdatedMessage,
  AgentRunFailedMessage, ChatLogResponseMessage,
  ChatSessionsRunningMessage, WsFaultMessage, ChatForkCreatedMessage,
  ClientRequestErrorMessage,
} from '../../common/ws-events.ts';
import type { ClientRequestErrorCode } from '../../common/ws-events.ts';
import type { PendingUserInput } from '../../common/pending-user-input.js';
import {
  parseClientWsMessage,
  AgentRunRequest,
  ForkRunRequest,
  AgentStopRequest,
  PermissionDecisionRequest,
  ClaudeThinkingModeSetRequest,
  AmpAgentModeSetRequest,
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
import type { QueueState } from '../../common/queue-state.ts';
import type { ChatMessage } from '../../common/chat-types.ts';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import type { AgentSessionSettingsPatch, RunAgentTurnOptions } from "../agents/session-types.js";
import {
  ChatCommandService,
  runOptionsFromCommandRequest,
} from '../commands/chat-command-service.js';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../lib/pagination.js';

const PERMISSION_DEDUP_TTL = 30_000;

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

interface AgentRegistryDep {
  getRunningSessions(): Record<string, Array<{ id: string; [key: string]: unknown }>>;
  resolvePermission(chatId: string, permissionRequestId: string, decision: { allow: boolean; alwaysAllow: boolean }): void;
  updateSessionSettings(chatId: string, patch: AgentSessionSettingsPatch): Promise<unknown>;
  hasAgent(agentId: string): boolean;
  supportsFork(agentId: string): boolean;
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean;
}

interface QueueManagerDep {
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  abort(chatId: string): Promise<boolean>;
  triggerDrain(chatId: string): Promise<void>;
  readChatQueue(chatId: string): Promise<QueueState>;
  enqueueChat(chatId: string, content: string): Promise<unknown>;
  dequeueChat(chatId: string, entryId: string): Promise<unknown>;
  clearChatQueue(chatId: string): Promise<unknown>;
  pauseChatQueue(chatId: string): Promise<unknown>;
  resumeChatQueue(chatId: string): Promise<unknown>;
}

interface ForkSettingsDep {
  getChatName(chatId: string): string | null;
  ensureInNormal(chatId: string): Promise<void>;
  setSessionName(chatId: string, title: string): Promise<void>;
}

interface ForkMetadataDep {
  getChatMetadata(chatId: string): Record<string, unknown> | null;
  addNewChatMetadata(chatId: string, command: string): void;
}

interface ForkDeps {
  settings: ForkSettingsDep;
  metadata: ForkMetadataDep;
  forkChatFileCopy(args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
    registry: IChatRegistry;
    settings: ForkSettingsDep;
    metadata: ForkMetadataDep;
    forkAgentSession?: (args: {
      sourceSession: ChatRegistryEntry;
      sourceChatId: string;
      targetChatId: string;
    }) => Promise<{ agentSessionId: string; nativePath: string | null } | null>;
  }): Promise<{ sourceChatId: string; chatId: string; agentId?: string }>;
  forkAgentSession?(args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
  }): Promise<{ agentSessionId: string; nativePath: string | null } | null>;
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

interface PendingInputsDep {
  reconcile(chatId: string): Promise<void>;
  listForChat(chatId: string): unknown[];
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
  #agents: AgentRegistryDep;
  #queue: QueueManagerDep;
  #historyCache: HistoryCacheDep;
  #pendingInputs: PendingInputsDep;
  #registry: IChatRegistry;
  #commands: ChatCommandService;
  #forkDeps: ForkDeps | null;
  #recentPermissionDecisions = new Map<string, number>();

  constructor(
    agents: AgentRegistryDep,
    queue: QueueManagerDep,
    historyCache: HistoryCacheDep,
    registry: IChatRegistry,
    pendingInputs: PendingInputsDep = {
      reconcile: () => Promise.resolve(),
      listForChat: () => [],
    },
    forkDeps?: ForkDeps | null,
    commands?: ChatCommandService | null,
  ) {
    this.#agents = agents;
    this.#queue = queue;
    this.#historyCache = historyCache;
    this.#pendingInputs = pendingInputs;
    this.#registry = registry;
    this.#commands = commands ?? new ChatCommandService({ chats: registry, queue });
    this.#forkDeps = forkDeps ?? null;
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
      await this.#commands.submitRun({
        transport: 'websocket',
        chatId,
        command: data.command,
        images: data.images,
        options: runOptionsFromCommandRequest(data),
      });
    } catch (error: unknown) {
      writer.send(new AgentRunFailedMessage(chatId, (error as Error).message));
    }
  }

  async #handleForkRun(data: ForkRunRequest, writer: WebSocketWriter): Promise<void> {
    const sourceChatId = data.sourceChatId;
    const targetChatId = data.chatId;

    if (!/^\d+$/.test(String(sourceChatId))) {
      writer.send(new WsFaultMessage('Invalid sourceChatId format'));
      return;
    }
    if (!/^\d+$/.test(String(targetChatId))) {
      writer.send(new AgentRunFailedMessage(sourceChatId, 'Invalid fork target session ID format'));
      return;
    }
    if (sourceChatId === targetChatId) {
      writer.send(new AgentRunFailedMessage(sourceChatId, 'sourceChatId and chatId must differ'));
      return;
    }
    if (!this.#forkDeps) {
      writer.send(new AgentRunFailedMessage(sourceChatId, 'Forking is not configured on this server'));
      return;
    }

    const sourceSession = this.#registry.getChat(sourceChatId);
    if (!sourceSession) {
      writer.send(new AgentRunFailedMessage(sourceChatId, 'Source session not found'));
      return;
    }
    if (!this.#agents.supportsFork(sourceSession.agentId)) {
      writer.send(new AgentRunFailedMessage(sourceChatId, `Fork unsupported for agent: ${sourceSession.agentId}`));
      return;
    }
    if (this.#agents.isAgentSessionRunning(sourceSession.agentId, sourceSession.agentSessionId)) {
      writer.send(new AgentRunFailedMessage(sourceChatId, 'Cannot fork a chat while it is processing'));
      return;
    }
    if (this.#registry.getChat(targetChatId)) {
      writer.send(new AgentRunFailedMessage(sourceChatId, `Session already exists: ${targetChatId}`));
      return;
    }

    try {
      await this.#commands.submitForkRun({
        transport: 'websocket',
        sourceChatId,
        chatId: targetChatId,
        command: data.command,
        images: data.images,
        options: runOptionsFromCommandRequest(data),
        ensureForked: async () => {
          const result = await this.#forkDeps!.forkChatFileCopy({
            sourceSession,
            sourceChatId,
            targetChatId,
            registry: this.#registry,
            settings: this.#forkDeps!.settings,
            metadata: this.#forkDeps!.metadata,
            forkAgentSession: this.#forkDeps!.forkAgentSession,
          });
          writer.send(new ChatForkCreatedMessage(result.sourceChatId, result.chatId));
        },
      });
    } catch (error: unknown) {
      const chatId = this.#registry.getChat(targetChatId) ? targetChatId : sourceChatId;
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

    this.#agents.resolvePermission(data.chatId, data.permissionRequestId, decision);
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

      const { limit, offset } = parsePagination(data.limit, data.offset, { maxLimit: CHAT_MESSAGES_MAX_LIMIT });

      await this.#historyCache.ensureLoaded(chatId);
      await this.#pendingInputs.reconcile(chatId);
      const result = this.#historyCache.getPaginatedMessages(chatId, limit, offset);

      writer.send(new ChatLogResponseMessage(
        clientRequestId, chatId, result.messages as ChatMessage[], this.#pendingInputs.listForChat(chatId) as PendingUserInput[], result.total,
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
    writer.send(new ChatSessionsRunningMessage(this.#agents.getRunningSessions()));
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
      } else if (data instanceof ForkRunRequest) {
        await this.#handleForkRun(data, writer);
      } else if (data instanceof AgentStopRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        await this.#handleAbortSession(data, chatId);
      } else if (data instanceof PermissionDecisionRequest) {
        this.#handlePermissionResponse(data);
      } else if (data instanceof PermissionModeSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.mode === 'string') {
          await this.#agents.updateSessionSettings(chatId, { permissionMode: data.mode });
        }
      } else if (data instanceof ThinkingModeSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.mode === 'string') {
          await this.#agents.updateSessionSettings(chatId, { thinkingMode: data.mode });
        }
      } else if (data instanceof ClaudeThinkingModeSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.mode === 'string') {
          await this.#agents.updateSessionSettings(chatId, { claudeThinkingMode: data.mode });
        }
      } else if (data instanceof AmpAgentModeSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (typeof data.mode === 'string') {
          await this.#agents.updateSessionSettings(chatId, { ampAgentMode: data.mode });
        }
      } else if (data instanceof ModelSetRequest) {
        if (!chatId) return this.#sendMissingSessionError(writer, data.type);
        if (data.model) {
          const patch: AgentSessionSettingsPatch = { model: data.model };
          if (data.apiProviderId !== undefined) patch.apiProviderId = data.apiProviderId;
          if (data.modelEndpointId !== undefined) patch.modelEndpointId = data.modelEndpointId;
          if (data.modelProtocol !== undefined) patch.modelProtocol = data.modelProtocol;
          await this.#agents.updateSessionSettings(chatId, patch);
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
        this.#queue.triggerDrain(chatId).catch((err: Error) => {
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
        this.#queue.triggerDrain(chatId).catch((err: Error) => {
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

  #sendMissingSessionError(writer: WebSocketWriter, type: string): void {
    writer.send(new WsFaultMessage(`Missing chatId for "${type}"`));
  }

  #handleClose(_ws: WS, code?: number, reason?: string): void {
    console.log('ws: chat client disconnected', code ?? '', reason ? `(${reason})` : '');
  }
}
