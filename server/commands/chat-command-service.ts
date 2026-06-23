import crypto from 'crypto';
import { promises as fs } from 'fs';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import type {
  AgentStopResponse,
  CommandAcceptedResponse,
  CommandErrorCode,
  PermissionDecisionPayload,
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
import { normalizeQueueState } from '../../common/queue-state.js';
import type { QueueState } from '../../common/queue-state.js';
import type { ChatRegistryEntry, IChatRegistry } from '../chats/store.js';
import type { RunAgentTurnOptions, StartedAgentSession } from '../agents/session-types.js';
import { PRE_SCHEDULE_FAILURE_ERROR_CODE, type CommandLedger, type CommandLedgerRecord } from './command-ledger.js';
import type { ChatQueueService } from '../queue.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ForkChatFileCopyResult } from '../chats/fork-chat.js';
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

type PendingInputsDep = Pick<PendingUserInputServiceContract, 'clearChat'>;

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
  | 'isAgentSessionRunning'
  | 'forkAgentSession'
  | 'compactSession'
>;

interface ForkChatInput {
  sourceChatId: string;
  chatId: string;
}

type ForkChatFileCopyDep = (args: {
  sourceSession: ChatRegistryEntry;
  sourceChatId: string;
  targetChatId: string;
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
  forkChatFileCopy?: ForkChatFileCopyDep;
}

export class ChatCommandService {
  constructor(private readonly deps: ChatCommandServiceDeps) {}

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
    return this.#submitHttpRun(input);
  }

  async forkChat(input: ForkChatInput): Promise<ForkChatFileCopyResult> {
    const context = this.#validateFork(input);
    return this.#forkChatFromContext(context);
  }

  async submitForkRun(input: SubmitForkRunInput): Promise<CommandAcceptedResponse> {
    this.#assertContent(input.command, input.images);
    return this.#submitHttpForkRun(input);
  }

  async submitQueueEnqueue(input: QueueEnqueueInput): Promise<QueueEnqueueResponse> {
    this.#requireChat(input.chatId);
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
        queue: state,
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
      queue: state,
    };
  }

  async enqueueQueue(input: QueueDirectEnqueueInput): Promise<QueueMutationResponse & { entryId: string }> {
    this.#requireChat(input.chatId);
    const result = await this.deps.queue.enqueueChat(input.chatId, input.content);
    this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
      logger.error('queue: enqueue drain error:', err.message);
    });
    return {
      success: true,
      chatId: input.chatId,
      entryId: result.entry.id,
      queue: normalizeQueueState(result.queue),
    };
  }

  async mutateQueue(input: QueueMutationInput): Promise<QueueMutationResponse> {
    this.#requireChat(input.chatId);
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
    return { success: true, chatId: input.chatId, queue: normalizeQueueState(state) };
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

    return { sourceChatId, targetChatId, sourceSession };
  }

  async #forkChatFromContext(context: ForkContext): Promise<ForkChatFileCopyResult> {
    if (!this.deps.forkChatFileCopy) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    return this.deps.forkChatFileCopy({
      sourceSession: context.sourceSession,
      sourceChatId: context.sourceChatId,
      targetChatId: context.targetChatId,
      registry: this.deps.chats,
      settings: this.deps.settings,
      metadata: this.deps.metadata,
      forkAgentSession: this.deps.agents.forkAgentSession?.bind(this.deps.agents),
      supportsFork: this.deps.agents.supportsFork.bind(this.deps.agents),
    });
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
