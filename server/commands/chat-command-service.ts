import crypto from 'crypto';
import { promises as fs } from 'fs';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import type {
  AgentStopResponse,
  CommandAcceptedResponse,
  CommandErrorCode,
  PermissionDecisionPayload,
  ProjectPathPatchResponse,
  QueueEnqueueResponse,
  QueueMutationResponse,
} from '../../common/chat-command-contracts.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import type { AgentRunCommandRequest, ForkRunCommandRequest } from '../../common/chat-command-contracts.js';
import { normalizeQueueState, toClientQueueState } from '../../common/queue-state.js';
import type { QueueState } from '../../common/queue-state.js';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import type { ChatMessage } from '../../common/chat-types.js';
import type { RunAgentTurnOptions, StartedAgentSession } from '../agents/session-types.js';
import { isArtificialNativePath } from '../chats/artificial-native-path.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { PRE_SCHEDULE_FAILURE_ERROR_CODE, type CommandLedger, type CommandLedgerRecord } from './command-ledger.js';
import type { ChatQueueService } from '../queue.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ForkChatFileCopyResult } from '../chats/fork-chat.js';
import { getNativeMessageSource } from '../agents/shared/native-message-source.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('commands:chat-command-service');

type QueueDep = Pick<
  ChatQueueService,
  | 'registerPendingUserInput'
  | 'discardPendingUserInput'
  | 'runAcceptedTurn'
  | 'abort'
  | 'triggerDrain'
  | 'readChatQueue'
  | 'enqueueChat'
  | 'dequeueChat'
  | 'clearChatQueue'
  | 'pauseChatQueue'
  | 'resumeChatQueue'
>;

interface SettingsDep {
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  recordChatStartup(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
}

interface MetadataDep {
  addNewChatMetadata(chatId: string, command: string): void;
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
}

type PendingInputsDep = Pick<PendingUserInputServiceContract, 'clearChat' | 'listForChat' | 'reconcile'>;

type AgentRegistryDep = Pick<
  AgentRegistryServiceContract,
  | 'hasAgent'
  | 'supportsImages'
  | 'modelSupportsImages'
  | 'startSession'
  | 'resolvePermission'
  | 'getAgentAuthStatusMap'
  | 'getAgentReadinessMap'
  | 'getAgentCatalogEntries'
  | 'runSingleQuery'
  | 'supportsFork'
  | 'supportsForkWhileRunning'
  | 'supportsUpdateProjectPath'
  | 'isAgentSessionRunning'
  | 'forkAgentSession'
  | 'compactSession'
  | 'resolveNativePath'
  | 'prepareProjectPathUpdate'
>;

interface ForkChatInput {
  sourceChatId: string;
  chatId: string;
  upToSeq?: unknown;
}

type ForkChatFileCopyDep = (args: {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  truncateAfterEntryId?: string;
  truncateAfterLine?: number;
  registry: IChatRegistry;
  settings: SettingsDep;
  metadata: MetadataDep;
  forkAgentSession?: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
  }) => Promise<StartedAgentSession | null>;
  supportsFork?: (agentId: string) => boolean;
}) => Promise<ForkChatFileCopyResult>;

interface ForkContext {
  sourceChatId: string;
  targetChatId: string;
  sourceSession: ChatRegistryEntry;
  upToSeq?: number;
}

interface NativeMessagesDep {
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
}

interface ForkTruncatePoint {
  entryId?: string;
  lineNumber?: number;
}

interface SubmitRunInput {
  chatId: string;
  command: string;
  images?: RunAgentTurnOptions['images'];
  clientRequestId?: string;
  clientMessageId?: string;
  options?: RunAgentTurnOptions;
  payload?: Record<string, unknown>;
}

interface SubmitForkRunInput extends SubmitRunInput {
  sourceChatId: string;
}

interface SubmitStartInput {
  chatId: string;
  agentId: string;
  projectPath: string;
  command: string;
  model: string;
  apiProviderId?: string | null;
  modelEndpointId?: string | null;
  modelProtocol?: ApiProtocol | null;
  permissionMode?: unknown;
  thinkingMode?: unknown;
  claudeThinkingMode?: unknown;
  ampAgentMode?: unknown;
  tags?: unknown[];
  requestOptions?: Record<string, unknown>;
  images?: RunAgentTurnOptions['images'];
  clientRequestId?: string;
  clientMessageId?: string;
}

