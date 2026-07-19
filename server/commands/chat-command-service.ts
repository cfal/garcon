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
  RecoveredInputContinueRequest,
  StartChatCommandResponse,
} from '../../common/chat-command-contracts.js';
import type { ApiProtocol } from '../../common/api-providers.js';
import { InvalidChatIdError, parseChatId, type ChatId } from '../../common/chat-id.js';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type { AgentRunCommandRequest, ForkRunCommandRequest } from '../../common/chat-command-contracts.js';
import { normalizeTags } from '../../common/tags.ts';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import type {
  AgentExecutionCommandType,
  RunAgentTurnOptions,
  StartedAgentSession,
} from '../agents/session-types.js';
import { assertRealWithinProjectBase, isProjectBoundaryError } from '../lib/path-boundary.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import {
  commandLedgerKey,
  SERVER_RESTART_INTERRUPTED_ERROR_CODE,
  type CommandLedger,
  type CommandLedgerRecord,
} from './command-ledger.js';
import {
  QueueEntryMutationError,
  type ChatExecutionService,
} from '../chat-execution/chat-execution-coordinator.js';
import { ChatCommandSettlement } from './chat-command-settlement.ts';
import {
  normalizeStoredChatExecutionControlState,
  toClientChatExecutionControlState,
  type StoredChatExecutionControlState,
} from '../chat-execution-control-state.ts';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import {
  rollbackForkTarget,
  type ForkChatFileCopyResult,
} from '../chats/fork-chat.js';
import { createLogger } from '../lib/log.js';
import { AttachmentValidationError, validateCommandAttachments } from '../attachments/validation.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import { DomainError } from '../lib/domain-error.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { PathCache } from '../chats/path-cache.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';

const logger = createLogger('commands:chat-command-service');

type QueueDep = Pick<
  ChatExecutionService,
  | 'scheduleDirectInput'
  | 'runInitialInput'
  | 'scheduleDirectOperation'
  | 'enqueueAccepted'
  | 'replaceAccepted'
  | 'deleteAccepted'
  | 'deliverAcceptedActiveInput'
  | 'recoverAcceptedActiveInput'
  | 'stopActiveTurn'
  | 'interruptActiveTurn'
  | 'abortForChatDeletion'
  | 'waitForDispatches'
  | 'isChatExecutionReserved'
  | 'hasChatExecutionOwner'
  | 'readChatExecutionControl'
  | 'continuePastRecoveredInput'
  | 'clearChatQueue'
  | 'pauseChatQueue'
  | 'resumeChatQueue'
  | 'resumeAndDrain'
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
  stageFork(input: {
    sourceChatId: string;
    targetChatId: string;
    targetEpoch: string;
    ownerId: string;
    ownerModel: string;
    upToSequence?: number;
  }): Promise<void>;
  promoteStaged(chatId: string, targetEpoch: string): Promise<void>;
  discardStaged(chatId: string, targetEpoch: string): Promise<void>;
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
  | 'resolveNativeSession'
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
  upToSequence?: number;
  registry: IChatRegistry;
  settings: SettingsDep;
  metadata: MetadataDep;
  carryOver?: CarryOverDep;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  forkAgentSession: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }) => Promise<StartedAgentSession | null>;
}) => Promise<ForkChatFileCopyResult>;

interface ForkContext {
  sourceChatId: string;
  targetChatId: string;
  sourceSession: ChatRegistryEntry;
  sourceNextForkOrdinal: number;
  upToSeq?: number;
}

interface AcceptedRunPreparation {
  operation: 'fork-run';
  prepare(): Promise<void>;
  compensate(): Promise<void>;
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
  agentSettings?: unknown;
  agentSettingsById?: unknown;
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
  agentSettingsById?: unknown;
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
  agentSettings: AgentSettingsEnvelope;
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

type DirectRunOrigin =
  | 'interactive-existing-chat'
  | 'scheduled-existing-chat'
  | 'fork-created-chat';

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

export class CommandExecutionControlError extends CommandValidationError {
  constructor(
    code: CommandErrorCode,
    message: string,
    status: number,
    retryable: boolean,
    readonly control: StoredChatExecutionControlState,
  ) {
    super(code, message, status, retryable);
    this.name = 'CommandExecutionControlError';
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
  if (body.agentSettings !== undefined) options.agentSettings = body.agentSettings;
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
  forkChatFileCopy: ForkChatFileCopyDep;
  carryOver?: CarryOverDep;
  chatIds: Pick<ChatIdAllocator, 'allocate'>;
  chatListProjector: Pick<ChatListProjector, 'buildOne'>;
  pathCache: Pick<PathCache, 'resolveProjectPath'>;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  // Shared with AgentSwitchService so agent switches serialize against
  // send/fork/compaction/delete on the same chat. Defaults to a private lock
  // when omitted, which suffices for isolated unit tests.
  chatMutationLock?: KeyedPromiseLock;
}

export class ChatCommandService {
  readonly #chatMutationLocks: KeyedPromiseLock;
  readonly #settlement: ChatCommandSettlement;

