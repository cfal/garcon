import crypto from 'crypto';
import { promises as fs } from 'fs';
import { maybeGenerateChatTitle } from '../chats/title-generator.js';
import type {
  AgentStopResponse,
  CommandAcceptedResponse,
  CommandErrorCode,
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
import type { AgentRunRequest, ForkRunRequest } from '../../common/ws-requests.js';
import { normalizeQueueState } from '../../common/queue-state.js';
import type { QueueState } from '../../common/queue-state.js';
import type { IChatRegistry } from '../chats/store.js';
import type { RunAgentTurnOptions } from '../agents/session-types.js';
import type { CommandLedger, CommandLedgerRecord } from './command-ledger.js';
import type { ChatQueueService } from '../queue.js';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';

type CommandTransport = 'http' | 'websocket';

type QueueDep = Pick<
  ChatQueueService,
  | 'submit'
  | 'registerPendingUserInput'
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
  getUiSettings(): Promise<{ chatTitle?: unknown } | null | undefined>;
  getChatName(chatId: string): string | null | undefined;
  setSessionName(chatId: string, title: string): Promise<unknown>;
  setLastChatDefaults(defaults: Record<string, unknown>): Promise<void>;
  ensureInNormal(chatId: string): Promise<void>;
  removeFromAllOrderLists(chatId: string): Promise<void>;
}

interface MetadataDep {
  addNewChatMetadata(chatId: string, command: string): void;
}

type PendingInputsDep = Pick<PendingUserInputServiceContract, 'register' | 'clearChat'>;

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
>;

interface SubmitRunInput {
  transport: CommandTransport;
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
  ensureForked?: () => Promise<void>;
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

interface PermissionDecisionInput {
  chatId: string;
  permissionRequestId: string;
  allow: boolean;
  alwaysAllow: boolean;
  clientRequestId: string;
}

interface StopInput {
  chatId: string;
  clientRequestId: string;
  agentId?: unknown;
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
  body: Partial<AgentRunCommandRequest | ForkRunCommandRequest | AgentRunRequest | ForkRunRequest>,
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

export class ChatCommandService {
  constructor(private readonly deps: {
    chats: Pick<IChatRegistry, 'getChat' | 'addChat' | 'removeChat'>;
    queue: QueueDep;
    ledger?: CommandLedger;
    settings?: SettingsDep;
    metadata?: MetadataDep;
    agents?: AgentRegistryDep;
    pendingInputs?: PendingInputsDep;
  }) {}

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
    if (!this.#requireAgents().hasAgent(agentId)) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', `Unsupported agent: ${agentId}`);
    }
    if (images.length > 0) {
      let imageSupport = false;
      try {
        imageSupport = await this.#requireAgents().modelSupportsImages({
          agentId,
          model: input.model,
          apiProviderId: input.apiProviderId,
          modelEndpointId: input.modelEndpointId,
        });
      } catch {}
      const hasBackendSelection = Boolean(input.apiProviderId && input.modelEndpointId);
      const supportsImages = hasBackendSelection ? imageSupport : this.#requireAgents().supportsImages(agentId);
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
    const ledger = await this.#requireLedger().accept({
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
    this.#requireMetadata().addNewChatMetadata(chatId, command);