interface QueueEnqueueInput {
  chatId: string;
  content: string;
  clientRequestId: string;
}

interface QueueDirectEnqueueInput {
  chatId: string;
  content: string;
}

interface QueueMutationInput {
  chatId: string;
  action: 'dequeue' | 'clear' | 'pause' | 'resume';
  entryId?: string;
}

interface PermissionDecisionInput extends PermissionDecisionPayload {
  chatId: string;
  permissionRequestId: string;
  clientRequestId: string;
}

interface StopInput {
  chatId: string;
  clientRequestId: string;
  agentId?: unknown;
}

interface CompactInput {
  chatId: string;
  clientRequestId: string;
  instructions?: string;
}

interface UpdateProjectPathInput {
  chatId: string;
  projectPath: string;
}

export class CommandValidationError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly status = 400,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CommandValidationError';
  }
}

export function commandResultFromRecord(
  record: CommandLedgerRecord,
  status: CommandAcceptedResponse['status'] = 'accepted',
): CommandAcceptedResponse {
  return {
    success: true,
    commandType: record.commandType,
    clientRequestId: record.clientRequestId,
    chatId: record.chatId,
    turnId: record.turnId,
    status,
    acceptedAt: record.acceptedAt,
  };
}

export function runOptionsFromCommandRequest(
  body: Partial<AgentRunCommandRequest | ForkRunCommandRequest>,
): RunAgentTurnOptions {
  const options: RunAgentTurnOptions = {};
  if (body.images !== undefined) options.images = body.images;
  if (body.model !== undefined) options.model = body.model;
  if (body.permissionMode !== undefined) options.permissionMode = normalizePermissionMode(body.permissionMode);
  if (body.thinkingMode !== undefined) options.thinkingMode = normalizeThinkingMode(body.thinkingMode);
  if (body.claudeThinkingMode !== undefined) options.claudeThinkingMode = normalizeClaudeThinkingMode(body.claudeThinkingMode);
  if (body.ampAgentMode !== undefined) options.ampAgentMode = normalizeAmpAgentMode(body.ampAgentMode);
  if (body.apiProviderId !== undefined) options.apiProviderId = body.apiProviderId;
  if (body.modelEndpointId !== undefined) options.modelEndpointId = body.modelEndpointId;
  if (body.modelProtocol !== undefined) options.modelProtocol = body.modelProtocol;
  return options;
}

interface ChatCommandServiceDeps {
  chats: IChatRegistry;
  queue: QueueDep;
  ledger: CommandLedger;
  settings: SettingsDep;
  metadata: MetadataDep;
  agents: AgentRegistryDep;
  pendingInputs: PendingInputsDep;
  nativeMessages?: NativeMessagesDep;
  forkChatFileCopy?: ForkChatFileCopyDep;
}

export class ChatCommandService {
  #chatMutationLocks = new KeyedPromiseLock();

  constructor(private readonly deps: ChatCommandServiceDeps) {}