  constructor(private readonly deps: ChatCommandServiceDeps) {
    this.#chatMutationLocks = deps.chatMutationLock ?? new KeyedPromiseLock();
    this.#settlement = new ChatCommandSettlement(deps.ledger);
  }

  async waitForBackgroundTasks(): Promise<void> {
    await this.deps.queue.waitForDispatches();
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

    const directSettings = parseAgentSettingsEnvelope(input.agentSettings);
    const settingsById = input.agentSettingsById && typeof input.agentSettingsById === 'object'
      ? input.agentSettingsById as Record<string, unknown>
      : null;
    const scheduledSettings = parseAgentSettingsEnvelope(settingsById?.[agentId]);
    const agentSettings = directSettings ?? scheduledSettings;
    if (!agentSettings || agentSettings.ownerId !== agentId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'agentSettings must be owned by agentId');
    }

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
      thinkingMode: normalizeThinkingMode(input.thinkingMode),
      agentSettings,
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
        agentSettings: input.agentSettings,
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

    await this.deps.queue.runInitialInput({
      command: {
        key: ledger.record.key,
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
        turnId,
      },
      content: input.command,
      options: {
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        turnId,
        images: input.images.length > 0 ? input.images : undefined,
        agentSettings: input.agentSettings,
      },
      settlement: this.#settlement,
      preparation: {
        operation: 'chat-start',
        prepare: async () => {
          this.deps.chats.addChat({
            id: input.chatId,
            agentId: input.agentId,
            nativeSession: null,
            projectPath: input.projectPath,
            tags: input.tags,
            agentSessionId: null,
            model: input.model,
            apiProviderId: input.apiProviderId,
            modelEndpointId: input.modelEndpointId,
            modelProtocol: input.modelProtocol,
            permissionMode: input.permissionMode,
            thinkingMode: input.thinkingMode,
            agentSettingsById: { [input.agentId]: input.agentSettings },
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
            agentSettingsById: { [input.agentId]: input.agentSettings },
          });
          await this.deps.settings.ensureInNormal(input.chatId);
        },
        compensate: async () => {
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
        },
      },
      dispatch: (executionAdmission) => this.deps.agents.startSession(input.chatId, input.command, {
        projectPath: input.projectPath,
        images: input.images.length > 0 ? input.images : undefined,
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        turnId,
        executionAdmission,
        agentSettings: input.agentSettings,
      }),
    });

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
      }, 'interactive-existing-chat'),
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
    await this.deps.ownership.delete(chatId);

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
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        entryId: ledger.record.entryId ?? preparedEntryId,
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
      };
    }

    const result = await this.deps.queue.enqueueAccepted({
      command: {
        key: ledger.record.key,
        chatId: input.chatId,
        clientRequestId: ledger.record.clientRequestId,
        entryId: ledger.record.entryId ?? preparedEntryId,
      },
      content,
      settlement: this.#settlement,
    });
    return {
      ...commandResultFromRecord(
        ledger.record,
        recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
      ),
      entryId: result.entryId,
      control: toClientChatExecutionControlState(result.control),
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
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const result = await this.deps.queue.replaceAccepted({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          entryId,
        },
        content,
        expectedRevision: input.expectedRevision,
        settlement: this.#settlement,
      });
      return {
        ...commandResultFromRecord(
          ledger.record,
          recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
        ),
        entryId,
        control: toClientChatExecutionControlState(result.control),
      };
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
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const result = await this.deps.queue.deleteAccepted({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          entryId,
        },
        settlement: this.#settlement,
      });
      return {
        ...commandResultFromRecord(
          ledger.record,
          recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
        ),
        entryId,
        control: toClientChatExecutionControlState(result.control),
      };
    });
  }

  async submitActiveInput(input: ActiveInputCommandRequest): Promise<ActiveInputCommandResponse> {
    this.#requireChat(input.chatId);
    this.#assertContent(input.content);
    return this.#withChatMutationLock(input.chatId, async () => {
      const content = input.content;
      const preparedEntryId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const ledger = await this.deps.ledger.accept({
        commandType: 'active-input',
        chatId: input.chatId,
        clientRequestId: this.#requireClientRequestId(input.clientRequestId),
        payload: { chatId: input.chatId, content },
        entryId: preparedEntryId,
        turnId,
      });
      this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      if (ledger.kind === 'duplicate') {
        if (ledger.record.status === 'failed') {
          if (ledger.record.errorCode === 'ACTIVE_INPUT_OUTCOME_UNKNOWN') {
            throw new CommandValidationError(
              'ACTIVE_INPUT_OUTCOME_UNKNOWN',
              ledger.record.error ?? 'The previous active-input delivery failed after acceptance',
              409,
              false,
            );
          }
          this.#throwRecordedExecutionFailure(ledger.record);
        }
        if (ledger.record.status === 'accepted') {
          const outcome = await this.deps.queue.recoverAcceptedActiveInput({
            command: {
              key: ledger.record.key,
              chatId: input.chatId,
              clientRequestId: ledger.record.clientRequestId,
              turnId: ledger.record.turnId ?? turnId,
              entryId: ledger.record.entryId ?? preparedEntryId,
            },
            content,
            settlement: this.#settlement,
          });
          return {
            ...commandResultFromRecord(ledger.record, 'duplicate'),
            delivery: outcome.delivery,
            ...(outcome.entryId ? { entryId: outcome.entryId } : {}),
            control: toClientChatExecutionControlState(outcome.control),
          };
        }
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          delivery: ledger.record.entryId ? 'queued' : 'active',
          ...(ledger.record.entryId ? { entryId: ledger.record.entryId } : {}),
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const outcome = await this.deps.queue.deliverAcceptedActiveInput({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          turnId: ledger.record.turnId ?? turnId,
          entryId: ledger.record.entryId ?? preparedEntryId,
        },
        content,
        settlement: this.#settlement,
      });
      return {
        ...commandResultFromRecord(ledger.record),
        delivery: outcome.delivery,
        ...(outcome.entryId ? { entryId: outcome.entryId } : {}),
        control: toClientChatExecutionControlState(outcome.control),
      };
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
      const control = await this.deps.queue.readChatExecutionControl(chatId);
      const queueBlocksDirectRun = control.entries.length > 0
        || control.pause !== null
        || control.recoveredInputContinuation !== null;
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
      }, 'scheduled-existing-chat');
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
      queue = await this.deps.queue.resumeAndDrain(input.chatId, input.pauseId);
    }
    return {
      success: true,
      chatId: input.chatId,
      control: toClientChatExecutionControlState(queue),
    };
  }

  async continueRecoveredInput(input: RecoveredInputContinueRequest): Promise<QueueMutationResponse> {
    this.#requireChat(input.chatId);
    const continuationId = input.continuationId.trim();
    if (!continuationId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'continuationId is required', 400);
    }
    return this.#withChatMutationLock(input.chatId, async () => ({
      success: true,
      chatId: input.chatId,
      control: toClientChatExecutionControlState(
        await this.deps.queue.continuePastRecoveredInput(input.chatId, continuationId),
      ),
    }));
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
    if (
      ledger.kind === 'duplicate'
      && ledger.record.status === 'failed'
      && ledger.record.errorCode === SERVER_RESTART_INTERRUPTED_ERROR_CODE
    ) this.#throwRecordedExecutionFailure(ledger.record);
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
      if (
        ledger.record.status === 'failed'
        && ledger.record.errorCode === SERVER_RESTART_INTERRUPTED_ERROR_CODE
      ) this.#throwRecordedExecutionFailure(ledger.record);
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        stopped: ledger.record.status === 'finished',
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
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
        control: toClientChatExecutionControlState(result.control),
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
      if (
        ledger.record.status === 'failed'
        && ledger.record.errorCode === SERVER_RESTART_INTERRUPTED_ERROR_CODE
      ) this.#throwRecordedExecutionFailure(ledger.record);
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        stopped: ledger.record.status === 'finished',
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
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
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
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
      try {
        await this.deps.queue.scheduleDirectOperation({
          command: {
            key: ledger.record.key,
            chatId: input.chatId,
            clientRequestId,
            turnId,
          },
          settlement: this.#settlement,
          dispatch: (executionAdmission) => this.deps.agents.compactSession(input.chatId, {
            instructions: input.instructions,
            clientRequestId,
            turnId,
            executionAdmission,
          }),
        });
      } catch (error) {
        throw await this.#withCurrentExecutionControl(input.chatId, error);
      }
      return commandResultFromRecord(ledger.record);
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
      };
    }

    await this.#assertChatIdleForProjectPathUpdate(input.chatId, chat);
    const nativeSession = await this.#nativeSessionForProjectPathUpdate(input.chatId, chat);

    try {
      await this.deps.agents.prepareProjectPathUpdate(chat.agentId, {
        chatId: input.chatId,
        agentSessionId: chat.agentSessionId,
        previousProjectPath: chat.projectPath,
        nextProjectPath,
        nativeSession,
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
      ...(nativeSession !== chat.nativeSession ? { nativeSession } : {}),
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

    const queue = normalizeStoredChatExecutionControlState(
      await this.deps.queue.readChatExecutionControl(chatId),
    );
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

  async #nativeSessionForProjectPathUpdate(
    chatId: string,
    chat: ChatRegistryEntry,
  ): Promise<ChatRegistryEntry['nativeSession']> {
    if (chat.nativeSession) return chat.nativeSession;

    const resolved = await this.deps.agents.resolveNativeSession(chat, chatId);
    if (resolved) return resolved;

    if (this.deps.agents.requiresNativePathForProjectPathUpdate(chat.agentId)) {
      throw new CommandValidationError(
        'PROJECT_PATH_NATIVE_PATH_UNRESOLVED',
        'Cannot update the project path until the native session can be resolved',
        409,
        true,
      );
    }
    return null;
  }

  async #submitHttpRun(
    input: NormalizedSubmitRunInput,
    origin: Extract<DirectRunOrigin, 'interactive-existing-chat' | 'scheduled-existing-chat'>,
  ): Promise<CommandAcceptedResponse> {
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
    }, 'agent-run', origin);
  }

  async #submitHttpForkRun(input: NormalizedSubmitForkRunInput): Promise<ForkRunCommandResponse> {
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledgerKey = commandLedgerKey('fork-run', input.chatId, clientRequestId);
    const priorRecord = await this.deps.ledger.getRecord(ledgerKey);
    let forkContext: ForkContext | null = null;
    if (!priorRecord) forkContext = this.#validateFork(input);
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
    const recoveringAcceptedCommand = ledger.kind === 'duplicate'
      && ledger.record.status === 'accepted';
    if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
      this.#throwRecordedExecutionFailure(ledger.record);
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        chat: await this.#projectCommandChat(ledger.record.chatId),
      };
    }

    const resolvedForkContext = forkContext ?? this.#validateFork(input);
    let forkResult: ForkChatFileCopyResult | null = null;
    const result = await this.#scheduleAcceptedHttpRun(ledger, input, {
      clientRequestId,
      clientMessageId,
      turnId,
    }, 'fork-run', 'fork-created-chat', {
      operation: 'fork-run',
      prepare: async () => {
        await this.deps.ledger.update(ledger.record.key, {
          forkPreparation: {
            phase: 'creating',
            sourceChatId: resolvedForkContext.sourceChatId,
            sourceNextForkOrdinal: resolvedForkContext.sourceNextForkOrdinal,
          },
        });
        forkResult = await this.#forkChatFromContext(resolvedForkContext);
        await this.deps.ledger.update(ledger.record.key, {
          forkPreparation: {
            phase: 'created',
            sourceChatId: resolvedForkContext.sourceChatId,
            sourceNextForkOrdinal: forkResult.sourceNextForkOrdinal,
          },
        });
      },
      compensate: async () => {
        if (forkResult) {
          await forkResult.rollback();
        } else {
          await rollbackForkTarget({
            sourceChatId: resolvedForkContext.sourceChatId,
            targetChatId: resolvedForkContext.targetChatId,
            registry: this.deps.chats,
            settings: this.deps.settings,
            ownership: this.deps.ownership,
            sourceNextForkOrdinal: resolvedForkContext.sourceNextForkOrdinal,
          });
        }
        forkResult = null;
      },
    });
    return { ...result, chat: await this.#projectCommandChat(input.chatId) };
  }

  async #scheduleAcceptedHttpRun(
    ledger: Awaited<ReturnType<CommandLedger['accept']>>,
    input: NormalizedSubmitRunInput,
    ids: { clientRequestId: string; clientMessageId: string; turnId: string },
    commandType: Extract<AgentExecutionCommandType, 'agent-run' | 'fork-run'>,
    origin: DirectRunOrigin,
    preparation?: AcceptedRunPreparation,
  ): Promise<CommandAcceptedResponse> {
    if (ledger.kind === 'conflict') {
      throw new CommandValidationError(
        'IDEMPOTENCY_CONFLICT',
        'clientRequestId was reused with different payload',
        409,
      );
    }
    const recoveringAcceptedCommand = ledger.kind === 'duplicate'
      && ledger.record.status === 'accepted';
    if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
      this.#throwRecordedExecutionFailure(ledger.record);
      return commandResultFromRecord(ledger.record, 'duplicate');
    }

    const options = this.#withTurnIds(this.#optionsWithoutAttachments(input.options), {
      ...ids,
      turnId: ledger.record.turnId ?? ids.turnId,
    });
    options.commandType = commandType;
    if (input.images !== undefined) options.images = input.images;

    try {
      await this.deps.queue.scheduleDirectInput({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          turnId: options.turnId,
        },
        content: input.command,
        options,
        settlement: this.#settlement,
        continueRecoveredInput: origin === 'interactive-existing-chat',
        preparation,
      });
    } catch (error) {
      const admissionError = await this.#withCurrentExecutionControl(input.chatId, error);
      throw admissionError;
    }
    return commandResultFromRecord(
      ledger.record,
      recoveringAcceptedCommand ? 'duplicate' : 'accepted',
    );
  }

  async #withCurrentExecutionControl(chatId: string, error: unknown): Promise<unknown> {
    if (error instanceof CommandExecutionControlError) return error;
    if (!(error instanceof DomainError) || error.code !== 'SESSION_BUSY') return error;

    let control: StoredChatExecutionControlState;
    try {
      control = await this.deps.queue.readChatExecutionControl(chatId);
    } catch {
      return error;
    }
    return new CommandExecutionControlError(
      'SESSION_BUSY',
      error.message,
      error.status,
      error.retryable,
      control,
    );
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
      await this.deps.queue.readChatExecutionControl(record.chatId),
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
      sourceNextForkOrdinal: normalizeNextForkOrdinal(sourceSession.nextForkOrdinal) ?? 1,
      ...(upToSeq ? { upToSeq } : {}),
    };
  }

  async #forkChatFromContext(context: ForkContext): Promise<ForkChatFileCopyResult> {
    if (!this.deps.forkChatFileCopy) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    return this.deps.forkChatFileCopy({
      sourceSession: context.sourceSession,
      sourceChatId: context.sourceChatId,
      targetChatId: context.targetChatId,
      ...(context.upToSeq ? { upToSequence: context.upToSeq } : {}),
      registry: this.deps.chats,
      settings: this.deps.settings,
      metadata: this.deps.metadata,
      carryOver: this.deps.carryOver,
      ownership: this.deps.ownership,
      forkAgentSession: this.deps.agents.forkAgentSession.bind(this.deps.agents),
    });
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

function normalizeNextForkOrdinal(value: unknown): number | null {
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number'
      ? value
      : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function runPayload(input: NormalizedSubmitRunInput, clientMessageId: string): Record<string, unknown> {
  return {
    chatId: input.chatId,
    clientMessageId,
    command: input.command,
    images: input.images,
    permissionMode: input.options?.permissionMode,
    thinkingMode: input.options?.thinkingMode,
    agentSettings: input.options?.agentSettings,
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
    agentSettings: input.options?.agentSettings,
    model: input.options?.model,
    apiProviderId: input.options?.apiProviderId,
    modelEndpointId: input.options?.modelEndpointId,
    modelProtocol: input.options?.modelProtocol,
  };
}
