import crypto from 'crypto';
import type { CommandAcceptedResponse, CommandErrorCode } from '../../common/chat-command-contracts.js';
import {
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import type { AgentRunCommandRequest, ForkRunCommandRequest } from '../../common/chat-command-contracts.js';
import type { AgentRunRequest, ForkRunRequest } from '../../common/ws-requests.js';
import type { IChatRegistry } from '../chats/store.js';
import { requireChatExecutionConfig, type RunAgentTurnOptions } from '../agents/session-types.js';
import type { CommandLedger, CommandLedgerRecord } from './command-ledger.js';

type CommandTransport = 'http' | 'websocket';

interface QueueDep {
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  registerPendingUserInput?(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  appendUserMessage?(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  runAcceptedTurn?(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
}

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

export function queueDrainOptions(chatId: string, registry: IChatRegistry): RunAgentTurnOptions {
  const entry = requireChatExecutionConfig(chatId, registry.getChat(chatId));
  const chat = registry.getChat(chatId);
  return {
    permissionMode: entry.permissionMode,
    thinkingMode: entry.thinkingMode,
    claudeThinkingMode: entry.claudeThinkingMode,
    ampAgentMode: entry.ampAgentMode,
    model: entry.model,
    apiProviderId: chat?.apiProviderId,
    modelEndpointId: chat?.modelEndpointId,
    modelProtocol: chat?.modelProtocol,
  };
}

export class ChatCommandService {
  constructor(private readonly deps: {
    chats: Pick<IChatRegistry, 'getChat'>;
    queue: QueueDep;
    ledger?: CommandLedger;
  }) {}

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
    if (typeof this.deps.queue.registerPendingUserInput === 'function') {
      await this.deps.queue.registerPendingUserInput(chatId, command, options);
      return;
    }
    await this.deps.queue.appendUserMessage?.(chatId, command, options);
  }

  #runAcceptedTurn(ledgerKey: string, chatId: string, command: string, options: RunAgentTurnOptions): void {
    const runAcceptedTurn = this.deps.queue.runAcceptedTurn;
    if (!runAcceptedTurn) {
      throw new CommandValidationError('INTERNAL_ERROR', 'Queue turn runner is not configured', 500, true);
    }
    void runAcceptedTurn.call(this.deps.queue, chatId, command, options)
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
