// WebSocket chat handler. Thin request dispatcher that delegates
// orchestration to QueueManager and state queries to other services.
// All dependencies are injected via the constructor.

import { sendWebSocketJson } from './utils.js';
import {
  QueueStateUpdatedMessage,
  AgentRunFailedMessage, ChatLogResponseMessage,
  ChatSessionsRunningMessage, WsFaultMessage, ChatForkCreatedMessage,
  ClientRequestErrorMessage,
  ChatSubscribedMessage,
  ChatGenerationResetMessage,
  ChatReloadedMessage,
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
  ChatSubscribeRequest,
  ChatReloadRequest,
  ChatRunningQueryRequest,
  QueueEnqueueRequest,
  QueueDropRequest,
  QueueClearRequest,
  QueuePauseRequest,
  QueueResumeRequest,
  QueueQueryRequest,
} from '../../common/ws-requests.ts';
import type { ClientWsMessage } from '../../common/ws-requests.ts';
import type { IChatRegistry } from '../chats/store.js';
import type { AgentSessionSettingsPatch } from "../agents/session-types.js";
import {
  ChatCommandService,
  CommandValidationError,
  runOptionsFromCommandRequest,
} from '../commands/chat-command-service.js';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../lib/pagination.js';
import type { ChatQueueService } from '../queue.js';
import type { ChatEventPageReader } from '../chats/chat-message-reader.js';
import type { ChatEventLog } from '../chats/chat-event-log.js';
import type { ChatNativeReloader } from '../chats/chat-native-reload.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('ws:chat');

const PERMISSION_DEDUP_TTL_MS = 30_000;

// Bun's ServerWebSocket parameterized over the per-socket data bag.
type WS = import('bun').ServerWebSocket<unknown>;

type AgentRegistryDep = Pick<
  AgentRegistryServiceContract,
  'getRunningSessions' | 'resolvePermission' | 'updateSessionSettings'
>;

type QueueManagerDep = Pick<
  ChatQueueService,
  | 'submit'
  | 'abort'
  | 'triggerDrain'
  | 'readChatQueue'
  | 'enqueueChat'
  | 'dequeueChat'
  | 'clearChatQueue'
  | 'pauseChatQueue'
  | 'resumeChatQueue'
>;

type ChatEventsDep = ChatEventPageReader & Pick<ChatEventLog, 'readReplay'>;
type NativeReloaderDep = Pick<ChatNativeReloader, 'reloadFromNative'>;

type PendingInputsDep = Pick<PendingUserInputServiceContract, 'reconcile' | 'listForChat'>;

type WsRequestHandler = (data: ClientWsMessage, writer: WebSocketWriter) => Promise<void> | void;
type ChatIdRequest = { type: string; chatId?: string | null };
type SettingsModePatchKey = 'permissionMode' | 'thinkingMode' | 'claudeThinkingMode' | 'ampAgentMode';
type SettingsModeRequest =
  | PermissionModeSetRequest
  | ThinkingModeSetRequest
  | ClaudeThinkingModeSetRequest
  | AmpAgentModeSetRequest;
type QueueMutationAction = 'dequeue' | 'clear' | 'pause' | 'resume';

interface ChatHandlerDeps {
  agents: AgentRegistryDep;
  queue: QueueManagerDep;
  chatEvents: ChatEventsDep;
  nativeReloader: NativeReloaderDep;
  registry: IChatRegistry;
  pendingInputs: PendingInputsDep;
  commands: ChatCommandService;
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
  #queue: QueueManagerDep;
  #chatEvents: ChatEventsDep;
  #nativeReloader: NativeReloaderDep;
  #pendingInputs: PendingInputsDep;
  #registry: IChatRegistry;
  #commands: ChatCommandService;
  #recentPermissionDecisions = new Map<string, number>();
  #requestHandlers: Record<ClientWsMessage['type'], WsRequestHandler>;