    await this.#requireSettings().setLastChatDefaults({
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
    await this.#requireSettings().ensureInNormal(chatId);
    await this.#requirePendingInputs().register(chatId, command, {
      clientRequestId,
      clientMessageId,
      turnId,
      images: images.length > 0 ? images : undefined,
      deliveryStatus: 'accepted',
    });

    try {
      await this.#requireLedger().update(ledger.record.key, { status: 'scheduled', turnId });
      await this.#requireAgents().startSession(chatId, command, {
        ...(input.requestOptions ?? {}),
        projectPath,
        clientRequestId,
        turnId,
      });
    } catch (error: unknown) {
      await this.#requireLedger().update(ledger.record.key, { status: 'failed', error: (error as Error).message });
      this.#requirePendingInputs().clearChat(chatId, 'chat-removed');
      this.deps.chats.removeChat(chatId);
      try {
        await this.#requireSettings().removeFromAllOrderLists(chatId);
      } catch (cleanupError: unknown) {
        console.warn(`sessions: failed to remove ${chatId} from order lists after startup failure:`, (cleanupError as Error).message);
      }
      throw error;
    }

    void maybeGenerateChatTitle({ chatId, projectPath, firstPrompt: command, agents: this.#requireAgents(), settings: this.#requireSettings() });
    const accepted = await this.#requireLedger().updateUnlessStatus(ledger.record.key, ['failed'], { status: 'running', turnId });
    return commandResultFromRecord(accepted ?? ledger.record);
  }

  async submitRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    this.#requireChat(input.chatId);
    this.#assertContent(input.command, input.images);
    if (input.transport === 'websocket') {
      return this.#submitWebSocketRun(input);
    }
    return this.#submitHttpRun(input);
  }

  async submitForkRun(input: SubmitForkRunInput): Promise<CommandAcceptedResponse> {
    if (input.sourceChatId === input.chatId) {
      throw new CommandValidationError('VALIDATION_FAILED', 'sourceChatId and chatId must differ');
    }
    this.#requireChat(input.sourceChatId, 'Source session not found');
    this.#assertContent(input.command, input.images);

    if (input.transport === 'websocket') {
      await input.ensureForked?.();
      return this.#submitWebSocketRun(input);
    }

    return this.#submitHttpForkRun(input);
  }

  async submitQueueEnqueue(input: QueueEnqueueInput): Promise<QueueEnqueueResponse> {
    this.#requireChat(input.chatId);
    const ledger = await this.#requireLedger().accept({
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
    const updated = await this.#requireLedger().update(ledger.record.key, {
      status: 'scheduled',
      entryId: result.entry.id,
    });
    this.deps.queue.triggerDrain(input.chatId).catch((err: Error) => {
      console.error('queue: enqueue drain error:', err.message);
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
      console.error('queue: enqueue drain error:', err.message);
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
        console.error('queue: resume drain error:', err.message);
      });
    }
    return { success: true, chatId: input.chatId, queue: normalizeQueueState(state) };
  }

  async submitPermissionDecision(input: PermissionDecisionInput): Promise<CommandAcceptedResponse> {
    this.#requireChat(input.chatId);
    const ledger = await this.#requireLedger().accept({
      commandType: 'permission-decision',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: {
        chatId: input.chatId,
        permissionRequestId: input.permissionRequestId,
        allow: input.allow,
        alwaysAllow: input.alwaysAllow,
      },
    });
    this.#throwOnConflict(ledger, 'Conflicting permission decision retry');
    if (ledger.kind !== 'duplicate') {
      this.#requireAgents().resolvePermission(input.chatId, input.permissionRequestId, {
        allow: input.allow,
        alwaysAllow: input.alwaysAllow,
      });
      await this.#requireLedger().update(ledger.record.key, { status: 'scheduled' });
    }
    return commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted');
  }

  async submitStop(input: StopInput): Promise<AgentStopResponse> {
    this.#requireChat(input.chatId);
    const ledger = await this.#requireLedger().accept({
      commandType: 'agent-stop',
      chatId: input.chatId,
      clientRequestId: this.#requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, agentId: input.agentId },
    });
    this.#throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    let stopped = false;
    if (ledger.kind !== 'duplicate') {
      stopped = await this.deps.queue.abort(input.chatId);
      await this.#requireLedger().update(ledger.record.key, { status: stopped ? 'finished' : 'failed' });
    }
    return {
      ...commandResultFromRecord(ledger.record, ledger.kind === 'duplicate' ? 'duplicate' : 'accepted'),
      stopped: ledger.kind === 'duplicate' ? ledger.record.status === 'finished' : stopped,
    };
  }

  async #submitWebSocketRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    const options = this.#withTurnIds(input.options ?? {}, {
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
    });
    if (input.images !== undefined) options.images = input.images;
    await this.deps.queue.submit(input.chatId, input.command, options);
    return {
      success: true,
      commandType: 'sourceChatId' in input ? 'fork-run' : 'agent-run',
      chatId: input.chatId,
      clientRequestId: options.clientRequestId!,
      turnId: options.turnId,
      status: 'accepted',
      acceptedAt: new Date().toISOString(),
    };
  }

  async #submitHttpRun(input: SubmitRunInput): Promise<CommandAcceptedResponse> {
    const clientRequestId = this.#requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.#requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledger = await this.#requireLedger().accept({
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
    const ledger = await this.#requireLedger().accept({
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

    await input.ensureForked?.();
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

    await this.#registerPendingInput(input.chatId, input.command, options);
    const scheduled = await this.#requireLedger().update(ledger.record.key, {
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
      .then(() => this.#requireLedger().update(ledgerKey, { status: 'finished' }))
      .catch((error: Error) => {
        console.error('commands: run failed:', error.message);
        this.#requireLedger().update(ledgerKey, { status: 'failed', error: error.message }).catch(() => {});
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

  #requireLedger(): CommandLedger {
    if (!this.deps.ledger) {
      throw new CommandValidationError('INTERNAL_ERROR', 'Command ledger is not configured', 500, true);
    }
    return this.deps.ledger;
  }

  #requireSettings(): SettingsDep {
    if (!this.deps.settings) {
      throw new CommandValidationError('INTERNAL_ERROR', 'Settings service is not configured', 500, true);
    }
    return this.deps.settings;
  }

  #requireMetadata(): MetadataDep {
    if (!this.deps.metadata) {
      throw new CommandValidationError('INTERNAL_ERROR', 'Metadata service is not configured', 500, true);
    }
    return this.deps.metadata;
  }

  #requireAgents(): AgentRegistryDep {
    if (!this.deps.agents) {
      throw new CommandValidationError('INTERNAL_ERROR', 'Agent registry is not configured', 500, true);
    }
    return this.deps.agents;
  }

  #requirePendingInputs(): PendingInputsDep {
    if (!this.deps.pendingInputs) {
      throw new CommandValidationError('INTERNAL_ERROR', 'Pending input service is not configured', 500, true);
    }
    return this.deps.pendingInputs;
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
