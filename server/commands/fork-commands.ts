import crypto from 'crypto';
import type {
  ForkChatCommandRequest,
  ForkChatResponse,
  ForkRunCommandResponse,
} from '../../common/chat-command-contracts.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import { rollbackForkTarget, type ForkChatFileCopyResult } from '../chats/fork-chat.js';
import { commandLedgerKey, PRE_SCHEDULE_FAILURE_ERROR_CODE } from './command-ledger.js';
import {
  CommandSupport,
  CommandValidationError,
  agentTurnResultFromRecord,
  type NormalizedSubmitForkRunInput,
  type SubmitForkRunInput,
} from './command-support.js';
import { runOptionsForCommand } from '../agents/agent-run-command-input.js';

interface ForkContext {
  sourceChatId: string;
  targetChatId: string;
  sourceSession: ChatRegistryEntry;
  sourceNextForkOrdinal: number;
  upToOrdinal?: number;
  allowHandoffFork?: boolean;
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
      const context = await this.validateFork(normalized);
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
    const ledgerInput = {
      commandType: 'fork-run',
      chatId: input.chatId,
      clientRequestId,
      payload: forkPayload(input, clientMessageId),
      turnId,
    } as const;

    const retryingPreScheduleFailure = priorRecord?.status === 'failed'
      && priorRecord.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE;
    if (priorRecord && priorRecord.status !== 'accepted' && !retryingPreScheduleFailure) {
      const ledger = await this.deps.ledger.accept(ledgerInput);
      if (ledger.kind === 'conflict') {
        throw new CommandValidationError(
          'IDEMPOTENCY_CONFLICT',
          'clientRequestId was reused with different payload',
          409,
        );
      }
      this.support.throwRecordedExecutionFailure(ledger.record);
      return {
        ...agentTurnResultFromRecord(ledger.record, 'duplicate'),
        chat: await this.support.projectCommandChat(ledger.record.chatId),
      };
    }

    const preparedFork = priorRecord?.forkPreparation;
    const forkAlreadyCreated = preparedFork !== undefined
      && this.deps.chats.getChat(input.chatId) !== null;
    const forkContext = await this.validateFork(input, { allowExistingTarget: forkAlreadyCreated });
    const source = forkContext.sourceSession;
    await this.support.assertAttachmentsSupported({
      agentId: source.agentId,
      model: input.options?.model ?? source.model,
      apiProviderId: input.options?.apiProviderId === undefined ? source.apiProviderId : input.options.apiProviderId,
      modelEndpointId: input.options?.modelEndpointId === undefined ? source.modelEndpointId : input.options.modelEndpointId,
      attachments: input.images ?? [],
    });
    if (preparedFork?.sourceNextForkOrdinal !== undefined) {
      forkContext.sourceNextForkOrdinal = preparedFork.sourceNextForkOrdinal;
    }

