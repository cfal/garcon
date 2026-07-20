import crypto from 'crypto';
import type {
  ForkChatCommandRequest,
  ForkChatResponse,
  ForkRunCommandResponse,
} from '../../common/chat-command-contracts.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import { rollbackForkTarget, type ForkChatFileCopyResult } from '../chats/fork-chat.js';
import { commandLedgerKey } from './command-ledger.js';
import {
  CommandSupport,
  CommandValidationError,
  commandResultFromRecord,
  runOptionsForCommand,
  type NormalizedSubmitForkRunInput,
  type SubmitForkRunInput,
} from './command-support.js';

interface ForkContext {
  sourceChatId: string;
  targetChatId: string;
  sourceSession: ChatRegistryEntry;
  sourceNextForkOrdinal: number;
  upToSeq?: number;
}

export class ForkCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async forkChat(input: ForkChatCommandRequest): Promise<ForkChatResponse> {
    const normalized = {
      ...input,
      sourceChatId: this.support.requireChatId(input.sourceChatId, 'sourceChatId'),
      chatId: this.support.requireChatId(input.chatId),
    };
    return this.support.withChatMutationLocks([normalized.sourceChatId, normalized.chatId], async () => {
      const context = this.validateFork(normalized);
      await this.forkChatFromContext(context);
      return { success: true, chat: await this.support.projectCommandChat(context.targetChatId) };
    });
  }

  async submitForkRun(input: SubmitForkRunInput): Promise<ForkRunCommandResponse> {
    this.support.assertContent(input.command, input.images);
    const normalized = {
      sourceChatId: this.support.requireChatId(input.sourceChatId, 'sourceChatId'),
      chatId: this.support.requireChatId(input.chatId),
      command: input.command,
      images: input.images,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      options: runOptionsForCommand(input),
    };
    return this.support.withChatMutationLocks(
      [normalized.sourceChatId, normalized.chatId],
      () => this.submitHttpForkRun(normalized),
    );
  }

  private async submitHttpForkRun(input: NormalizedSubmitForkRunInput): Promise<ForkRunCommandResponse> {
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.support.requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledgerKey = commandLedgerKey('fork-run', input.chatId, clientRequestId);
    const priorRecord = await this.deps.ledger.getRecord(ledgerKey);
    let forkContext: ForkContext | null = null;
    if (!priorRecord) forkContext = this.validateFork(input);
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
      this.support.throwRecordedExecutionFailure(ledger.record);
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        chat: await this.support.projectCommandChat(ledger.record.chatId),
      };
    }

    const resolvedForkContext = forkContext ?? this.validateFork(input);
    let forkResult: ForkChatFileCopyResult | null = null;
    const result = await this.support.scheduleAcceptedHttpRun(ledger, input, {
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
        forkResult = await this.forkChatFromContext(resolvedForkContext);
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
    return { ...result, chat: await this.support.projectCommandChat(input.chatId) };
  }

  private validateFork(input: ForkChatCommandRequest): ForkContext {
    const sourceChatId = this.support.requireChatId(input.sourceChatId, 'sourceChatId');
    const targetChatId = this.support.requireChatId(input.chatId);
    const upToSeq = input.upToSeq;

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
      this.deps.agents.isAgentSessionRunning(sourceSession.agentId, sourceSession.agentSessionId)
      && !this.deps.agents.supportsForkWhileRunning(sourceSession.agentId)
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

  private async forkChatFromContext(context: ForkContext): Promise<ForkChatFileCopyResult> {
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
}

function normalizeNextForkOrdinal(value: unknown): number | null {
  const parsed = typeof value === 'string'
    ? Number.parseInt(value, 10)
    : typeof value === 'number'
      ? value
      : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
