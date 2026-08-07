import crypto from 'crypto';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import {
  COMMAND_CORRELATION_ID_MAX_BYTES,
  QUEUE_ENTRY_ID_MAX_BYTES,
  isCommandCorrelationIdWithinLimit,
  isQueueEntryIdWithinLimit,
  type AgentHandoffRequest,
  type AgentInterruptAndSendCommandRequest,
  type AgentRunCommandRequest,
  type AgentStopCommandRequest,
  type AgentTurnCommandResponse,
  type CompactCommandRequest,
  type CommandAcceptedResponse,
  type ForkRunCommandRequest,
  type PermissionDecisionCommandRequest,
  type ProjectPathPatchRequest,
  type StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import { InvalidChatIdError, parseChatId, type ChatId } from '../../common/chat-id.js';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type {
  AgentExecutionCommandType,
  ForkedAgentSessionOutcome,
  RunAgentTurnOptions,
  StartedAgentSession,
} from '../agents/session-types.js';
import type { ChatExecutionCommands } from '../chat-execution/chat-execution-coordinator.js';
import { assertAttachmentsSupported } from '../attachments/support.js';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { DirectInputPreparation } from '../chat-execution/types.js';
import {
  agentHandoffReplayDisposition,
  withHandoffChatProjection,
} from '../agents/agent-handoff-command.js';
import { agentRunCommandPayload } from '../agents/agent-run-command-input.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { AgentHandoffService } from '../agents/agent-handoff-service.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { ForkChatFileCopyResult } from '../chats/fork-chat.js';
import type { CarryOverTranscriptStore } from '../chats/carryover-transcript-store.js';
import type { PathCache } from '../chats/path-cache.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { RecentTitleIconSource } from '../chats/recent-title-icons.js';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import {
  CommandExecutionControlError,
  withCurrentExecutionControl,
} from '../lib/command-execution-control-error.js';
import { CommandValidationError } from '../lib/command-validation-error.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { ChatCommandSettlement } from './chat-command-settlement.ts';
import {
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  commandLedgerKey,
  commandPayloadHash,
  type CommandLedger,
  type CommandLedgerRecord,
} from './command-ledger.js';

