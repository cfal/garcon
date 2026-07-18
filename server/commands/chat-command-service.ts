import crypto from 'crypto';
import { promises as fs } from 'fs';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import type {
  AgentInterruptAndSendResponse,
  AgentStopResponse,
  CommandAcceptedResponse,
  CommandErrorCode,
  ForkChatResponse,
  ForkRunCommandResponse,
  PermissionDecisionPayload,
  ProjectPathPatchResponse,
  ActiveInputCommandRequest,
  ActiveInputCommandResponse,
  QueueEntryCommandResponse,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryDeleteResponse,
  QueueEntryReplaceCommandRequest,
  QueueMutationResponse,
  StartChatCommandResponse,
} from '../../common/chat-command-contracts.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import { InvalidChatIdError, parseChatId, type ChatId } from '../../common/chat-id.js';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
  normalizeThinkingModeForAgent,
} from '../../common/chat-modes.js';
import type { AgentRunCommandRequest, ForkRunCommandRequest } from '../../common/chat-command-contracts.js';
import { normalizeTags } from '../../common/tags.ts';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import type { ChatMessage } from '../../common/chat-types.js';
import type {
  AgentExecutionCommandType,
  RunAgentTurnOptions,
  StartedAgentSession,
} from '../agents/session-types.js';
import { isArtificialNativePath } from '../chats/artificial-native-path.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import {
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  SERVER_RESTART_INTERRUPTED_ERROR_CODE,
  type CommandLedger,
  type CommandLedgerRecord,
} from './command-ledger.js';
import {
  QueueEntryMutationError,
  type ChatQueueService,
  type DirectTurnReservation,
} from '../queue.js';
import { normalizeStoredQueueState, toClientQueueState } from '../queue-state.ts';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ForkTranscriptEntryContext } from '../agents/types.js';
import type { ForkChatFileCopyResult } from '../chats/fork-chat.js';
import { getNativeMessageSource } from '../agents/shared/native-message-source.js';
import { createLogger } from '../lib/log.js';
import { AttachmentValidationError, validateCommandAttachments } from '../attachments/validation.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import { ActiveInputDeliveryError } from '../lib/domain-error.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { PathCache } from '../chats/path-cache.js';

const logger = createLogger('commands:chat-command-service');

type QueueDep = Pick<
  ChatQueueService,
  | 'registerPendingUserInput'
  | 'reserveDirectTurn'
  | 'releaseDirectTurn'
  | 'completeDirectTurn'
  | 'failDirectTurn'
  | 'runReservedTurn'
  | 'stopActiveTurn'
  | 'interruptActiveTurn'
  | 'abortForChatDeletion'
  | 'triggerDrain'
  | 'isChatExecutionReserved'
  | 'hasChatExecutionOwner'
  | 'readChatQueue'
  | 'createChatQueueEntry'
  | 'replaceChatQueueEntry'
  | 'deleteChatQueueEntry'
  | 'deliverActiveInput'
  | 'clearChatQueue'
  | 'pauseChatQueue'
  | 'resumeChatQueue'
  | 'deleteChatQueueFile'
>;

interface SettingsDep {
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  recordChatStartup(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
}

interface MetadataDep {
  addNewChatMetadata(chatId: string, command: string): void;
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
}

interface CarryOverDep {
  copy(sourceChatId: string, targetChatId: string): void;
}

type PendingInputsDep = Pick<
  PendingUserInputServiceContract,
  'clearChat' | 'hasInFlightForChat' | 'markFailed' | 'reconcileRetainedHistory'
>;

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
  | 'supportsForkAtMessage'
  | 'supportsForkWhileRunning'
  | 'supportsUpdateProjectPath'
  | 'requiresNativePathForProjectPathUpdate'
  | 'isAgentSessionRunning'
  | 'forkAgentSession'
  | 'compactSession'
  | 'resolveNativePath'
  | 'rewriteForkTranscriptEntry'
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
  carryOver?: CarryOverDep;
  forkAgentSession?: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
  }) => Promise<StartedAgentSession | null>;
  supportsFork?: (agentId: string) => boolean;
  assertSourceSnapshotStable?: (sourceChanged: boolean) => void;
  rewriteForkTranscriptEntry?: (
    entry: unknown,
    context: ForkTranscriptEntryContext,
  ) => unknown;
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
  images?: unknown;
  clientRequestId?: string;
  clientMessageId?: string;
  options?: RunAgentTurnOptions;
}

interface SubmitForkRunInput extends SubmitRunInput {
  sourceChatId: string;
}

type NormalizedSubmitRunInput = Omit<SubmitRunInput, 'images'> & {
  images?: RunAgentTurnOptions['images'];
};

interface NormalizedSubmitForkRunInput extends NormalizedSubmitRunInput {
  sourceChatId: string;
}

export interface ChatStartInput {
  chatId: string;
  clientRequestId: string;
  clientMessageId: string;
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
  images?: unknown;
}

export interface ScheduledChatStartInput {
  clientRequestId: string;
  clientMessageId: string;
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
}

interface NormalizedChatStart {
  chatId: ChatId;
  clientRequestId: string;
  clientMessageId: string;
  agentId: string;
  projectPath: string;
  command: string;
  images: NonNullable<RunAgentTurnOptions['images']>;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
  permissionMode: ReturnType<typeof normalizePermissionMode>;
  thinkingMode: ReturnType<typeof normalizeThinkingMode>;
  claudeThinkingMode: ReturnType<typeof normalizeClaudeThinkingMode>;
  ampAgentMode: ReturnType<typeof normalizeAmpAgentMode>;
  tags: string[];
}

export interface ScheduledExistingChatInput {
  chatId: string;
  command: string;
  busyBehavior: 'queue' | 'skip';
  clientRequestId: string;
  clientMessageId: string;
}

export type ScheduledExistingChatOutcome =
  | { type: 'sent'; chatId: string }
  | { type: 'queued'; chatId: string; entryId: string }
  | { type: 'skipped-busy'; chatId: string };