  #withChatMutationLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.#chatMutationLocks.runExclusive(`chat:${chatId}`, fn);
  }

  async submitStart(input: SubmitStartInput): Promise<CommandAcceptedResponse> {
    const clientRequestId = input.clientRequestId?.trim() || crypto.randomUUID();
    const clientMessageId = input.clientMessageId?.trim() || crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const chatId = input.chatId.trim();
    const agentId = input.agentId.trim();
    const projectPath = input.projectPath.trim();
    const command = input.command.trim();
    const images = input.images ?? [];

    if (!chatId || !/^\d+$/.test(chatId)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Valid numeric chatId is required');
    }
    if (!agentId) throw new CommandValidationError('VALIDATION_FAILED', 'agentId is required');
    if (!this.deps.agents.hasAgent(agentId)) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Unsupported agent: ${agentId}`);
    }
    if (images.length > 0) {
      let imageSupport = false;
      try {
        imageSupport = await this.deps.agents.modelSupportsImages({
          agentId,
          model: input.model,
          apiProviderId: input.apiProviderId,
          modelEndpointId: input.modelEndpointId,
        });
      } catch {}
      const hasBackendSelection = Boolean(input.apiProviderId && input.modelEndpointId);
      const supportsImages = hasBackendSelection ? imageSupport : this.deps.agents.supportsImages(agentId);
      if (!supportsImages) {
        throw new CommandValidationError('UNSUPPORTED_AGENT', `Images unsupported for agent: ${agentId}`, 422);
      }
    }
    if (!projectPath) throw new CommandValidationError('VALIDATION_FAILED', 'projectPath is required');
    try {
      await fs.access(projectPath);
    } catch {
      throw new CommandValidationError('VALIDATION_FAILED', `Project path not found: ${projectPath}`, 404);
    }
    if (!command) throw new CommandValidationError('VALIDATION_FAILED', 'command is required');

    const tags = Array.isArray(input.tags) ? input.tags : [agentId];
    const ledger = await this.deps.ledger.accept({
      commandType: 'chat-start',
      chatId,
      clientRequestId,
      turnId,
      payload: {
        chatId,
        clientMessageId,
        agentId,
        projectPath,
        command,
        model: input.model,
        images,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
        modelProtocol: input.modelProtocol,
        permissionMode: input.permissionMode,
        thinkingMode: input.thinkingMode,
        claudeThinkingMode: input.claudeThinkingMode,
        ampAgentMode: input.ampAgentMode,
        tags,
      },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') return commandResultFromRecord(ledger.record, 'duplicate');

    const existing = this.deps.chats.getChat(chatId);
    if (existing) {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', `Session already exists: ${chatId}`, 409);
    }

    const permissionMode = normalizePermissionMode(input.permissionMode);
    const thinkingMode = normalizeThinkingMode(input.thinkingMode);
    const claudeThinkingMode = normalizeClaudeThinkingMode(input.claudeThinkingMode);
    const ampAgentMode = normalizeAmpAgentMode(input.ampAgentMode);

    this.deps.chats.addChat({
      id: chatId,
      agentId,
      nativePath: null,
      projectPath,
      tags: tags.filter((tag): tag is string => typeof tag === 'string'),
      agentSessionId: null,
      model: input.model,
      apiProviderId: input.apiProviderId ?? null,
      modelEndpointId: input.modelEndpointId ?? null,
      modelProtocol: input.modelProtocol ?? null,
      permissionMode,
      thinkingMode,
      claudeThinkingMode,
      ampAgentMode,
    });
    this.deps.metadata.addNewChatMetadata(chatId, command);

    await this.deps.settings.recordChatStartup({
      agentId,
      projectPath,
      model: input.model,
      apiProviderId: input.apiProviderId ?? null,
      modelEndpointId: input.modelEndpointId ?? null,
      modelProtocol: input.modelProtocol ?? null,
      permissionMode,
      thinkingMode,
      claudeThinkingMode,
      ampAgentMode,
    });
    try {
      await this.deps.settings.ensureInNormal(chatId);
      await this.deps.queue.registerPendingUserInput(chatId, command, {
        clientRequestId,
        clientMessageId,
        turnId,
        images: images.length > 0 ? images : undefined,
        deliveryStatus: 'accepted',
      });
      await this.deps.ledger.update(ledger.record.key, { status: 'scheduled', turnId });
      await this.deps.agents.startSession(chatId, command, {
        ...(input.requestOptions ?? {}),
        projectPath,
        clientRequestId,
        turnId,
      });
    } catch (error: unknown) {
      await this.deps.ledger.update(ledger.record.key, { status: 'failed', error: (error as Error).message });
      this.deps.pendingInputs.clearChat(chatId, 'chat-removed');
      this.deps.chats.removeChat(chatId);
      try {
        await this.deps.settings.removeFromAllOrderLists(chatId);
      } catch (cleanupError: unknown) {
        logger.warn(`sessions: failed to remove ${chatId} from order lists after startup failure:`, (cleanupError as Error).message);
      }
      throw error;
    }

    void maybeGenerateChatTitle({ chatId, projectPath, firstPrompt: command, agents: this.deps.agents, settings: this.deps.settings });
    const accepted = await this.deps.ledger.updateUnlessStatus(ledger.record.key, ['failed'], { status: 'running', turnId });
    return commandResultFromRecord(accepted ?? ledger.record);
  }

  async submitRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    this.#requireChat(input.chatId);
    this.#assertContent(input.command, input.images);
    return this.#withChatMutationLock(input.chatId, () => this.#submitHttpRun(input));
  }

  async forkChat(input: ForkChatInput): Promise<ForkChatFileCopyResult> {
    const context = this.#validateFork(input);
    return this.#forkChatFromContext(context);
  }

  async submitForkRun(input: SubmitForkRunInput): Promise<CommandAcceptedResponse> {
    this.#assertContent(input.command, input.images);
    return this.#withChatMutationLock(input.chatId, () => this.#submitHttpForkRun(input));
  }

  async submitQueueEnqueue(input: QueueEnqueueInput): Promise<QueueEnqueueResponse> {
    this.#requireChat(input.chatId);
    return this.#withChatMutationLock(input.chatId, () => this.#submitQueueEnqueueLocked(input));
  }

  async #submitQueueEnqueueLocked(input: QueueEnqueueInput): Promise<QueueEnqueueResponse> {
    const ledger = await this.deps.ledger.accept({
      commandType: 'queue-enqueue',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, content: input.content },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') {
      const state = normalizeQueueState(await this.deps.queue.readChatQueue(input.chatId));
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        entryId: ledger.record.entryId ?? '',
        merged: false,
        queue: toClientQueueState(state),
      };
    }

    const before = normalizeQueueState(await this.deps.queue.readChatQueue(input.chatId));
    const result = await this.deps.queue.enqueueChat(input.chatId, input.content);
    const state = normalizeQueueState(result.queue);
    const merged = before.entries.some((entry) => entry.status === 'queued');
    const updated = await this.deps.ledger.update(ledger.record.key, {
      status: 'scheduled',
      entryId: result.entry.id,
    });
    this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
      logger.error('queue: enqueue drain error:', err.message);
    });
    return {
      ...commandResultFromRecord(updated ?? ledger.record),
      entryId: result.entry.id,
      merged,
      queue: toClientQueueState(state),
    };
  }

  async enqueueQueue(input: QueueDirectEnqueueInput): Promise<QueueMutationResponse & { entryId: string }> {
    this.#requireChat(input.chatId);
    return this.#withChatMutationLock(input.chatId, () => this.#enqueueQueueLocked(input));
  }

  async #enqueueQueueLocked(input: QueueDirectEnqueueInput): Promise<QueueMutationResponse & { entryId: string }> {
    const result = await this.deps.queue.enqueueChat(input.chatId, input.content);
    this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
      logger.error('queue: enqueue drain error:', err.message);
    });
    return {
      success: true,
      chatId: input.chatId,
      entryId: result.entry.id,
      queue: toClientQueueState(normalizeQueueState(result.queue)),
    };
  }

  async mutateQueue(input: QueueMutationInput): Promise<QueueMutationResponse> {
    this.#requireChat(input.chatId);
    return this.#withChatMutationLock(input.chatId, () => this.#mutateQueueLocked(input));
  }

  async #mutateQueueLocked(input: QueueMutationInput): Promise<QueueMutationResponse> {
    let state: QueueState | unknown;
    if (input.action === 'dequeue') {
      if (!input.entryId?.trim()) {
        throw new CommandValidationError('VALIDATION_FAILED', 'entryId is required');
      }
      state = await this.deps.queue.dequeueChat(input.chatId, input.entryId.trim());
    } else if (input.action === 'clear') {
      state = await this.deps.queue.clearChatQueue(input.chatId);
    } else if (input.action === 'pause') {
      state = await this.deps.queue.pauseChatQueue(input.chatId);
    } else {
      state = await this.deps.queue.resumeChatQueue(input.chatId);
      this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
        logger.error('queue: resume drain error:', err.message);
      });
    }
    return { success: true, chatId: input.chatId, queue: toClientQueueState(normalizeQueueState(state)) };
  }

  async submitPermissionDecision(input: PermissionDecisionInput): Promise<CommandAcceptedResponse> {
    this.#requireChat(input.chatId);
    const ledger = await this.deps.ledger.accept({
      commandType: 'permission-decision',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: {
        chatId: input.chatId,
        permissionRequestId: input.permissionRequestId,
        allow: input.allow,
        alwaysAllow: input.alwaysAllow,
        ...(input.response ? { response: input.response } : {}),
      },
    });
    this.#throwOnConflict(ledger, 'Conflicting permission decision retry');
    if (ledger.kind !== 'duplicate') {
      this.deps.agents.resolvePermission(input.chatId, input.permissionRequestId, {
        allow: input.allow,
        alwaysAllow: input.alwaysAllow,
        response: input.response,
      });
      await this.deps.ledger.update(ledger.record.key, { status: 'scheduled' });
    }
    return commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted');
  }

  async submitStop(input: StopInput): Promise<AgentStopResponse> {
    this.#requireChat(input.chatId);
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-stop',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, agentId: input.agentId },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    let stopped = false;
    if (ledger.kind !== 'duplicate') {
      stopped = await this.deps.queue.abort(input.chatId);
      await this.deps.ledger.update(ledger.record.key, { status: stopped ? 'finished' : 'failed' });
    }
    return {
      ...commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted'),
      stopped: ledger.kind === 'duplicate' ? ledger.record.status === 'finished' : stopped,
    };
  }

  async submitCompact(input: CompactInput): Promise<CommandAcceptedResponse> {
    this.#requireChat(input.chatId);
    return this.#withChatMutationLock(input.chatId, () => this.#submitCompactLocked(input));
  }

  async #submitCompactLocked(input: CompactInput): Promise<CommandAcceptedResponse> {
    // Compaction starts its own turn, so refuse while one is already running to
    // avoid colliding with the active turn (and, for Codex, its app-server session).
    const chat = this.deps.chats.getChat(input.chatId);
    if (chat?.agentSessionId && this.deps.agents.isAgentSessionRunning(chat.agentId, chat.agentSessionId)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Cannot compact while a turn is running', 409);
    }
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-compact',
      chatId: input.chatId,
      clientRequestId,
      payload: { chatId: input.chatId, instructions: input.instructions ?? null },
      turnId,
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    if (ledger.kind !== 'duplicate') {
      // Compaction runs as a background turn; lifecycle and the resulting
      // CompactionMessage stream to the client over WebSocket.
      void this.deps.agents
        .compactSession(input.chatId, { instructions: input.instructions, clientRequestId, turnId })
        .then(() => this.deps.ledger.update(ledger.record.key, { status: 'finished' }))
        .catch((error: unknown) => {
          logger.error('compact: failed to compact chat:', (error as Error)?.message ?? String(error));
          return this.deps.ledger.update(ledger.record.key, { status: 'failed' });
        });
    }

    return commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted');
  }

  async updateProjectPath(input: UpdateProjectPathInput): Promise<ProjectPathPatchResponse> {
    const chatId = input.chatId.trim();
    if (!chatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'chatId is required');
    }
    return this.#withChatMutationLock(chatId, () => this.#updateProjectPathLocked({
      chatId,
      projectPath: input.projectPath,
    }));
  }

  async #updateProjectPathLocked(input: UpdateProjectPathInput): Promise<ProjectPathPatchResponse> {
    const chat = this.deps.chats.getChat(input.chatId);
    if (!chat) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
    }
    if (!this.deps.agents.supportsUpdateProjectPath(chat.agentId)) {
      throw new CommandValidationError(
        'PROJECT_PATH_UPDATE_UNSUPPORTED',
        `Project path updates are not supported for agent: ${chat.agentId}`,
        422,
      );
    }

    const nextProjectPath = await this.#resolveProjectPathForUpdate(input.projectPath);
    if (nextProjectPath === chat.projectPath) {
      return {
        success: true,
        chatId: input.chatId,
        projectPath: chat.projectPath,
        previousProjectPath: chat.projectPath,
        nativePath: chat.nativePath ?? null,
      };
    }

    await this.#assertChatIdleForProjectPathUpdate(input.chatId, chat);
    const nativePath = await this.#nativePathForProjectPathUpdate(chat);

    try {
      await this.deps.agents.prepareProjectPathUpdate(chat.agentId, {
        chatId: input.chatId,
        agentSessionId: chat.agentSessionId,
        previousProjectPath: chat.projectPath,
        nextProjectPath,
        nativePath,
      });
    } catch (error) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        error instanceof Error ? error.message : String(error),
        409,
        true,
      );
    }

    const previousProjectPath = chat.projectPath;
    const patch: Partial<ChatRegistryEntry> = { projectPath: nextProjectPath };
    if (nativePath && nativePath !== chat.nativePath) {
      patch.nativePath = nativePath;
    }
    const updated = await this.deps.chats.updateChat(input.chatId, patch, { flush: true });
    if (!updated) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
    }

    return {
      success: true,
      chatId: input.chatId,
      projectPath: updated.projectPath,
      previousProjectPath,
      nativePath: updated.nativePath ?? null,
    };
  }

  async #resolveProjectPathForUpdate(projectPath: string): Promise<string> {
    const requestedPath = String(projectPath || '').trim();
    if (!requestedPath) {
      throw new CommandValidationError('VALIDATION_FAILED', 'projectPath is required');
    }

    let resolvedPath: string;
    try {
      resolvedPath = await assertRealWithinProjectBase(requestedPath);
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        throw new CommandValidationError(
          'PROJECT_PATH_OUTSIDE_BASE',
          'Project path is outside the allowed base directory',
          403,
        );
      }
      throw error;
    }

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new CommandValidationError(
          'PROJECT_PATH_NOT_FOUND',
          `Project path not found: ${resolvedPath}`,
          404,
        );
      }
      throw error;
    }

    if (!stat.isDirectory()) {
      throw new CommandValidationError(
        'PROJECT_PATH_NOT_DIRECTORY',
        `Project path is not a directory: ${resolvedPath}`,
        400,
      );
    }

    return resolvedPath;
  }

  async #assertChatIdleForProjectPathUpdate(chatId: string, chat: ChatRegistryEntry): Promise<void> {
    if (chat.agentSessionId && this.deps.agents.isAgentSessionRunning(chat.agentId, chat.agentSessionId)) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a turn is running',
        409,
        true,
      );
    }

    const queue = normalizeQueueState(await this.deps.queue.readChatQueue(chatId));
    const sendingEntry = queue.entries.find((entry) => entry.status === 'sending');
    if (sendingEntry) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a queued turn is dispatching',
        409,
        true,
      );
    }
    const queuedEntry = queue.entries.find((entry) => entry.status === 'queued');
    if (queuedEntry) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Clear or run queued messages before updating the project path',
        409,
        true,
      );
    }

    await this.deps.pendingInputs.reconcile(chatId);
    if (this.deps.pendingInputs.listForChat(chatId).length > 0) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a submitted message is still pending',
        409,
        true,
      );
    }
  }

  async #nativePathForProjectPathUpdate(chat: ChatRegistryEntry): Promise<string | null> {
    if (this.#isRealNativePath(chat.nativePath)) return chat.nativePath;

    const resolved = await this.deps.agents.resolveNativePath(chat);
    if (this.#isRealNativePath(resolved)) return resolved;

    if (chat.agentId === 'pi') {
      throw new CommandValidationError(
        'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
        'Cannot update the project path until the Pi session file can be resolved',
        409,
        true,
      );
    }

    return this.#isRealNativePath(chat.nativePath) ? chat.nativePath : null;
  }

  #isRealNativePath(nativePath: unknown): nativePath is string {
    return typeof nativePath === 'string' && nativePath.length > 0 && !isArtificialNativePath(nativePath);
  }

  async #submitHttpRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-run',
      chatId: input.chatId,
      clientRequestId,
      payload: input.payload ?? runPayload(input, clientMessageId),
      turnId,
    });
    return this.#scheduleAcceptedHttpRun(ledger, input, { clientRequestId, clientMessageId, turnId });
  }

  async #submitHttpForkRun(input: SubmitForkRunInput): Promise<CommandAcceptedResponse> {
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'fork-run',
      chatId: input.chatId,
      clientRequestId,
      payload: input.payload ?? forkPayload(input, clientMessageId),
      turnId,
    });

    if (ledger.kind === 'conflict') {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', 'clientRequestId was reused with different payload', 409);
    }
    if (ledger.kind === 'duplicate') return commandResultFromRecord(ledger.record, 'duplicate');

    try {
      await this.#forkChatFromContext(this.#validateFork(input));
    } catch (error: unknown) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return this.#scheduleAcceptedHttpRun(ledger, input, { clientRequestId, clientMessageId, turnId });
  }

  async #scheduleAcceptedHttpRun(
    ledger: Awaited<ReturnType<CommandLedger['accept']>>,
    input: SubmitRunInput,
    ids: { clientRequestId: string; clientMessageId: string; turnId: string },
  ): Promise<CommandAcceptedResponse> {
    if (ledger.kind === 'conflict') {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', 'clientRequestId was reused with different payload', 409);
    }
    if (ledger.kind === 'duplicate') return commandResultFromRecord(ledger.record, 'duplicate');

    const options = this.#withTurnIds(input.options ?? {}, {
      ...ids,
      turnId: ledger.record.turnId ?? ids.turnId,
    });
    if (input.images !== undefined) options.images = input.images;

    try {
      await this.#registerPendingInput(input.chatId, input.command, options);
    } catch (error) {
      try {
        this.deps.queue.discardPendingUserInput(input.chatId, options.clientRequestId!);
      } catch {}
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
      });
      throw error;
    }

    const scheduled = await this.deps.ledger.update(ledger.record.key, {
      status: 'scheduled',
      turnId: options.turnId,
    });

    this.#runAcceptedTurn(ledger.record.key, input.chatId, input.command, options);
    return commandResultFromRecord(scheduled ?? ledger.record);
  }

  async #registerPendingInput(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void> {
    await this.deps.queue.registerPendingUserInput(chatId, command, options);
  }

  #runAcceptedTurn(ledgerKey: string, chatId: string, command: string, options: RunAgentTurnOptions): void {
    void this.deps.queue.runAcceptedTurn(chatId, command, options)
      .then(() => this.deps.ledger.update(ledgerKey, { status: 'finished' }))
      .catch((error: Error) => {
        logger.error('commands: run failed:', error.message);
        this.deps.ledger.update(ledgerKey, { status: 'failed', error: error.message }).catch(() => {});
      });
  }

  #withTurnIds(
    options: RunAgentTurnOptions,
    ids: { clientRequestId?: string; clientMessageId?: string; turnId?: string },
  ): RunAgentTurnOptions {
    return {
      ...options,
      clientRequestId: ids.clientRequestId ?? options.clientRequestId ?? crypto.randomUUID(),
      clientMessageId: ids.clientMessageId ?? options.clientMessageId ?? crypto.randomUUID(),
      turnId: ids.turnId ?? options.turnId ?? crypto.randomUUID(),
    };
  }

  #requireChat(chatId: string, message = 'Session not found'): void {
    if (!this.deps.chats.getChat(chatId)) {
      throw new CommandValidationError('SESSION_NOT_FOUND', message, 404);
    }
  }

  #validateFork(input: ForkChatInput): ForkContext {
    const sourceChatId = String(input.sourceChatId || '').trim();
    const targetChatId = String(input.chatId || '').trim();
    const upToSeq = this.#normalizeForkSeq(input.upToSeq);

    if (!sourceChatId || !/^\d+$/.test(sourceChatId)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Valid numeric sourceChatId is required');
    }
    if (!targetChatId || !/^\d+$/.test(targetChatId)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Valid numeric chatId is required');
    }
    if (sourceChatId === targetChatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'sourceChatId and chatId must differ');
    }
    if (!this.deps.forkChatFileCopy) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    const sourceSession = this.deps.chats.getChat(sourceChatId);
    if (!sourceSession) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Source session not found', 404);
    }
    if (!this.deps.agents.supportsFork(sourceSession.agentId)) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Fork unsupported for agent: ${sourceSession.agentId}`, 422);
    }
    if (
      this.deps.agents.isAgentSessionRunning(sourceSession.agentId, sourceSession.agentSessionId)
      && !this.deps.agents.supportsForkWhileRunning(sourceSession.agentId)
    ) {
      throw new CommandValidationError('SESSION_BUSY', 'Cannot fork a chat while it is processing', 409, true);
    }
    if (this.deps.chats.getChat(targetChatId)) {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', `Session already exists: ${targetChatId}`, 409);
    }

    return { sourceChatId, targetChatId, sourceSession, ...(upToSeq ? { upToSeq } : {}) };
  }

  async #forkChatFromContext(context: ForkContext): Promise<ForkChatFileCopyResult> {
    if (!this.deps.forkChatFileCopy) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    const truncatePoint = await this.#resolveForkTruncatePoint(context);

    return this.deps.forkChatFileCopy({
      sourceSession: context.sourceSession,
      sourceChatId: context.sourceChatId,
      targetChatId: context.targetChatId,
      ...(truncatePoint?.entryId ? { truncateAfterEntryId: truncatePoint.entryId } : {}),
      ...(truncatePoint?.lineNumber ? { truncateAfterLine: truncatePoint.lineNumber } : {}),
      registry: this.deps.chats,
      settings: this.deps.settings,
      metadata: this.deps.metadata,
      forkAgentSession: this.deps.agents.forkAgentSession?.bind(this.deps.agents),
      supportsFork: this.deps.agents.supportsFork.bind(this.deps.agents),
    });
  }

  #normalizeForkSeq(value: unknown): number | undefined {
    if (value == null || value === '') return undefined;
    const parsed = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
      throw new CommandValidationError('VALIDATION_FAILED', 'upToSeq must be a positive integer');
    }
    return parsed;
  }

  async #resolveForkTruncatePoint(context: ForkContext): Promise<ForkTruncatePoint | undefined> {
    if (!context.upToSeq) return undefined;
    if (!this.deps.nativeMessages) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Message-point forking is not configured on this server', 503, true);
    }

    const messages = await this.deps.nativeMessages.loadNativeMessages(context.sourceChatId);
    const target = messages[context.upToSeq - 1];
    if (!target) {
      throw new CommandValidationError('VALIDATION_FAILED', `Message not found for seq ${context.upToSeq}`, 404);
    }

    const source = getNativeMessageSource(target);
    const lineNumber = source?.lineNumber;
    const entryId = typeof source?.entryId === 'string' && source.entryId.trim() ? source.entryId : undefined;
    if ((!lineNumber || !Number.isInteger(lineNumber) || lineNumber <= 0) && !entryId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Cannot fork from this message because its native source position is unavailable');
    }
    return {
      ...(entryId ? { entryId } : {}),
      ...(lineNumber && Number.isInteger(lineNumber) && lineNumber > 0 ? { lineNumber } : {}),
    };
  }

  #assertContent(command: string, images?: RunAgentTurnOptions['images']): void {
    if (!command.trim() && (!images || images.length === 0)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'command or images are required');
    }
  }

  #requireClientRequestId(value: string | undefined, field = 'clientRequestId'): string {
    if (!value?.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', `${field} is required`);
    }
    return value.trim();
  }

  #throwOnConflict(
    ledger: Awaited<ReturnType<CommandLedger['accept']>>,
    message: string,
  ): void {
    if (ledger.kind === 'conflict') {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', message, 409);
    }
  }
}