export interface SettingsDep {
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  setSessionNameIfAbsent(chatId: string, title: string): Promise<boolean>;
  recordChatStartup(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
}

export interface MetadataDep {
  addNewChatMetadata(chatId: string, command: string): void;
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
}

export type CarryOverDep = Pick<
  CarryOverTranscriptStore,
  'assertReachableForHandoff' | 'logicalMessageCount' | 'preparePrefix' | 'resolveCutoff'
>;

export type PendingInputsDep = Pick<
  PendingUserInputServiceContract,
  | 'clearChat'
  | 'hasInFlightForChat'
  | 'markFailed'
  | 'markUnconfirmed'
  | 'reconcileNativeHistory'
  | 'reconcileRetainedHistory'
>;

export type AgentRegistryDep = Pick<
  AgentRegistryServiceContract,
  | 'hasAgent'
  | 'supportsImages'
  | 'supportsFileAttachmentMimeType'
  | 'modelSupportsImages'
  | 'startSession'
  | 'resolvePermission'
  | 'getAgentAuthStatusMap'
  | 'getAgentReadinessMap'
  | 'getAgentCatalogEntries'
  | 'getAgentCatalogEntry'
  | 'runSingleQuery'
  | 'supportsFork'
  | 'supportsForkAtMessage'
  | 'supportsForkWhileRunning'
  | 'supportsUpdateProjectPath'
  | 'requiresNativePathForProjectPathUpdate'
  | 'isAgentSessionRunning'
  | 'forkAgentSession'
  | 'discardForkedAgentSession'
  | 'compactSession'
  | 'resolveNativeSession'
  | 'prepareProjectPathUpdate'
>;

export type ForkChatFileCopyDep = (args: {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
  upToSequence?: number;
  registry: IChatRegistry;
  settings: SettingsDep;
  metadata: MetadataDep;
  carryOver: CarryOverDep;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  getViewCursor(chatId: string): { lastSeq: number } | null;
  forkAgentSession: (args: {
    sourceSession: ChatRegistryEntry;
    sourceChatId: string;
    targetChatId: string;
    messageSequence?: number;
  }) => Promise<ForkedAgentSessionOutcome | null>;
  discardForkedAgentSession: (agentId: string, session: StartedAgentSession) => Promise<void>;
}) => Promise<ForkChatFileCopyResult>;

export interface ChatViewSeqDep {
  getNativeHistoryLastSeq(chatId: string): number | null;
  getCursor(chatId: string): { generationId: string; lastSeq: number } | null;
}

export interface FileMentionResolverDep {
  resolve(command: string, projectPath: string): Promise<string>;
}

export interface ChatCommandServiceDeps {
  chats: IChatRegistry;
  queue: ChatExecutionCommands;
  chatViews: ChatViewSeqDep;
  idleReconciler: { ensureReconciled(chatId: string): Promise<void> };
  ledger: CommandLedger;
  settings: SettingsDep;
  recentTitleIcons: RecentTitleIconSource;
  metadata: MetadataDep;
  agents: AgentRegistryDep;
  pendingInputs: PendingInputsDep;
  fileMentions: FileMentionResolverDep;
  forkChatFileCopy: ForkChatFileCopyDep;
  carryOver: CarryOverDep;
  chatIds: Pick<ChatIdAllocator, 'allocate'>;
  chatListProjector: Pick<ChatListProjector, 'buildOne'>;
  pathCache: Pick<PathCache, 'resolveProjectPath'>;
  ownership: Pick<AgentOwnershipJournal, 'delete'>;
  handoffs: Pick<AgentHandoffService, 'resolveTarget' | 'createPreparation'>;
  chatMutationLock?: KeyedPromiseLock;
}

export type SubmitRunInput = AgentRunCommandRequest;
export type SubmitForkRunInput = ForkRunCommandRequest;

export interface NormalizedSubmitRunInput {
  chatId: string;
  command: string;
  images?: RunAgentTurnOptions['images'];
  clientRequestId: string;
  clientMessageId: string;
  options: RunAgentTurnOptions;
  expectedAgentId?: string;
  tagsToAdd?: string[];
  permissionFallbackPolicy?: 'require-explicit-bypass';
  handoff?: AgentHandoffRequest;
}

export interface NormalizedSubmitForkRunInput extends NormalizedSubmitRunInput {
  sourceChatId: string;
}

export type ChatStartInput = StartChatCommandRequest;

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
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettingsById: Record<string, AgentSettingsEnvelope>;
  tags: string[];
}

export interface NormalizedChatStart {
  chatId: ChatId;
  clientRequestId: string;
  clientMessageId: string;
  agentId: string;
  projectPath: string;
  idempotencyProjectPath: string;
  command: string;
  images: NonNullable<RunAgentTurnOptions['images']>;
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
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

export interface QueueMutationInput {
  chatId: string;
  action: 'clear' | 'pause' | 'resume';
  pauseId?: string;
}

export type PermissionDecisionInput = PermissionDecisionCommandRequest;
export type StopInput = AgentStopCommandRequest | AgentInterruptAndSendCommandRequest;
export type CompactInput = CompactCommandRequest;
export type UpdateProjectPathInput = ProjectPathPatchRequest;

export interface DeleteChatInput {
  chatId: string;
}

export { CommandValidationError };
export { CommandExecutionControlError };

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

export function agentTurnResultFromRecord(
  record: CommandLedgerRecord,
  status: CommandAcceptedResponse['status'] = 'accepted',
): AgentTurnCommandResponse {
  if (!record.turnId) throw new Error(`Agent turn command ${record.key} has no turnId`);
  return {
    ...commandResultFromRecord(record, status),
    chatId: record.chatId,
    turnId: record.turnId,
  };
}

export class CommandSupport {
  readonly settlement: ChatCommandSettlement;
  readonly #chatMutationLocks: KeyedPromiseLock;