  constructor({
    agents,
    queue,
    chatEvents,
    nativeReloader,
    registry,
    pendingInputs,
    commands,
  }: ChatHandlerDeps) {
    this.#agents = agents;
    this.#queue = queue;
    this.#chatEvents = chatEvents;
    this.#nativeReloader = nativeReloader;
    this.#pendingInputs = pendingInputs;
    this.#registry = registry;
    this.#commands = commands;
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

  async #handleAgentCommand(data: AgentRunRequest, chatId: string, writer: WebSocketWriter): Promise<void> {
    logger.debug('agent-run request received', {
      chatId,
      hasCommand: Boolean(data.command?.trim()),
      imageCount: Array.isArray(data.images) ? data.images.length : 0,
    });

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

    try {
      await this.#commands.submitForkRun({
        transport: 'websocket',
        sourceChatId,
        chatId: targetChatId,
        command: data.command,
        images: data.images,
        options: runOptionsFromCommandRequest(data),
        onForked: (result) => {
          writer.send(new ChatForkCreatedMessage(result.sourceChatId, result.chatId));
        },
      });
    } catch (error: unknown) {
      const chatId = this.#registry.getChat(targetChatId) ? targetChatId : sourceChatId;
      if (error instanceof CommandValidationError && error.code === 'VALIDATION_FAILED' && error.message.includes('sourceChatId')) {
        writer.send(new WsFaultMessage(error.message));
        return;
      }
      writer.send(new AgentRunFailedMessage(chatId, (error as Error).message));
    }
  }

  async #handleAbortSession(_data: AgentStopRequest, chatId: string): Promise<void> {
    logger.info('chat: abort session request:', chatId);
    await this.#queue.abort(chatId);
  }

  #handlePermissionResponse(data: PermissionDecisionRequest): void {
    if (!data.permissionRequestId || !data.chatId) return;

    if (this.#isDuplicatePermissionDecision(data.chatId, data.permissionRequestId)) {
      logger.warn('ws: duplicate permission-decision for', data.permissionRequestId, '- ignoring');
      return;
    }

    const decision = {
      allow: Boolean(data.allow),
      alwaysAllow: Boolean(data.alwaysAllow),
    };

    this.#agents.resolvePermission(data.chatId, data.permissionRequestId, decision);
  }

  #isDuplicatePermissionDecision(chatId: string, permissionRequestId: string): boolean {
    const now = Date.now();
    this.#prunePermissionDecisionDedup(now);
    const key = `${chatId}:${permissionRequestId}`;
    if (this.#recentPermissionDecisions.has(key)) return true;
    this.#recentPermissionDecisions.set(key, now);
    return false;
  }

  #prunePermissionDecisionDedup(now: number): void {
    for (const [permissionRequestId, decidedAt] of this.#recentPermissionDecisions) {
      if (now - decidedAt >= PERMISSION_DEDUP_TTL_MS) {
        this.#recentPermissionDecisions.delete(permissionRequestId);
      }
    }
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
      const result = await this.#chatEvents.readPage(chatId, limit, data.beforeSeq);

      writer.send(new ChatLogResponseMessage(
        clientRequestId,
        chatId,
        result.logId,
        result.events,
        this.#pendingInputs.listForChat(chatId) as PendingUserInput[],
        result.lastAppendSeq,
        result.pageOldestSeq,
        result.hasMore,
        limit,
        result.localNotice,
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
      const replay = await this.#chatEvents.readReplay(chatId, data.logId, data.afterAppendSeq);
      writer.send(new ChatSubscribedMessage(
        clientRequestId,
        chatId,
        replay.logId,
        replay.mode,
        replay.events,
        replay.lastAppendSeq,
      ));
    } catch (error: unknown) {
      this.#sendRequestError(writer, {
        clientRequestId, requestType,
        code: 'HISTORY_LOAD_FAILED',
        message: (error as Error).message || 'Failed to replay chat events',
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
        reload.logId,
        reload.events,
        reload.lastAppendSeq,
        reload.localNotice,
      ));
      writer.publish(new ChatGenerationResetMessage(
        chatId,
        reload.logId,
        reload.events,
        reload.lastAppendSeq,
        reload.localNotice,
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
      'agent-run': (data, writer) => this.#withChatId(data as AgentRunRequest, writer, (chatId) => {
        return this.#handleAgentCommand(data as AgentRunRequest, chatId, writer);
      }),
      'fork-run': (data, writer) => this.#handleForkRun(data as ForkRunRequest, writer),
      'agent-stop': (data, writer) => this.#withChatId(data as AgentStopRequest, writer, (chatId) => {
        return this.#handleAbortSession(data as AgentStopRequest, chatId);
      }),
      'permission-decision': (data) => this.#handlePermissionResponse(data as PermissionDecisionRequest),
      'permission-mode-set': (data, writer) => this.#handleSettingsModeSet(data as PermissionModeSetRequest, writer, 'permissionMode'),
      'thinking-mode-set': (data, writer) => this.#handleSettingsModeSet(data as ThinkingModeSetRequest, writer, 'thinkingMode'),
      'claude-thinking-mode-set': (data, writer) => this.#handleSettingsModeSet(data as ClaudeThinkingModeSetRequest, writer, 'claudeThinkingMode'),
      'amp-agent-mode-set': (data, writer) => this.#handleSettingsModeSet(data as AmpAgentModeSetRequest, writer, 'ampAgentMode'),
      'model-set': (data, writer) => this.#handleModelSet(data as ModelSetRequest, writer),
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
      'queue-enqueue': (data, writer) => this.#handleQueueEnqueue(data as QueueEnqueueRequest, writer),
      'dequeue-enqueue': (data, writer) => this.#handleQueueMutation(data as QueueDropRequest, writer, 'dequeue'),
      'queue-clear': (data, writer) => this.#handleQueueMutation(data as QueueClearRequest, writer, 'clear'),
      'queue-pause': (data, writer) => this.#handleQueueMutation(data as QueuePauseRequest, writer, 'pause'),
      'queue-resume': (data, writer) => this.#handleQueueMutation(data as QueueResumeRequest, writer, 'resume'),
      'queue-query': (data, writer) => this.#handleQueueQuery(data as QueueQueryRequest, writer),
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

  async #handleSettingsModeSet(data: SettingsModeRequest, writer: WebSocketWriter, key: SettingsModePatchKey): Promise<void> {
    await this.#withChatId(data, writer, async (chatId) => {
      if (typeof data.mode !== 'string') return;
      await this.#agents.updateSessionSettings(chatId, { [key]: data.mode });
    });
  }

  async #handleModelSet(data: ModelSetRequest, writer: WebSocketWriter): Promise<void> {
    await this.#withChatId(data, writer, async (chatId) => {
      if (!data.model) return;
      const patch: AgentSessionSettingsPatch = { model: data.model };
      if (data.apiProviderId !== undefined) patch.apiProviderId = data.apiProviderId;
      if (data.modelEndpointId !== undefined) patch.modelEndpointId = data.modelEndpointId;
      if (data.modelProtocol !== undefined) patch.modelProtocol = data.modelProtocol;
      await this.#agents.updateSessionSettings(chatId, patch);
    });
  }

  async #handleQueueEnqueue(data: QueueEnqueueRequest, writer: WebSocketWriter): Promise<void> {
    await this.#withChatId(data, writer, async (chatId) => {
      if (typeof data.content !== 'string' || !data.content.trim()) {
        writer.send(new WsFaultMessage('queue-enqueue requires non-empty string content'));
        return;
      }
      await this.#commands.enqueueQueue({ chatId, content: data.content });
    });
  }

  async #handleQueueMutation(
    data: QueueDropRequest | QueueClearRequest | QueuePauseRequest | QueueResumeRequest,
    writer: WebSocketWriter,
    action: QueueMutationAction,
  ): Promise<void> {
    await this.#withChatId(data, writer, async (chatId) => {
      if (action === 'dequeue' && !(data instanceof QueueDropRequest && data.entryId)) {
        writer.send(new WsFaultMessage('queue-dequeue requires entryId'));
        return;
      }
      await this.#commands.mutateQueue({
        chatId,
        action,
        entryId: data instanceof QueueDropRequest ? data.entryId : undefined,
      });
    });
  }

  async #handleQueueQuery(data: QueueQueryRequest, writer: WebSocketWriter): Promise<void> {
    await this.#withChatId(data, writer, async (chatId) => {
      const queue = await this.#queue.readChatQueue(chatId);
      writer.send(new QueueStateUpdatedMessage(chatId, queue));
    });
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