function runPayload(input: SubmitRunInput, clientMessageId: string): Record<string, unknown> {
  return {
    chatId: input.chatId,
    clientMessageId,
    command: input.command,
    images: input.images,
    permissionMode: input.options?.permissionMode,
    thinkingMode: input.options?.thinkingMode,
    claudeThinkingMode: input.options?.claudeThinkingMode,
    ampAgentMode: input.options?.ampAgentMode,
    model: input.options?.model,
    apiProviderId: input.options?.apiProviderId,
    modelEndpointId: input.options?.modelEndpointId,
    modelProtocol: input.options?.modelProtocol,
  };
}

function forkPayload(input: SubmitForkRunInput, clientMessageId: string): Record<string, unknown> {
  return {
    sourceChatId: input.sourceChatId,
    chatId: input.chatId,
    clientMessageId,
    command: input.command,
    images: input.images,
    permissionMode: input.options?.permissionMode,
    thinkingMode: input.options?.thinkingMode,
    claudeThinkingMode: input.options?.claudeThinkingMode,
    ampAgentMode: input.options?.ampAgentMode,
    model: input.options?.model,
    apiProviderId: input.options?.apiProviderId,
    modelEndpointId: input.options?.modelEndpointId,
    modelProtocol: input.options?.modelProtocol,
  };
}