interface QueueMutationInput {
  chatId: string;
  action: 'clear' | 'pause' | 'resume';
  pauseId?: string;
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

interface DeleteChatInput {
  chatId: string;
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
  if (body.model !== undefined) options.model = body.model;
  if (body.permissionMode !== undefined) options.permissionMode = normalizePermissionMode(body.permissionMode);
  if (body.thinkingMode !== undefined) options.thinkingMode = normalizeThinkingMode(body.thinkingMode);
  if (body.claudeThinkingMode !== undefined)
    options.claudeThinkingMode = normalizeClaudeThinkingMode(body.claudeThinkingMode);
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
  carryOver?: CarryOverDep;
  chatIds: Pick<ChatIdAllocator, 'allocate'>;
  chatListProjector: Pick<ChatListProjector, 'buildOne'>;
  pathCache: Pick<PathCache, 'resolveProjectPath'>;
  // Shared with AgentSwitchService so agent switches serialize against
  // send/fork/compaction/delete on the same chat. Defaults to a private lock
  // when omitted, which suffices for isolated unit tests.
  chatMutationLock?: KeyedPromiseLock;
}

export class ChatCommandService {
  readonly #chatMutationLocks: KeyedPromiseLock;
  readonly #backgroundTasks = new Set<Promise<void>>();

  constructor(private readonly deps: ChatCommandServiceDeps) {
    this.#chatMutationLocks = deps.chatMutationLock ?? new KeyedPromiseLock();
  }

  async waitForBackgroundTasks(): Promise<void> {
    while (this.#backgroundTasks.size > 0) {
      await Promise.all([...this.#backgroundTasks]);
    }
  }

  #trackBackgroundTask(task: Promise<void>): void {
    this.#backgroundTasks.add(task);
    void task.finally(() => {
      this.#backgroundTasks.delete(task);
    });
  }

  #withChatMutationLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.#chatMutationLocks.runExclusive(`chat:${chatId}`, fn);
  }

  #withChatMutationLocks<T>(chatIds: string[], fn: () => Promise<T>): Promise<T> {
    const orderedChatIds = [...new Set(chatIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const chatId = orderedChatIds[index];
      return chatId === undefined
        ? fn()
        : this.#withChatMutationLock(chatId, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async submitStart(input: ChatStartInput): Promise<StartChatCommandResponse> {
    const normalized = await this.#normalizeStart(input);
    return this.#withChatMutationLock(
      normalized.chatId,
      () => this.#submitNormalizedStart(normalized),
    );
  }