  constructor(readonly deps: ChatCommandServiceDeps) {
    this.#chatMutationLocks = deps.chatMutationLock ?? new KeyedPromiseLock();
    this.settlement = new ChatCommandSettlement(deps.ledger);
  }

  withChatMutationLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.#chatMutationLocks.runExclusive(`chat:${chatId}`, fn);
  }

  withChatMutationLocks<T>(chatIds: string[], fn: () => Promise<T>): Promise<T> {
    const orderedChatIds = [...new Set(chatIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const chatId = orderedChatIds[index];
      return chatId === undefined
        ? fn()
        : this.withChatMutationLock(chatId, () => acquire(index + 1));
    };
    return acquire(0);
  }

  requireChat(chatId: string, message = 'Session not found'): void {
    if (!this.deps.chats.getChat(chatId)) {
      throw new CommandValidationError('SESSION_NOT_FOUND', message, 404);
    }
  }

  requireClientRequestId(value: string | undefined, field = 'clientRequestId'): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new CommandValidationError('VALIDATION_FAILED', `${field} is required`);
    }
    if (!isCommandCorrelationIdWithinLimit(normalized)) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        `${field} must be at most ${COMMAND_CORRELATION_ID_MAX_BYTES} bytes`,
      );
    }
    return normalized;
  }

  requireQueueEntryId(value: string | undefined, field = 'entryId'): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new CommandValidationError('VALIDATION_FAILED', `${field} is required`);
    }
    if (!isQueueEntryIdWithinLimit(normalized)) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        `${field} must be at most ${QUEUE_ENTRY_ID_MAX_BYTES} bytes`,
      );
    }
    return normalized;
  }

  requireChatId(value: unknown, field = 'chatId'): ChatId {
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

  assertContent(command: string, images?: RunAgentTurnOptions['images']): void {
    if (!command.trim() && (!images || images.length === 0)) {
      throw new CommandValidationError('VALIDATION_FAILED', 'command or attachments are required');
    }
  }

  async assertAttachmentsSupported(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
    attachments: NonNullable<RunAgentTurnOptions['images']>;
  }): Promise<void> {
    await assertAttachmentsSupported(this.deps.agents, input);
  }

  optionsWithoutAttachments(options: RunAgentTurnOptions | undefined): RunAgentTurnOptions {
    const next = { ...(options ?? {}) };
    delete next.images;
    return next;
  }

  throwOnConflict(ledger: Awaited<ReturnType<CommandLedger['accept']>>, message: string): void {
    if (ledger.kind === 'conflict') {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', message, 409);
    }
  }

  throwRecordedExecutionFailure(record: CommandLedgerRecord): void {
    if (record.status !== 'failed' && record.status !== 'rejected') return;
    throw new CommandValidationError(
      'INTERNAL_ERROR',
      record.error ?? 'The previous execution did not complete',
      409,
      false,
    );
  }

  async projectCommandChat(chatId: string): Promise<import('../../common/chat-list.js').ChatListEntry> {
    const chat = await this.projectCommandChatIfPresent(chatId);
    if (chat) return chat;
    throw new CommandValidationError(
      'INTERNAL_ERROR',
      `Session could not be projected after a successful command: ${chatId}`,
      500,
      true,
    );
  }

  projectCommandChatIfPresent(
    chatId: string,
  ): Promise<import('../../common/chat-list.js').ChatListEntry | null> {
    return this.deps.chatListProjector.buildOne(chatId);
  }

  async projectReplayedStartChat(
    chatId: string,
  ): Promise<import('../../common/chat-list.js').ChatListEntry | null> {
    if (!this.deps.chats.getChat(chatId)) return null;
    return this.projectCommandChat(chatId);
  }

  async submitHttpRun(
    input: NormalizedSubmitRunInput,
    preparation?: DirectInputPreparation,
  ): Promise<AgentTurnCommandResponse> {
    const clientRequestId = this.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-run',
      chatId: input.chatId,
      clientRequestId,
      payload: agentRunCommandPayload(input, clientMessageId),
      turnId,
    });
    return this.scheduleAcceptedHttpRun(
      ledger,
      input,
      { clientRequestId, clientMessageId, turnId },
      'agent-run',
      preparation,
    );
  }

  async replayHttpRun(
    input: NormalizedSubmitRunInput,
  ): Promise<AgentTurnCommandResponse | null> {
    const clientRequestId = this.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const existing = await this.deps.ledger.getRecord(
      commandLedgerKey('agent-run', input.chatId, clientRequestId),
    );
    if (!existing) return null;
    if (existing.payloadHash !== commandPayloadHash(agentRunCommandPayload(input, clientMessageId))) {
      throw new CommandValidationError(
        'IDEMPOTENCY_CONFLICT',
        'clientRequestId was reused with different payload',
        409,
      );
    }
    const replayDisposition = agentHandoffReplayDisposition({
      handoff: input.handoff,
      currentOwnershipEpoch: this.deps.chats.getChat(input.chatId)?.agentOwnershipEpoch,
      recordStatus: existing.status,
      isUnpublishedPreScheduleFailure: existing.status === 'failed'
        && existing.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE
        && existing.publicTerminalAt === undefined,
    });
    if (replayDisposition === 'retry') return null;
    if (replayDisposition === 'return-duplicate') {
      return this.agentTurnResultWithOptionalChat(existing, 'duplicate', true);
    }
    if (existing.publicTerminalAt === undefined) {
      this.throwRecordedExecutionFailure(existing);
    }
    if (!existing.turnId) throw new Error(`Agent turn command ${existing.key} has no turnId`);
    return this.scheduleAcceptedHttpRun(
      { kind: 'duplicate', record: existing },
      input,
      { clientRequestId, clientMessageId, turnId: existing.turnId },
      'agent-run',
    );
  }

  async scheduleAcceptedHttpRun(
    ledger: Awaited<ReturnType<CommandLedger['accept']>>,
    input: NormalizedSubmitRunInput,
    ids: { clientRequestId: string; clientMessageId: string; turnId: string },
    commandType: Extract<AgentExecutionCommandType, 'agent-run' | 'fork-run'>,
    preparation?: DirectInputPreparation,
  ): Promise<AgentTurnCommandResponse> {
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
      return this.agentTurnResultWithOptionalChat(
        ledger.record,
        'duplicate',
        Boolean(input.handoff),
      );
    }

    const options: RunAgentTurnOptions = {
      ...this.optionsWithoutAttachments(input.options),
      clientRequestId: ids.clientRequestId,
      clientMessageId: ids.clientMessageId,
      turnId: ledger.record.turnId ?? ids.turnId,
    };
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
        settlement: this.settlement,
        preparation,
      });
    } catch (error) {
      throw await withCurrentExecutionControl({
        chatId: input.chatId,
        error,
        handoff: Boolean(input.handoff),
        readControl: (chatId) => this.deps.queue.readChatExecutionControl(chatId),
      });
    }
    return this.agentTurnResultWithOptionalChat(
      ledger.record,
      recoveringAcceptedCommand ? 'duplicate' : 'accepted',
      Boolean(input.handoff),
    );
  }

  async agentTurnResultWithOptionalChat(
    record: CommandLedgerRecord,
    status: CommandAcceptedResponse['status'],
    includeChat: boolean,
  ): Promise<AgentTurnCommandResponse> {
    return withHandoffChatProjection(
      agentTurnResultFromRecord(record, status),
      includeChat,
      (chatId) => this.projectCommandChat(chatId),
    );
  }
}
