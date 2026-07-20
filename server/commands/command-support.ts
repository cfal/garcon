import crypto from 'crypto';
import type { ApiProtocol } from '../../common/api-providers.js';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentInterruptAndSendCommandRequest,
  AgentRunCommandRequest,
  AgentStopCommandRequest,
  CompactCommandRequest,
  CommandAcceptedResponse,
  CommandErrorCode,
  ForkRunCommandRequest,
  PermissionDecisionCommandRequest,
  ProjectPathPatchRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import { InvalidChatIdError, parseChatId, type ChatId } from '../../common/chat-id.js';
import type { PermissionMode, ThinkingMode } from '../../common/chat-modes.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type {
  AgentExecutionCommandType,
  RunAgentTurnOptions,
  StartedAgentSession,
} from '../agents/session-types.js';
import type { ChatExecutionCommands } from '../chat-execution/chat-execution-coordinator.js';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { ChatIdAllocator } from '../chats/chat-id-allocator.js';
import type { ChatListProjector } from '../chats/chat-list-projector.js';
import type { ForkChatFileCopyResult } from '../chats/fork-chat.js';
import type { PathCache } from '../chats/path-cache.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import { DomainError } from '../lib/domain-error.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { ChatCommandSettlement } from './chat-command-settlement.ts';
import type { CommandLedger, CommandLedgerRecord } from './command-ledger.js';

export interface SettingsDep {
  getUiSettings(): { chatTitle?: unknown } | null | undefined;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  recordChatStartup(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
  removeSessionName(chatId: string): Promise<void>;
}

export interface MetadataDep {
  addNewChatMetadata(chatId: string, command: string): void;
  getChatMetadata(chatId: string): { firstMessage?: string | null } | null;
}

export interface CarryOverDep {
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

export type PendingInputsDep = Pick<
  PendingUserInputServiceContract,
  'clearChat' | 'hasInFlightForChat' | 'markFailed' | 'reconcileRetainedHistory'
>;

export type AgentRegistryDep = Pick<
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

export type ForkChatFileCopyDep = (args: {
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

export interface ChatCommandServiceDeps {
  chats: IChatRegistry;
  queue: ChatExecutionCommands;
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

export interface AcceptedRunPreparation {
  operation: 'fork-run';
  prepare(): Promise<void>;
  compensate(): Promise<void>;
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

export function runOptionsForCommand(
  input: AgentRunCommandRequest | ForkRunCommandRequest,
): RunAgentTurnOptions {
  return {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.thinkingMode === undefined ? {} : { thinkingMode: input.thinkingMode }),
    ...(input.agentSettings === undefined ? {} : { agentSettings: input.agentSettings }),
    ...(input.apiProviderId === undefined ? {} : { apiProviderId: input.apiProviderId }),
    ...(input.modelEndpointId === undefined ? {} : { modelEndpointId: input.modelEndpointId }),
    ...(input.modelProtocol === undefined ? {} : { modelProtocol: input.modelProtocol }),
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
    if (!value?.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', `${field} is required`);
    }
    return value.trim();
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
    const chat = await this.deps.chatListProjector.buildOne(chatId);
    if (chat) return chat;
    throw new CommandValidationError(
      'INTERNAL_ERROR',
      `Session could not be projected after a successful command: ${chatId}`,
      500,
      true,
    );
  }

  async submitHttpRun(
    input: NormalizedSubmitRunInput,
  ): Promise<CommandAcceptedResponse> {
    const clientRequestId = this.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'agent-run',
      chatId: input.chatId,
      clientRequestId,
      payload: runPayload(input, clientMessageId),
      turnId,
    });
    return this.scheduleAcceptedHttpRun(
      ledger,
      input,
      { clientRequestId, clientMessageId, turnId },
      'agent-run',
    );
  }

  async scheduleAcceptedHttpRun(
    ledger: Awaited<ReturnType<CommandLedger['accept']>>,
    input: NormalizedSubmitRunInput,
    ids: { clientRequestId: string; clientMessageId: string; turnId: string },
    commandType: Extract<AgentExecutionCommandType, 'agent-run' | 'fork-run'>,
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
      this.throwRecordedExecutionFailure(ledger.record);
      return commandResultFromRecord(ledger.record, 'duplicate');
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
      throw await this.withCurrentExecutionControl(input.chatId, error);
    }
    return commandResultFromRecord(
      ledger.record,
      recoveringAcceptedCommand ? 'duplicate' : 'accepted',
    );
  }

  async withCurrentExecutionControl(chatId: string, error: unknown): Promise<unknown> {
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