  async submitScheduledStart(input: ScheduledChatStartInput): Promise<StartChatCommandResponse> {
    const normalized = await this.#normalizeStart({
      ...input,
      chatId: this.deps.chatIds.allocate(),
      images: [],
    });
    return this.#withChatMutationLock(
      normalized.chatId,
      () => this.#submitNormalizedStart(normalized),
    );
  }

  async #normalizeStart(input: ChatStartInput): Promise<NormalizedChatStart> {
    const chatId = this.#requireChatId(input.chatId);
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const agentId = input.agentId.trim();
    const command = input.command.trim();
    const model = input.model.trim();
    const images = this.#validateAttachments(input.images) ?? [];

    if (!agentId) throw new CommandValidationError('VALIDATION_FAILED', 'agentId is required');
    if (!this.deps.agents.hasAgent(agentId)) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Unsupported agent: ${agentId}`);
    }
    if (!model) throw new CommandValidationError('VALIDATION_FAILED', 'model is required');
    if (!command && images.length === 0) {
      throw new CommandValidationError('VALIDATION_FAILED', 'command or attachments are required');
    }
    await this.#assertStartImagesSupported({
      agentId,
      model,
      apiProviderId: input.apiProviderId,
      modelEndpointId: input.modelEndpointId,
      images,
    });

    return {
      chatId,
      clientRequestId,
      clientMessageId,
      agentId,
      projectPath: await this.#resolveProjectPathForStart(input.projectPath.trim()),
      command,
      images,
      model,
      apiProviderId: input.apiProviderId ?? null,
      modelEndpointId: input.modelEndpointId ?? null,
      modelProtocol: input.modelProtocol ?? null,
      permissionMode: normalizePermissionMode(input.permissionMode),
      thinkingMode: normalizeThinkingModeForAgent(agentId, input.thinkingMode),
      claudeThinkingMode: normalizeClaudeThinkingMode(input.claudeThinkingMode),
      ampAgentMode: normalizeAmpAgentMode(input.ampAgentMode),
      tags: normalizeTags(Array.isArray(input.tags) ? input.tags : []),
    };
  }

  async #assertStartImagesSupported(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
    images: NonNullable<RunAgentTurnOptions['images']>;
  }): Promise<void> {
    if (input.images.length === 0) return;

    let modelSupportsImages = false;
    try {
      modelSupportsImages = await this.deps.agents.modelSupportsImages({
        agentId: input.agentId,
        model: input.model,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
      });
    } catch {}
    const hasBackendSelection = Boolean(input.apiProviderId && input.modelEndpointId);
    const supportsImages = hasBackendSelection ? modelSupportsImages : this.deps.agents.supportsImages(input.agentId);
    if (!supportsImages) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Attachments unsupported for agent: ${input.agentId}`, 422);
    }
  }

  async #submitNormalizedStart(input: NormalizedChatStart): Promise<StartChatCommandResponse> {
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'chat-start',
      chatId: input.chatId,
      clientRequestId: input.clientRequestId,
      turnId,
      payload: {
        chatId: input.chatId,
        clientMessageId: input.clientMessageId,
        agentId: input.agentId,
        projectPath: input.projectPath,
        command: input.command,
        model: input.model,
        images: input.images,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
        modelProtocol: input.modelProtocol,
        permissionMode: input.permissionMode,
        thinkingMode: input.thinkingMode,
        claudeThinkingMode: input.claudeThinkingMode,
        ampAgentMode: input.ampAgentMode,
        tags: input.tags,
      },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') this.#throwRecordedExecutionFailure(ledger.record);
    if (ledger.kind === 'duplicate') {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        chat: await this.#projectCommandChat(ledger.record.chatId),
      };
    }

    const existing = this.deps.chats.getChat(input.chatId);
    if (existing) {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', `Session already exists: ${input.chatId}`, 409);
    }

    let reservation: DirectTurnReservation;
    try {
      reservation = this.deps.queue.reserveDirectTurn(input.chatId, {
        clientRequestId: input.clientRequestId,
        turnId,
      });
    } catch (error) {
      await this.#markPreScheduleFailure(ledger.record.key, error);
      throw error;
    }

    let runtimeDispatched = false;
    try {
      reservation.executionAdmission.signal.throwIfAborted();
      this.deps.chats.addChat({
        id: input.chatId,
        agentId: input.agentId,
        nativePath: null,
        projectPath: input.projectPath,
        tags: input.tags,
        agentSessionId: null,
        model: input.model,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
        modelProtocol: input.modelProtocol,
        permissionMode: input.permissionMode,
        thinkingMode: input.thinkingMode,
        claudeThinkingMode: input.claudeThinkingMode,
        ampAgentMode: input.ampAgentMode,
      });
      this.deps.metadata.addNewChatMetadata(input.chatId, input.command);

      await this.deps.settings.recordChatStartup({
        agentId: input.agentId,
        projectPath: input.projectPath,
        model: input.model,
        apiProviderId: input.apiProviderId,
        modelEndpointId: input.modelEndpointId,
        modelProtocol: input.modelProtocol,
        permissionMode: input.permissionMode,
        thinkingMode: input.thinkingMode,
        claudeThinkingMode: input.claudeThinkingMode,
        ampAgentMode: input.ampAgentMode,
      });
      await this.deps.settings.ensureInNormal(input.chatId);
      reservation.executionAdmission.signal.throwIfAborted();
      await this.deps.queue.registerPendingUserInput(input.chatId, input.command, {
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        turnId,
        images: input.images.length > 0 ? input.images : undefined,
        deliveryStatus: 'accepted',
      });
      await this.deps.ledger.update(ledger.record.key, {
        status: 'scheduled',
        turnId,
        pendingInputRecovery: 'required',
      });
      reservation.executionAdmission.signal.throwIfAborted();
      runtimeDispatched = true;
      await this.deps.agents.startSession(input.chatId, input.command, {
        projectPath: input.projectPath,
        images: input.images.length > 0 ? input.images : undefined,
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        turnId,
        executionAdmission: reservation.executionAdmission,
      });
    } catch (error: unknown) {
      try {
        await this.deps.ledger.update(ledger.record.key, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (ledgerError: unknown) {
        logger.warn(
          `sessions: failed to record ${input.chatId} startup failure:`,
          ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        );
      }
      this.deps.pendingInputs.clearChat(input.chatId, 'chat-removed');
      this.deps.chats.removeChat(input.chatId);
      try {
        await this.deps.settings.removeFromAllOrderLists(input.chatId);
      } catch (cleanupError: unknown) {
        logger.warn(
          `sessions: failed to remove ${input.chatId} from order lists after startup failure:`,
          (cleanupError as Error).message,
        );
      }
      try {
        if (runtimeDispatched) await this.deps.queue.failDirectTurn(reservation);
        else await this.deps.queue.releaseDirectTurn(reservation);
      } catch (releaseError: unknown) {
        logger.warn(
          `sessions: failed to release ${input.chatId} execution reservation:`,
          releaseError instanceof Error ? releaseError.message : String(releaseError),
        );
      }
      throw error;
    }

    try {
      await this.deps.queue.completeDirectTurn(reservation);
    } catch (releaseError: unknown) {
      logger.error(
        `sessions: failed to complete ${input.chatId} execution reservation:`,
        releaseError instanceof Error ? releaseError.message : String(releaseError),
      );
    }

    void maybeGenerateChatTitle({
      chatId: input.chatId,
      projectPath: input.projectPath,
      firstPrompt: input.command,
      agents: this.deps.agents,
      settings: this.deps.settings,
    });
    const accepted = await this.deps.ledger.updateUnlessStatus(ledger.record.key, ['failed', 'finished'], {
      status: 'running',
      turnId,
    });
    return {
      ...commandResultFromRecord(accepted ?? ledger.record),
      chat: await this.#projectCommandChat(input.chatId),
    };
  }

  async submitRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    this.#requireChat(input.chatId);
    const images = this.#validateAttachments(input.images ?? input.options?.images);
    this.#assertContent(input.command, images);
    return this.#withChatMutationLock(input.chatId, () =>
      this.#submitHttpRun({
        ...input,
        images,
        options: this.#optionsWithoutAttachments(input.options),
      }),
    );
  }

  async forkChat(input: ForkChatInput): Promise<ForkChatResponse> {
    const normalized = {
      ...input,
      sourceChatId: this.#requireChatId(input.sourceChatId, 'sourceChatId'),
      chatId: this.#requireChatId(input.chatId),
    };
    return this.#withChatMutationLocks([normalized.sourceChatId, normalized.chatId], async () => {
      const context = this.#validateFork(normalized);
      await this.#forkChatFromContext(context);
      return { success: true, chat: await this.#projectCommandChat(context.targetChatId) };
    });
  }

  async deleteChat(input: DeleteChatInput): Promise<{ success: true; chatId: string }> {
    const chatId = input.chatId.trim();
    if (!chatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'chatId is required');
    }
    return this.#withChatMutationLock(chatId, () => this.#deleteChatLocked(chatId));
  }

  async #deleteChatLocked(chatId: string): Promise<{ success: true; chatId: string }> {
    this.#requireChat(chatId);

    let retired: boolean;
    try {
      retired = await this.deps.queue.abortForChatDeletion(chatId);
    } catch (error) {
      logger.warn(
        `sessions: abort before deleting ${chatId} failed:`,
        error instanceof Error ? error.message : String(error),
      );
      throw new CommandValidationError(
        'SESSION_BUSY',
        'The active agent session could not be retired for deletion',
        409,
        true,
      );
    }
    if (!retired) {
      throw new CommandValidationError(
        'SESSION_BUSY',
        'The active agent session could not be retired for deletion',
        409,
        true,
      );
    }

    // Removes registry state after abort because abortSession resolves the
    // owning agent through the chat entry.
    this.deps.pendingInputs.clearChat(chatId, 'chat-removed');
    this.deps.chats.removeChat(chatId);

    await Promise.all([
      this.deps.queue.deleteChatQueueFile(chatId).catch(() => {
        // Queue file may not exist.
      }),
      this.deps.settings.removeFromAllOrderLists(chatId).catch(() => {}),
      this.deps.settings.removeSessionName(chatId).catch(() => {}),
    ]);

    return { success: true, chatId };
  }

  async submitForkRun(input: SubmitForkRunInput): Promise<ForkRunCommandResponse> {
    const images = this.#validateAttachments(input.images ?? input.options?.images);
    this.#assertContent(input.command, images);
    const normalized = {
      ...input,
      sourceChatId: this.#requireChatId(input.sourceChatId, 'sourceChatId'),
      chatId: this.#requireChatId(input.chatId),
      images,
      options: this.#optionsWithoutAttachments(input.options),
    };
    return this.#withChatMutationLocks(
      [normalized.sourceChatId, normalized.chatId],
      () => this.#submitHttpForkRun(normalized),
    );
  }

  async submitQueueEntryCreate(input: QueueEntryCreateCommandRequest): Promise<QueueEntryCommandResponse> {
    this.#requireChat(input.chatId);
    this.#assertContent(input.content);
    return this.#withChatMutationLock(input.chatId, () => this.#submitQueueEntryCreateLocked(input));
  }

  async #submitQueueEntryCreateLocked(input: QueueEntryCreateCommandRequest): Promise<QueueEntryCommandResponse> {
    const content = input.content;
    const preparedEntryId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'queue-entry-create',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, content },
      entryId: preparedEntryId,
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    const recoveringAcceptedCommand = ledger.kind === 'duplicate' && ledger.record.status === 'accepted';
    if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
      this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
        logger.error('queue: duplicate create drain error:', err.message);
      });
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        entryId: ledger.record.entryId ?? preparedEntryId,
        queue: toClientQueueState(await this.deps.queue.readChatQueue(input.chatId)),
      };
    }

    let result: Awaited<ReturnType<QueueDep['createChatQueueEntry']>>;
    try {
      result = await this.deps.queue.createChatQueueEntry(input.chatId, content, {
        key: ledger.record.key,
        entryId: ledger.record.entryId ?? preparedEntryId,
      });
    } catch (error) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
      });
      throw error;
    }
    const updated = await this.deps.ledger.update(ledger.record.key, {
      status: 'scheduled',
      entryId: result.entryId,
    });
    this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
      logger.error('queue: create drain error:', err.message);
    });
    return {
      ...commandResultFromRecord(
        updated ?? ledger.record,
        recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
      ),
      entryId: result.entryId,
      queue: toClientQueueState(result.queue),
    };
  }

  async submitQueueEntryReplace(input: QueueEntryReplaceCommandRequest): Promise<QueueEntryCommandResponse> {
    this.#requireChat(input.chatId);
    this.#assertContent(input.content);
    if (!input.entryId.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', 'entryId is required');
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CommandValidationError('VALIDATION_FAILED', 'expectedRevision must be a positive integer');
    }
    return this.#withChatMutationLock(input.chatId, async () => {
      const content = input.content;
      const entryId = input.entryId.trim();
      const ledger = await this.deps.ledger.accept({
        commandType: 'queue-entry-replace',
        chatId: input.chatId,
        clientRequestId: this.#requireClientRequestId(input.clientRequestId),
        payload: {
          chatId: input.chatId,
          entryId,
          content,
          expectedRevision: input.expectedRevision,
        },
        entryId,
      });
      this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      const recoveringAcceptedCommand = ledger.kind === 'duplicate' && ledger.record.status === 'accepted';
      if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
        await this.#throwRecordedQueueMutationFailure(ledger.record);
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          entryId: ledger.record.entryId ?? entryId,
          queue: toClientQueueState(await this.deps.queue.readChatQueue(input.chatId)),
        };
      }

      try {
        const result = await this.deps.queue.replaceChatQueueEntry(
          input.chatId,
          entryId,
          content,
          input.expectedRevision,
          { key: ledger.record.key, entryId },
        );
        const updated = await this.deps.ledger.update(ledger.record.key, {
          status: 'finished',
          entryId,
        });
        return {
          ...commandResultFromRecord(
            updated ?? ledger.record,
            recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
          ),
          entryId,
          queue: toClientQueueState(result.queue),
        };
      } catch (error) {
        const mutationError = error instanceof QueueEntryMutationError ? error : null;
        await this.deps.ledger.update(ledger.record.key, {
          status: mutationError ? 'rejected' : 'failed',
          error: error instanceof Error ? error.message : String(error),
          errorCode: mutationError ? mutationError.code : PRE_SCHEDULE_FAILURE_ERROR_CODE,
        });
        throw error;
      }
    });
  }

  async submitQueueEntryDelete(input: QueueEntryDeleteCommandRequest): Promise<QueueEntryDeleteResponse> {
    this.#requireChat(input.chatId);
    if (!input.entryId.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', 'entryId is required');
    }
    return this.#withChatMutationLock(input.chatId, async () => {
      const entryId = input.entryId.trim();
      const ledger = await this.deps.ledger.accept({
        commandType: 'queue-entry-delete',
        chatId: input.chatId,
        clientRequestId: this.#requireClientRequestId(input.clientRequestId),
        payload: { chatId: input.chatId, entryId },
        entryId,
      });
      this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      const recoveringAcceptedCommand = ledger.kind === 'duplicate' && ledger.record.status === 'accepted';
      if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
        await this.#throwRecordedQueueMutationFailure(ledger.record);
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          entryId: ledger.record.entryId ?? entryId,
          queue: toClientQueueState(await this.deps.queue.readChatQueue(input.chatId)),
        };
      }

      try {
        const result = await this.deps.queue.deleteChatQueueEntry(input.chatId, entryId, {
          key: ledger.record.key,
          entryId,
        });
        const updated = await this.deps.ledger.update(ledger.record.key, {
          status: 'finished',
          entryId,
        });
        return {
          ...commandResultFromRecord(
            updated ?? ledger.record,
            recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
          ),
          entryId,
          queue: toClientQueueState(result.queue),
        };
      } catch (error) {
        const mutationError = error instanceof QueueEntryMutationError ? error : null;
        await this.deps.ledger.update(ledger.record.key, {
          status: mutationError ? 'rejected' : 'failed',
          error: error instanceof Error ? error.message : String(error),
          errorCode: mutationError ? mutationError.code : PRE_SCHEDULE_FAILURE_ERROR_CODE,
        });
        throw error;
      }
    });
  }

  async submitActiveInput(input: ActiveInputCommandRequest): Promise<ActiveInputCommandResponse> {
    this.#requireChat(input.chatId);
    this.#assertContent(input.content);
    return this.#withChatMutationLock(input.chatId, async () => {
      const content = input.content;
      const preparedEntryId = crypto.randomUUID();
      const ledger = await this.deps.ledger.accept({
        commandType: 'active-input',
        chatId: input.chatId,
        clientRequestId: this.#requireClientRequestId(input.clientRequestId),
        payload: { chatId: input.chatId, content },
        entryId: preparedEntryId,
      });
      this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      if (ledger.kind === 'duplicate') {
        if (ledger.record.status === 'failed') {
          throw new CommandValidationError(
            'INTERNAL_ERROR',
            ledger.record.error ?? 'The previous active-input delivery failed after acceptance',
            409,
            false,
          );
        }
        if (ledger.record.status === 'accepted') {
          const queue = await this.deps.queue.readChatQueue(input.chatId);
          const applied = queue.appliedCommands.find(
            (command) => command.key === ledger.record.key && command.operation === 'create',
          );
          if (!applied) {
            throw new CommandValidationError(
              'INTERNAL_ERROR',
              'The previous active-input delivery did not reach a durable outcome',
              409,
              false,
            );
          }
          const updated = await this.deps.ledger.update(ledger.record.key, {
            status: 'scheduled',
            entryId: applied.entryId,
          });
          this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
            logger.error('queue: recovered active fallback drain error:', err.message);
          });
          return {
            ...commandResultFromRecord(updated ?? ledger.record, 'duplicate'),
            delivery: 'queued',
            entryId: applied.entryId,
            queue: toClientQueueState(queue),
          };
        }
        if (ledger.record.entryId) {
          this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
            logger.error('queue: duplicate active fallback drain error:', err.message);
          });
        }
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          delivery: ledger.record.entryId ? 'queued' : 'active',
          ...(ledger.record.entryId ? { entryId: ledger.record.entryId } : {}),
          queue: toClientQueueState(await this.deps.queue.readChatQueue(input.chatId)),
        };
      }

      let deliveryAccepted = false;
      try {
        const delivered = await this.deps.queue.deliverActiveInput(input.chatId, content, {
          clientRequestId: ledger.record.clientRequestId,
        }, async () => {
          await this.deps.ledger.update(ledger.record.key, {
            status: 'scheduled',
            entryId: undefined,
            pendingInputRecovery: 'required',
          });
        });
        if (delivered) {
          deliveryAccepted = true;
          const updated = await this.deps.ledger.update(ledger.record.key, {
            status: 'finished',
            entryId: undefined,
          });
          return {
            ...commandResultFromRecord(updated ?? ledger.record),
            delivery: 'active',
            queue: toClientQueueState(await this.deps.queue.readChatQueue(input.chatId)),
          };
        }

        const result = await this.deps.queue.createChatQueueEntry(input.chatId, content, {
          key: ledger.record.key,
          entryId: ledger.record.entryId ?? preparedEntryId,
        });
        const updated = await this.deps.ledger.update(ledger.record.key, {
          status: 'scheduled',
          entryId: result.entryId,
        });
        this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
          logger.error('queue: active fallback drain error:', err.message);
        });
        return {
          ...commandResultFromRecord(updated ?? ledger.record),
          delivery: 'queued',
          entryId: result.entryId,
          queue: toClientQueueState(result.queue),
        };
      } catch (error) {
        deliveryAccepted ||= error instanceof ActiveInputDeliveryError && error.deliveryAccepted;
        await this.deps.ledger.update(ledger.record.key, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          errorCode: deliveryAccepted ? undefined : PRE_SCHEDULE_FAILURE_ERROR_CODE,
          ...(deliveryAccepted ? { pendingInputRecovery: 'required' as const } : {}),
        });
        throw error;
      }
    });
  }

  async submitScheduledExistingChat(input: ScheduledExistingChatInput): Promise<ScheduledExistingChatOutcome> {
    const chatId = input.chatId.trim();
    const command = input.command.trim();
    this.#assertContent(command);
    return this.#withChatMutationLock(chatId, async () => {
      const session = this.deps.chats.getChat(chatId);
      if (!session) {
        throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
      }
      const busy = this.deps.agents.isAgentSessionRunning(session.agentId, session.agentSessionId)
        || this.deps.queue.isChatExecutionReserved(chatId);
      const queue = await this.deps.queue.readChatQueue(chatId);
      const queueBlocksDirectRun = queue.entries.length > 0 || queue.pause !== null;
      if ((busy || queueBlocksDirectRun) && input.busyBehavior === 'skip') {
        return { type: 'skipped-busy', chatId };
      }
      if (busy || queueBlocksDirectRun) {
        const result = await this.#submitQueueEntryCreateLocked({
          chatId,
          content: command,
          clientRequestId: input.clientRequestId,
        });
        return { type: 'queued', chatId, entryId: result.entryId };
      }
      await this.#submitHttpRun({
        chatId,
        command,
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        options: {},
      });
      return { type: 'sent', chatId };
    });
  }

  async mutateQueue(input: QueueMutationInput): Promise<QueueMutationResponse> {
    this.#requireChat(input.chatId);
    return this.#withChatMutationLock(input.chatId, () => this.#mutateQueueLocked(input));
  }

  async #mutateQueueLocked(input: QueueMutationInput): Promise<QueueMutationResponse> {
    let queue;
    if (input.action === 'clear') {
      queue = await this.deps.queue.clearChatQueue(input.chatId);
    } else if (input.action === 'pause') {
      queue = await this.deps.queue.pauseChatQueue(input.chatId);
    } else {
      if (!input.pauseId) {
        throw new CommandValidationError('VALIDATION_FAILED', 'pauseId is required', 400);
      }
      queue = await this.deps.queue.resumeChatQueue(input.chatId, input.pauseId);
      this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
        logger.error('queue: resume drain error:', err.message);
      });
    }
    return {
      success: true,
      chatId: input.chatId,
      queue: toClientQueueState(queue),
    };
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
    return this.#withChatMutationLock(input.chatId, () => this.#submitStopLocked(input));
  }

  async #submitStopLocked(input: StopInput): Promise<AgentStopResponse> {
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-stop',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, agentId: input.agentId },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    if (ledger.kind === 'duplicate') {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        stopped: ledger.record.status === 'finished',
        queue: toClientQueueState(await this.deps.queue.readChatQueue(input.chatId)),
      };
    }

    try {
      const result = await this.deps.queue.stopActiveTurn(input.chatId);
      const updated = await this.deps.ledger.update(ledger.record.key, {
        status: result.stopped ? 'finished' : 'failed',
      });
      return {
        ...commandResultFromRecord(updated ?? ledger.record),
        stopped: result.stopped,
        queue: toClientQueueState(result.queue),
      };
    } catch (error) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async submitInterruptAndSend(input: StopInput): Promise<AgentInterruptAndSendResponse> {
    this.#requireChat(input.chatId);
    return this.#withChatMutationLock(input.chatId, () => this.#submitInterruptAndSendLocked(input));
  }

  async #submitInterruptAndSendLocked(input: StopInput): Promise<AgentInterruptAndSendResponse> {
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-interrupt-and-send',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, agentId: input.agentId },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    if (ledger.kind === 'duplicate') {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        stopped: ledger.record.status === 'finished',
      };
    }

    try {
      const stopped = await this.deps.queue.interruptActiveTurn(input.chatId);
      const updated = await this.deps.ledger.update(ledger.record.key, {
        status: stopped ? 'finished' : 'failed',
      });
      return {
        ...commandResultFromRecord(updated ?? ledger.record),
        stopped,
      };
    } catch (error) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
      payload: {
        chatId: input.chatId,
        instructions: input.instructions ?? null,
      },
      turnId,
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate') this.#throwRecordedExecutionFailure(ledger.record);

    if (ledger.kind !== 'duplicate') {
      let reservation: DirectTurnReservation;
      try {
        reservation = this.deps.queue.reserveDirectTurn(input.chatId, { clientRequestId, turnId });
      } catch (error) {
        await this.#markPreScheduleFailure(ledger.record.key, error);
        throw error;
      }
      let scheduled: CommandLedgerRecord | null;
      try {
        await this.#assertDirectExecutionQueueAvailable(input.chatId);
        scheduled = await this.deps.ledger.update(ledger.record.key, {
          status: 'scheduled',
          turnId,
        });
      } catch (error) {
        await this.deps.queue.releaseDirectTurn(reservation);
        await this.#markPreScheduleFailure(ledger.record.key, error);
        throw error;
      }
      const compactTask = (async () => {
        let runtimeDispatched = false;
        let runtimeCompleted = false;
        try {
          reservation.executionAdmission.signal.throwIfAborted();
          runtimeDispatched = true;
          await this.deps.agents.compactSession(input.chatId, {
            instructions: input.instructions,
            clientRequestId,
            turnId,
            executionAdmission: reservation.executionAdmission,
          });
          runtimeCompleted = true;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('compact: failed to compact chat:', message);
          try {
            await this.deps.ledger.settleTerminal(ledger.record.key, 'failed', { error: message });
          } catch (ledgerError: unknown) {
            logger.error(
              'compact: failed to record command failure:',
              ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
            );
          }
        } finally {
          try {
            if (!runtimeDispatched) await this.deps.queue.releaseDirectTurn(reservation);
            else if (runtimeCompleted) await this.deps.queue.completeDirectTurn(reservation);
            else await this.deps.queue.failDirectTurn(reservation);
          } catch (error: unknown) {
            logger.error(
              'compact: failed to release execution reservation:',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      this.#trackBackgroundTask(compactTask);
      return commandResultFromRecord(scheduled ?? ledger.record);
    }

    return commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted');
  }

  async updateProjectPath(input: UpdateProjectPathInput): Promise<ProjectPathPatchResponse> {
    const chatId = input.chatId.trim();
    if (!chatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'chatId is required');
    }
    return this.#withChatMutationLock(chatId, () =>
      this.#updateProjectPathLocked({
        chatId,
        projectPath: input.projectPath,
      }),
    );
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

    const previousStatus = await this.deps.pathCache.resolveProjectPath(chat.projectPath);
    const nextProjectPath = await this.#resolveProjectPathForUpdate(input.projectPath);
    const effectiveProjectKey = nextProjectPath;
    if (nextProjectPath === chat.projectPath) {
      return {
        success: true,
        chatId: input.chatId,
        projectPath: chat.projectPath,
        effectiveProjectKey,
        previousProjectPath: chat.projectPath,
        previousEffectiveProjectKey: previousStatus.effectiveProjectKey,
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

    const event = {
      chatId: input.chatId,
      projectPath: nextProjectPath,
      effectiveProjectKey,
      previousProjectPath: chat.projectPath,
      previousEffectiveProjectKey: previousStatus.effectiveProjectKey,
      ...(nativePath && nativePath !== chat.nativePath ? { nativePath } : {}),
    };
    const updated = await this.deps.chats.updateProjectPath(input.chatId, event, { flush: true });
    if (!updated) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
    }

    return {
      success: true,
      chatId: input.chatId,
      projectPath: updated.projectPath,
      effectiveProjectKey,
      previousProjectPath: event.previousProjectPath,
      previousEffectiveProjectKey: event.previousEffectiveProjectKey,
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
        throw new CommandValidationError('PROJECT_PATH_NOT_FOUND', `Project path not found: ${resolvedPath}`, 404);
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

  async #resolveProjectPathForStart(projectPath: string | undefined): Promise<string> {
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

    try {
      await fs.access(resolvedPath);
    } catch {
      throw new CommandValidationError('VALIDATION_FAILED', `Project path not found: ${resolvedPath}`, 404);
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

    const queue = normalizeStoredQueueState(await this.deps.queue.readChatQueue(chatId));
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

    if (this.deps.queue.hasChatExecutionOwner(chatId)) {
      throw new CommandValidationError(
        'CHAT_NOT_IDLE',
        'Cannot update project path while a turn is being prepared or finalized',
        409,
        true,
      );
    }

    await this.deps.pendingInputs.reconcileRetainedHistory(chatId);
    if (this.deps.pendingInputs.hasInFlightForChat(chatId)) {
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

    if (this.deps.agents.requiresNativePathForProjectPathUpdate?.(chat.agentId)) {
      throw new CommandValidationError(
        'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
        'Cannot update the project path until the session file can be resolved',
        409,
        true,
      );
    }

    return this.#isRealNativePath(chat.nativePath) ? chat.nativePath : null;
  }

  #isRealNativePath(nativePath: unknown): nativePath is string {
    return typeof nativePath === 'string' && nativePath.length > 0 && !isArtificialNativePath(nativePath);
  }

  async #submitHttpRun(input: NormalizedSubmitRunInput): Promise<CommandAcceptedResponse> {
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-run',
      chatId: input.chatId,
      clientRequestId,
      payload: runPayload(input, clientMessageId),
      turnId,
    });
    return this.#scheduleAcceptedHttpRun(ledger, input, {
      clientRequestId,
      clientMessageId,
      turnId,
    }, 'agent-run');
  }

  async #submitHttpForkRun(input: NormalizedSubmitForkRunInput): Promise<ForkRunCommandResponse> {
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'fork-run',
      chatId: input.chatId,
      clientRequestId,
      payload: forkPayload(input, clientMessageId),
      turnId,
    });

    if (ledger.kind === 'conflict') {
      throw new CommandValidationError(
        'IDEMPOTENCY_CONFLICT',
        'clientRequestId was reused with different payload',
        409,
      );
    }
    if (ledger.kind === 'duplicate') {
      this.#throwRecordedExecutionFailure(ledger.record);
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        chat: await this.#projectCommandChat(ledger.record.chatId),
      };
    }

    try {
      await this.#forkChatFromContext(this.#validateFork(input));
    } catch (error: unknown) {
      await this.deps.ledger.update(ledger.record.key, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const result = await this.#scheduleAcceptedHttpRun(ledger, input, {
      clientRequestId,
      clientMessageId,
      turnId,
    }, 'fork-run');
    return { ...result, chat: await this.#projectCommandChat(input.chatId) };
  }

  async #scheduleAcceptedHttpRun(
    ledger: Awaited<ReturnType<CommandLedger['accept']>>,
    input: NormalizedSubmitRunInput,
    ids: { clientRequestId: string; clientMessageId: string; turnId: string },
    commandType: Extract<AgentExecutionCommandType, 'agent-run' | 'fork-run'>,
  ): Promise<CommandAcceptedResponse> {
    if (ledger.kind === 'conflict') {
      throw new CommandValidationError(
        'IDEMPOTENCY_CONFLICT',
        'clientRequestId was reused with different payload',
        409,
      );
    }
    if (ledger.kind === 'duplicate') {
      this.#throwRecordedExecutionFailure(ledger.record);
      return commandResultFromRecord(ledger.record, 'duplicate');
    }

    const options = this.#withTurnIds(this.#optionsWithoutAttachments(input.options), {
      ...ids,
      turnId: ledger.record.turnId ?? ids.turnId,
    });
    options.commandType = commandType;
    if (input.images !== undefined) options.images = input.images;

    let reservation: DirectTurnReservation;
    try {
      reservation = this.deps.queue.reserveDirectTurn(input.chatId, options);
    } catch (error) {
      await this.#markPreScheduleFailure(ledger.record.key, error);
      throw error;
    }

    try {
      reservation.executionAdmission.signal.throwIfAborted();
      await this.#assertDirectExecutionQueueAvailable(input.chatId);
      reservation.executionAdmission.signal.throwIfAborted();
      await this.#registerPendingInput(input.chatId, input.command, options);
      reservation.executionAdmission.signal.throwIfAborted();
      const scheduled = await this.deps.ledger.update(ledger.record.key, {
        status: 'scheduled',
        turnId: options.turnId,
        pendingInputRecovery: 'required',
      });
      this.#runReservedTurn(reservation, input.command, options);
      return commandResultFromRecord(scheduled ?? ledger.record);
    } catch (error) {
      const pendingRegistered = this.deps.pendingInputs.markFailed(
        input.chatId,
        options.clientRequestId!,
      );
      await this.deps.queue.releaseDirectTurn(reservation);
      await this.#markPreScheduleFailure(ledger.record.key, error, pendingRegistered);
      throw error;
    }
  }

  async #markPreScheduleFailure(
    ledgerKey: string,
    error: unknown,
    pendingRegistered = false,
  ): Promise<void> {
    await this.deps.ledger.update(ledgerKey, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
      ...(pendingRegistered ? { pendingInputRecovery: 'required' as const } : {}),
    });
  }

  async #assertDirectExecutionQueueAvailable(chatId: string): Promise<void> {
    const queue = await this.deps.queue.readChatQueue(chatId);
    if (queue.entries.length === 0 && !queue.pause) return;
    throw new CommandValidationError(
      'SESSION_BUSY',
      queue.pause
        ? 'The chat queue is paused and must be reviewed before another direct turn'
        : 'Queued messages are pending and must be sent first',
      409,
      true,
    );
  }

  async #registerPendingInput(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void> {
    await this.deps.queue.registerPendingUserInput(chatId, command, options);
  }

  #runReservedTurn(
    reservation: DirectTurnReservation,
    command: string,
    options: RunAgentTurnOptions,
  ): void {
    const runTask = (async () => {
      try {
        await this.deps.queue.runReservedTurn(reservation, command, options);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('commands: run failed:', message);
      }
    })();
    this.#trackBackgroundTask(runTask);
  }

  #withTurnIds(
    options: RunAgentTurnOptions,
    ids: {
      clientRequestId?: string;
      clientMessageId?: string;
      turnId?: string;
    },
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

  async #throwRecordedQueueMutationFailure(record: CommandLedgerRecord): Promise<void> {
    if (record.status !== 'rejected') return;
    if (
      record.errorCode !== 'QUEUE_ENTRY_NOT_FOUND'
      && record.errorCode !== 'QUEUE_ENTRY_ALREADY_SENT'
      && record.errorCode !== 'QUEUE_ENTRY_REVISION_CONFLICT'
    ) {
      return;
    }

    throw new QueueEntryMutationError(
      record.errorCode,
      record.error ?? 'The queued message could not be changed',
      await this.deps.queue.readChatQueue(record.chatId),
    );
  }

  #validateFork(input: ForkChatInput): ForkContext {
    const sourceChatId = this.#requireChatId(input.sourceChatId, 'sourceChatId');
    const targetChatId = this.#requireChatId(input.chatId);
    const upToSeq = this.#normalizeForkSeq(input.upToSeq);

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
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Fork unsupported for agent: ${sourceSession.agentId}`,
        422,
      );
    }
    if (upToSeq !== undefined && !this.deps.agents.supportsForkAtMessage(sourceSession.agentId)) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Fork at message unsupported for agent: ${sourceSession.agentId}`,
        422,
      );
    }
    if (
      this.deps.agents.isAgentSessionRunning(sourceSession.agentId, sourceSession.agentSessionId) &&
      !this.deps.agents.supportsForkWhileRunning(sourceSession.agentId)
    ) {
      throw new CommandValidationError('SESSION_BUSY', 'Cannot fork a chat while it is processing', 409, true);
    }
    if (this.deps.chats.getChat(targetChatId)) {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', `Session already exists: ${targetChatId}`, 409);
    }

    return {
      sourceChatId,
      targetChatId,
      sourceSession,
      ...(upToSeq ? { upToSeq } : {}),
    };
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
      carryOver: this.deps.carryOver,
      forkAgentSession: this.deps.agents.forkAgentSession?.bind(this.deps.agents),
      supportsFork: this.deps.agents.supportsFork.bind(this.deps.agents),
      assertSourceSnapshotStable: (sourceChanged) => {
        this.#assertSourceSnapshotStable(context.sourceSession, sourceChanged);
      },
      rewriteForkTranscriptEntry: (entry, rewriteContext) => (
        this.deps.agents.rewriteForkTranscriptEntry(
          context.sourceSession.agentId,
          entry,
          rewriteContext,
        )
      ),
    });
  }

  #assertSourceSnapshotStable(sourceSession: ChatRegistryEntry, sourceChanged: boolean): void {
    if (this.deps.agents.supportsForkWhileRunning(sourceSession.agentId)) return;
    if (
      sourceChanged
      || this.deps.agents.isAgentSessionRunning(sourceSession.agentId, sourceSession.agentSessionId)
    ) {
      throw new CommandValidationError('SESSION_BUSY', 'Cannot fork a chat while it is processing', 409, true);
    }
  }

  async #projectCommandChat(chatId: string): Promise<import('../../common/chat-list.js').ChatListEntry> {
    const chat = await this.deps.chatListProjector.buildOne(chatId);
    if (chat) return chat;
    throw new CommandValidationError(
      'INTERNAL_ERROR',
      `Session could not be projected after a successful command: ${chatId}`,
      500,
      true,
    );
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
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        'Message-point forking is not configured on this server',
        503,
        true,
      );
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
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'Cannot fork from this message because its native source position is unavailable',
      );
    }
    return {
      ...(entryId ? { entryId } : {}),
      ...(lineNumber && Number.isInteger(lineNumber) && lineNumber > 0 ? { lineNumber } : {}),
    };
  }

  #assertContent(command: string, images?: RunAgentTurnOptions['images']): void {
    if (!command.trim() && (!images || images.length === 0)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'command or attachments are required');
    }
  }

  #validateAttachments(value: unknown): RunAgentTurnOptions['images'] | undefined {
    try {
      return validateCommandAttachments(value);
    } catch (error) {
      if (error instanceof AttachmentValidationError) {
        throw new CommandValidationError('VALIDATION_FAILED', error.message, error.status);
      }
      throw error;
    }
  }

  #optionsWithoutAttachments(options: RunAgentTurnOptions | undefined): RunAgentTurnOptions {
    const next = { ...(options ?? {}) };
    delete next.images;
    return next;
  }

  #requireClientRequestId(value: string | undefined, field = 'clientRequestId'): string {
    if (!value?.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', `${field} is required`);
    }
    return value.trim();
  }

  #requireChatId(value: unknown, field = 'chatId'): ChatId {
    try {
      return parseChatId(value);
    } catch (error) {
      if (!(error instanceof InvalidChatIdError)) throw error;
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        `${field} must be a valid 16-digit Unix-microsecond timestamp`,
      );
    }
  }

  #throwOnConflict(ledger: Awaited<ReturnType<CommandLedger['accept']>>, message: string): void {
    if (ledger.kind === 'conflict') {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', message, 409);
    }
  }

  #throwRecordedExecutionFailure(record: CommandLedgerRecord): void {
    if (record.status !== 'failed' && record.status !== 'rejected') return;
    const restarted = record.errorCode === SERVER_RESTART_INTERRUPTED_ERROR_CODE;
    throw new CommandValidationError(
      restarted ? 'SERVER_RESTART_INTERRUPTED' : 'INTERNAL_ERROR',
      record.error ?? 'The previous execution did not complete',
      409,
      false,
    );
  }
}

function runPayload(input: NormalizedSubmitRunInput, clientMessageId: string): Record<string, unknown> {
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

function forkPayload(input: NormalizedSubmitForkRunInput, clientMessageId: string): Record<string, unknown> {
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