    const submit = async () => {
      const ledger = await this.deps.ledger.accept(ledgerInput);

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
          ...agentTurnResultFromRecord(ledger.record, 'duplicate'),
          chat: await this.support.projectCommandChat(ledger.record.chatId),
        };
      }

      let forkResult: ForkChatFileCopyResult | null = null;
      const result = await this.support.scheduleAcceptedHttpRun(ledger, input, {
        clientRequestId,
        clientMessageId,
        turnId,
      }, 'fork-run', {
        operation: 'fork-run',
        prepare: async () => {
          if (forkAlreadyCreated) return;
          await this.deps.ledger.update(ledger.record.key, {
            forkPreparation: {
              phase: 'creating',
              sourceChatId: forkContext.sourceChatId,
              sourceNextForkOrdinal: forkContext.sourceNextForkOrdinal,
            },
          });
          forkResult = await this.forkChatFromContext(forkContext);
          await this.deps.ledger.update(ledger.record.key, {
            forkPreparation: {
              phase: 'created',
              sourceChatId: forkContext.sourceChatId,
              sourceNextForkOrdinal: forkResult.sourceNextForkOrdinal,
            },
          });
        },
        compensate: async () => {
          if (forkResult) {
            await forkResult.rollback();
          } else {
            await this.rollbackPreparedFork(forkContext);
          }
          forkResult = null;
        },
      });
      return { ...result, chat: await this.support.projectCommandChat(input.chatId) };
    };

    return submit();
  }

  private async validateFork(
    input: ForkChatCommandRequest,
    options: { allowExistingTarget?: boolean } = {},
  ): Promise<ForkContext> {
    const sourceChatId = this.support.requireChatId(input.sourceChatId, 'sourceChatId');
    const targetChatId = this.support.requireChatId(input.chatId);
    const upToOrdinal = input.upToOrdinal;

    if (
      upToOrdinal !== undefined
      && (!Number.isSafeInteger(upToOrdinal) || upToOrdinal <= 0)
    ) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'upToOrdinal must be a positive safe integer',
      );
    }
    if (input.transcriptViewId !== undefined && upToOrdinal === undefined) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'transcriptViewId requires upToOrdinal',
      );
    }
    if (upToOrdinal !== undefined && input.transcriptViewId === undefined) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'upToOrdinal requires transcriptViewId',
      );
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
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Fork unsupported for agent: ${sourceSession.agentId}`,
        422,
      );
    }
    if (
      upToOrdinal !== undefined
      && !this.deps.agents.supportsForkAtMessage(sourceSession.agentId)
    ) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Fork at message unsupported for agent: ${sourceSession.agentId}`,
        422,
      );
    }
    if (upToOrdinal !== undefined) {
      if (input.transcriptViewId !== undefined) {
        const view = this.deps.transcripts.currentView(sourceChatId);
        if (view === null || view.viewId !== input.transcriptViewId) {
          throw new CommandValidationError(
            'STALE_TRANSCRIPT_VIEW',
            'The view changed since this fork point was chosen. Refetch and pick the message again.',
            409,
            true,
          );
        }
      }
    }
    if (!options.allowExistingTarget && this.deps.chats.getChat(targetChatId)) {
      throw new CommandValidationError('IDEMPOTENCY_CONFLICT', `Session already exists: ${targetChatId}`, 409);
    }

    return {
      sourceChatId,
      targetChatId,
      sourceSession,
      sourceNextForkOrdinal: normalizeNextForkOrdinal(sourceSession.nextForkOrdinal) ?? 1,
      ...(upToOrdinal ? { upToOrdinal } : {}),
      ...(input.allowHandoffFork ? { allowHandoffFork: true } : {}),
    };
  }

  private async rollbackPreparedFork(context: ForkContext): Promise<void> {
    const target = this.deps.chats.getChat(context.targetChatId);
    const failures: unknown[] = [];
    try {
      await rollbackForkTarget({
        sourceChatId: context.sourceChatId,
        targetChatId: context.targetChatId,
        registry: this.deps.chats,
        settings: this.deps.settings,
        ownership: this.deps.ownership,
        sourceNextForkOrdinal: context.sourceNextForkOrdinal,
      });
    } catch (error) {
      failures.push(error);
    }
    if (target?.agentSessionId) {
      try {
        await this.deps.agents.discardForkedAgentSession(target.agentId, {
          agentSessionId: target.agentSessionId,
          nativeSession: target.nativeSession,
          nativeSeedReceipt: target.nativeSeedReceipt,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to roll back fork ${context.targetChatId}`);
    }
  }

  private async forkChatFromContext(context: ForkContext): Promise<ForkChatFileCopyResult> {
    if (!this.deps.forkChatFileCopy) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    return this.deps.forkChatFileCopy({
      sourceSession: context.sourceSession,
      sourceChatId: context.sourceChatId,
      targetChatId: context.targetChatId,
      ...(context.upToOrdinal ? { upToOrdinal: context.upToOrdinal } : {}),
      ...(context.allowHandoffFork ? { allowHandoffFork: true } : {}),
      registry: this.deps.chats,
      settings: this.deps.settings,
      metadata: this.deps.metadata,
      ledger: this.deps.transcripts,
      ownership: this.deps.ownership,
      forkAgentSession: this.deps.agents.forkAgentSession.bind(this.deps.agents),
      discardForkedAgentSession: this.deps.agents.discardForkedAgentSession.bind(this.deps.agents),
      readForkedNativeHistory: this.deps.readForkedNativeHistory,
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
