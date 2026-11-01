import crypto from 'crypto';
import type {
  ForkChatCommandRequest,
  ForkChatResponse,
  ForkRunCommandResponse,
} from '../../../common/chat-command-contracts.js';
import type { ChatRegistryEntry } from '../chats/registry-contracts.js';
import { ForkCreationCleanupError, isHandoffForkRefusal, prepareForkSource, rollbackForkTarget, type ForkedChatResult, type PreparedForkSource } from '../chats/fork-chat.js';
import { PRE_SCHEDULE_FAILURE_ERROR_CODE } from './command-ledger.js';
import {
  CommandSupport,
  CommandValidationError,
  agentTurnResultFromRecord,
  type NormalizedSubmitForkRunInput,
  type SubmitForkRunInput,
} from './command-support.js';
import { runOptionsForCommand } from '../agents/agent-run-command-input.js';
import type { ThinkingMode } from '../../../common/chat-modes.js';
import type { ExecutorOperation } from '../../../common/executor-contracts.js';

interface ForkContext {
  sourceChatId: string;
  targetChatId: string;
  sourceSession: ChatRegistryEntry;
  upToOrdinal?: number;
  allowHandoffFork?: boolean;
  preparedSource?: PreparedForkSource;
}

export class ForkCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async forkChat(
    input: ForkChatCommandRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ForkChatResponse> {
    const normalized = {
      ...input,
      sourceChatId: this.support.requireChatId(input.sourceChatId, 'sourceChatId'),
      chatId: this.support.requireChatId(input.chatId),
    };
    return this.support.withChatMutationLocks([normalized.sourceChatId, normalized.chatId], async () => {
      if (normalized.clientRequestId === undefined) {
        await this.forkChatFromContext(await this.validateFork(normalized, { signal }), signal);
      } else {
        await this.createForkOnce(normalized, normalized.clientRequestId, signal);
      }
      return { success: true, chat: await this.support.projectCommandChat(normalized.chatId) };
    });
  }

  // A repeat of a completed fork returns it. Anything else runs again: a failed fork left no
  // chat to return, and validation refuses a target that a failed rollback left behind.
  private async createForkOnce(
    input: ForkChatCommandRequest,
    clientRequestId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const acceptance = {
      commandType: 'fork',
      chatId: input.chatId,
      clientRequestId: this.support.requireClientRequestId(clientRequestId),
      payload: forkChatPayload(input),
    };
    const observed = await this.deps.ledger.observe(acceptance);
    if (observed) this.support.throwOnConflict(observed, 'clientRequestId was reused with different payload');
    if (observed?.record.status === 'finished') return;
    const context = await this.validateFork(input, { signal });
    const ledger = await this.deps.ledger.accept(acceptance);
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    if (ledger.kind === 'duplicate' && ledger.record.status === 'finished') return;
    try {
      await this.forkChatFromContext(context, signal);
    } catch (error) {
      await this.deps.ledger.settleTerminal(ledger.record.key, 'failed', {
        error: error instanceof Error ? error.message : String(error),
        errorCode: PRE_SCHEDULE_FAILURE_ERROR_CODE,
      });
      throw error;
    }
    await this.deps.ledger.settleTerminal(ledger.record.key, 'finished');
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
      ...(input.allowHandoffFork ? { allowHandoffFork: true } : {}),
      options: runOptionsForCommand(input),
    };
    return this.support.withChatMutationLocks(
      [normalized.sourceChatId, normalized.chatId],
      (deadline) => this.submitHttpForkRun(normalized, deadline),
    );
  }

  private async submitHttpForkRun(input: NormalizedSubmitForkRunInput, deadline: number): Promise<ForkRunCommandResponse> {
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.support.requireClientRequestId(input.clientMessageId, 'clientMessageId');
    const turnId = crypto.randomUUID();
    const ledgerInput = {
      commandType: 'fork-run',
      chatId: input.chatId,
      clientRequestId,
      payload: forkPayload(input, clientMessageId),
      turnId,
    } as const;
    const observed = await this.deps.ledger.observe(ledgerInput);
    if (observed) this.support.throwOnConflict(observed, 'clientRequestId was reused with different payload');
    const priorRecord = observed?.record;

    const retryingPreScheduleFailure = priorRecord?.status === 'failed'
      && priorRecord.errorCode === PRE_SCHEDULE_FAILURE_ERROR_CODE;
    if (priorRecord && priorRecord.status !== 'accepted' && !retryingPreScheduleFailure) {
      this.support.throwRecordedExecutionFailure(priorRecord);
      return {
        ...agentTurnResultFromRecord(priorRecord, 'duplicate'),
        chat: await this.support.projectCommandChat(priorRecord.chatId),
      };
    }

    const recovering = priorRecord?.status === 'accepted';
    const preparedFork = recovering ? priorRecord.forkPreparation : undefined;
    const forkAlreadyCreated = preparedFork !== undefined && this.deps.chats.getChat(input.chatId) !== null;
    let forkContext: ForkContext | null = null;
    const validate = async (signal?: AbortSignal) => {
      if (forkAlreadyCreated) {
        const target = this.deps.chats.getChat(input.chatId);
        if (!target) throw new CommandValidationError('SESSION_NOT_FOUND', 'Target session not found', 404);
        this.assertRunnable(target, input, [target.agentSessionId ? 'execution.resume' : 'execution.start']);
      } else {
        forkContext = await this.validateFork(input, { thinkingMode: input.options.thinkingMode, signal });
        this.assertRunnable(forkContext.sourceSession, input, forkContext.preparedSource?.needsNativeFork
          ? ['execution.start', 'execution.resume'] : ['execution.start']);
      }
    };
    if (!recovering) await validate();
    const ledger = recovering
      ? { kind: 'duplicate' as const, record: priorRecord }
      : await this.deps.ledger.accept(ledgerInput);
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');

    let forkResult: ForkedChatResult | null = null;
    let nativeCleanup = preparedFork?.nativeCleanup ?? null;
    const discardNative = async () => {
      if (!nativeCleanup) return;
      await this.deps.agents.discardForkedAgentSession(nativeCleanup);
      nativeCleanup = null;
      await this.deps.ledger.update(ledger.record.key, {
        forkPreparation: { phase: forkAlreadyCreated ? 'created' : 'creating', sourceChatId: input.sourceChatId, nativeCleanup: null },
      });
    };
    const result = await this.support.scheduleAcceptedHttpRun(ledger, input, {
      clientRequestId,
      clientMessageId,
      turnId,
    }, 'fork-run', deadline, {
      operation: 'fork-run',
      ...(recovering ? { validateRecovery: ({ signal }: { signal: AbortSignal }) => validate(signal) } : {}),
      prepare: async ({ signal }) => {
        if (forkAlreadyCreated) return;
        if (!forkContext) throw new Error('Fork source was not prepared');
        // A disappeared target does not discharge its original native cleanup obligation.
        await discardNative();
        await this.deps.ledger.update(ledger.record.key, {
          forkPreparation: {
            phase: 'creating',
            sourceChatId: forkContext.sourceChatId,
          },
        });
        try {
          forkResult = await this.forkChatFromContext(forkContext, signal);
        } catch (error) {
          if (error instanceof ForkCreationCleanupError) {
            nativeCleanup = error.nativeCleanup;
            await this.deps.ledger.update(ledger.record.key, {
              forkPreparation: { phase: 'creating', sourceChatId: forkContext.sourceChatId, nativeCleanup },
            });
          }
          throw error;
        }
        await this.deps.ledger.update(ledger.record.key, {
          forkPreparation: {
            phase: 'created',
            sourceChatId: forkContext.sourceChatId,
            nativeCleanup: forkResult.nativeCleanup,
          },
        });
      },
      compensate: async () => {
        if (forkResult) {
          try {
            await forkResult.rollback();
          } finally {
            nativeCleanup = forkResult.nativeCleanup;
            await this.deps.ledger.update(ledger.record.key, {
              forkPreparation: { phase: 'created', sourceChatId: input.sourceChatId, nativeCleanup },
            });
          }
        } else {
          const cleanups = await Promise.allSettled([
            rollbackForkTarget({ targetChatId: input.chatId, settings: this.deps.settings, ownership: this.deps.ownership }),
            discardNative(),
          ]);
          const failures = cleanups.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
          if (failures.length) throw new AggregateError(failures, `Failed to roll back fork ${input.chatId}`);
        }
        forkResult = null;
        nativeCleanup = null;
      },
    });
    return { ...result, chat: await this.support.projectCommandChat(input.chatId) };
  }

  private assertRunnable(target: ChatRegistryEntry, input: NormalizedSubmitForkRunInput, operations: readonly ExecutorOperation[]): void {
    this.deps.agents.assertExecutionModeSelectionSupported(target.agentId, {
      executorId: target.executorId,
      thinkingMode: input.options.thinkingMode,
    });
    this.deps.agents.assertExecutionSupported({ ...target, ...input.options }, operations);
    this.support.assertAttachmentsSupported({
      agentId: target.agentId,
      executorId: target.executorId,
      model: input.options.model ?? target.model,
      apiProviderId: input.options.apiProviderId === undefined ? target.apiProviderId : input.options.apiProviderId,
      modelEndpointId: input.options.modelEndpointId === undefined ? target.modelEndpointId : input.options.modelEndpointId,
      attachments: input.images ?? [],
    });
  }

  private async validateFork(
    input: ForkChatCommandRequest,
    options: { thinkingMode?: ThinkingMode; signal?: AbortSignal } = {},
  ): Promise<ForkContext> {
    const { sourceChatId, chatId: targetChatId, upToOrdinal } = input;

    if (upToOrdinal !== undefined && (!Number.isSafeInteger(upToOrdinal) || upToOrdinal <= 0)) {
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
    if (!this.deps.createForkedChat) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    let sourceSession = this.deps.chats.getChat(sourceChatId);
    if (!sourceSession) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Source session not found', 404);
    }
    if (!this.deps.agents.supportsFork(sourceSession.agentId, sourceSession.executorId)) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Fork unsupported for agent: ${sourceSession.agentId}`,
        422,
      );
    }
    this.deps.agents.assertExecutionModeSelectionSupported(sourceSession.agentId, {
      executorId: sourceSession.executorId,
      thinkingMode: options.thinkingMode,
    });
    if (
      upToOrdinal !== undefined
      && !this.deps.agents.supportsForkAtMessage(sourceSession.agentId, sourceSession.executorId)
    ) {
      throw new CommandValidationError(
        'UNSUPPORTED_AGENT',
        `Fork at message unsupported for agent: ${sourceSession.agentId}`,
        422,
      );
    }
    if (this.deps.chats.getChat(targetChatId)) {
      throw new CommandValidationError('CHAT_ID_COLLISION', `Session already exists: ${targetChatId}`, 409);
    }
    const viewId = await this.deps.agents.currentTranscriptViewId(sourceChatId, options.signal);
    options.signal?.throwIfAborted();
    sourceSession = this.deps.chats.getChat(sourceChatId);
    if (!sourceSession) {
      throw new CommandValidationError('SESSION_NOT_FOUND', 'Source session not found', 404);
    }
    if (input.transcriptViewId !== undefined && viewId !== input.transcriptViewId) {
      throw new CommandValidationError(
        'STALE_TRANSCRIPT_VIEW',
        'The view changed since this fork point was chosen. Refetch and pick the message again.',
        409,
        true,
      );
    }
    const preparedSource = await prepareForkSource(this.deps.transcripts, sourceChatId, sourceSession, upToOrdinal, options.signal);
    if (preparedSource.needsNativeFork) {
      try {
        preparedSource.needsNativeFork = this.deps.agents.assertNativeForkSupported(sourceSession);
      } catch (error) {
        if (!input.allowHandoffFork || !isHandoffForkRefusal(error)) throw error;
        preparedSource.needsNativeFork = false;
      }
    }

    return {
      sourceChatId,
      targetChatId,
      preparedSource,
      sourceSession: {
        ...sourceSession,
        thinkingMode: this.deps.agents.normalizeThinkingModeForAgent(
          sourceSession.agentId,
          sourceSession.thinkingMode,
          sourceSession.executorId,
        ),
      },
      ...(upToOrdinal ? { upToOrdinal } : {}),
      ...(input.allowHandoffFork ? { allowHandoffFork: true } : {}),
    };
  }

  private async forkChatFromContext(
    context: ForkContext,
    signal: AbortSignal,
  ): Promise<ForkedChatResult> {
    if (!this.deps.createForkedChat) {
      throw new CommandValidationError('UNSUPPORTED_AGENT', 'Forking is not configured on this server', 503, true);
    }

    return this.deps.createForkedChat({
      sourceSession: context.sourceSession,
      sourceChatId: context.sourceChatId,
      targetChatId: context.targetChatId,
      signal,
      preparedSource: context.preparedSource,
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

// As in forkPayload, handoff consent repeats the same logical fork after its refusal.
function forkChatPayload(input: ForkChatCommandRequest): Record<string, unknown> {
  return {
    sourceChatId: input.sourceChatId,
    chatId: input.chatId,
    upToOrdinal: input.upToOrdinal,
    transcriptViewId: input.transcriptViewId,
  };
}

function forkPayload(input: NormalizedSubmitForkRunInput, clientMessageId: string): Record<string, unknown> {
  // Consent retries the same logical command after a pre-schedule refusal, so it is not part of
  // the idempotency payload. The prompt, attachments, target, and both client identities remain
  // unchanged while the explicit capability permits only the handoff fallback.
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
