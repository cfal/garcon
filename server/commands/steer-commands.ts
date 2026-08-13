import type {
  CommandErrorCode,
  QueueEntrySteerCommandRequest,
  QueueEntrySteerCommandResponse,
  SteerDeliveryOutcome,
  SteerCommandRequest,
  SteerCommandResponse,
} from '../../common/chat-command-contracts.ts';
import {
  DomainError,
  QueueEntrySteerError,
  SteerDeliveryError,
} from '../lib/domain-error.ts';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { AcceptedExecutionCommand } from '../chat-execution/types.ts';
import { KeyedPromiseLock } from '../lib/keyed-lock.ts';
import { createLogger, type Logger } from '../lib/log.ts';
import { PromiseTimeoutError, withPromiseTimeout } from '../lib/promise-timeout.ts';
import {
  commandLedgerKey,
  SteerIdentityCapacityError,
  type LedgerAcceptResult,
  type CommandLedgerRecord,
} from './command-ledger.ts';
import {
  CommandSupport,
  CommandValidationError,
  commandResultFromRecord,
} from './command-support.ts';

const logger = createLogger('commands:steer');
const STEER_CAPACITY_EXHAUSTED_MESSAGE =
  'Steering is temporarily unavailable because the server has retained its maximum number of steering identities';
const STEER_FILE_CONTEXT_TIMEOUT_MS = 2_000;
const STEER_FILE_CONTEXT_IN_FLIGHT_LIMIT = 8;

export class SteerCommands {
  // Preserves steering admission order without holding the command lock during file reads.
  readonly #preparationLocks = new KeyedPromiseLock();
  readonly #fileContextResolutions = new Map<string, Promise<string>>();

  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async submit(input: SteerCommandRequest): Promise<SteerCommandResponse> {
    this.support.assertContent(input.content);
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.support.requireClientRequestId(
      input.clientMessageId,
      'clientMessageId',
    );
    const initialChat = this.deps.chats.getChat(input.chatId);
    const integrationId = initialChat?.agentId;
    const target = initialChat ? this.deps.queue.captureSteerTarget(input.chatId) : null;
    const ledgerInput = {
      commandType: 'steer',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        chatId: input.chatId,
        transcriptViewId: input.transcriptViewId,
        content: input.content,
        clientMessageId,
      },
    };
    let outcomeTurnId = target?.identity.turnId;

    try {
      let providerContent = input.content;
      const scheduleResponse = () => this.support.withChatMutationLock(input.chatId, async () => {
        if (!initialChat) {
          const observed = await this.deps.ledger.observe(ledgerInput);
          if (observed) {
            this.support.throwOnConflict(
              observed,
              'clientRequestId was reused with different payload',
            );
            return this.#duplicateResponse(observed.record);
          }
          throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
        }

        await this.support.assertCurrentTranscriptView(input.chatId, input.transcriptViewId);

        let ledger: LedgerAcceptResult;
        try {
          ledger = await this.deps.ledger.accept(ledgerInput);
        } catch (error) {
          if (error instanceof SteerIdentityCapacityError) {
            throw new CommandValidationError(
              'STEER_CAPACITY_EXHAUSTED',
              STEER_CAPACITY_EXHAUSTED_MESSAGE,
              503,
              false,
            );
          }
          throw error;
        }
        this.support.throwOnConflict(
          ledger,
          'clientRequestId was reused with different payload',
        );

        outcomeTurnId = ledger.record.turnId;
        if (ledger.kind === 'duplicate') {
          return this.#duplicateResponse(ledger.record);
        }

        outcomeTurnId = target?.identity.turnId;
        const command = {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId,
        };
        if (!this.deps.chats.getChat(input.chatId)) {
          const error = new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
          await this.support.settlement.settleSteerFailure(command, error);
          throw error;
        }
        if (!target) {
          const error = new DomainError(
            'STEER_TURN_UNAVAILABLE',
            'There is no active turn to steer',
            409,
          );
          await this.support.settlement.settleSteerFailure(command, error);
          throw error;
        }

        const outcome = await this.deps.queue.deliverAcceptedSteer({
          command,
          content: input.content,
          providerContent,
          clientMessageId,
          transcriptViewId: input.transcriptViewId,
          target,
          settlement: this.support.settlement,
        });
        return {
          ...commandResultFromRecord(ledger.record),
          commandType: 'steer' as const,
          chatId: input.chatId,
          turnId: outcome.turnId,
        };
      });
      const scheduled = await this.#preparationLocks.runExclusive(`chat:${input.chatId}`, async () => {
        providerContent = await this.#resolveProviderContent({
          chatId: input.chatId,
          clientRequestId,
          content: input.content,
          projectPath: initialChat?.projectPath,
        });
        // Enqueues the command lock before releasing steering preparation order.
        return { response: scheduleResponse() };
      });
      const response = await scheduled.response;
      logSteerOutcome(logger, {
        chatId: input.chatId,
        clientRequestId,
        integrationId,
        turnId: response.turnId,
      }, { kind: 'accepted', status: response.status });
      return response;
    } catch (error) {
      logSteerOutcome(logger, {
        chatId: input.chatId,
        clientRequestId,
        integrationId,
        turnId: outcomeTurnId,
      }, { kind: 'failed', error });
      throw error;
    }
  }

  async submitQueueEntry(
    input: QueueEntrySteerCommandRequest,
  ): Promise<QueueEntrySteerCommandResponse> {
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const entryId = this.support.requireQueueEntryId(input.entryId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'expectedRevision must be a positive integer',
      );
    }
    if (!Number.isSafeInteger(input.expectedReorderRevision) || input.expectedReorderRevision < 0) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'expectedReorderRevision must be a non-negative integer',
      );
    }

    const initialChat = this.deps.chats.getChat(input.chatId);
    const integrationId = initialChat?.agentId;
    const observedControl = initialChat
      ? await this.deps.queue.readChatExecutionControl(input.chatId)
      : null;
    const observedEntry = observedControl?.entries.find((entry) => (
      entry.id === entryId && entry.status === 'queued'
    ));
    const priorRecord = await this.deps.ledger.getRecord(
      commandLedgerKey('steer', input.chatId, clientRequestId),
    );
    const priorClientMessageId = typeof priorRecord?.payload.clientMessageId === 'string'
      ? priorRecord.payload.clientMessageId
      : null;
    const clientMessageId = priorClientMessageId
      ?? observedEntry?.submission?.clientMessageId
      ?? observedEntry?.delivery?.clientMessageId
      ?? entryId;
    const target = initialChat ? this.deps.queue.captureSteerTarget(input.chatId) : null;
    const ledgerInput = {
      commandType: 'steer',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        chatId: input.chatId,
        transcriptViewId: input.transcriptViewId,
        clientMessageId,
        source: {
          kind: 'queue-entry',
          entryId,
          expectedRevision: input.expectedRevision,
          expectedReorderRevision: input.expectedReorderRevision,
        },
      },
      entryId,
    };
    let outcomeTurnId = target?.identity.turnId;

    try {
      let providerContent = observedEntry?.content ?? '';
      const scheduleResponse = () => this.support.withChatMutationLock(input.chatId, async () => {
        if (!initialChat) {
          const observed = await this.deps.ledger.observe(ledgerInput);
          if (observed) {
            this.support.throwOnConflict(
              observed,
              'clientRequestId was reused with different payload',
            );
            return this.#duplicateQueueResponse(observed.record);
          }
          throw new QueueEntrySteerError(
            'SESSION_NOT_FOUND',
            'Session not found',
            404,
            'not-sent',
          );
        }

        await this.support.assertCurrentTranscriptView(input.chatId, input.transcriptViewId);

        let ledger: LedgerAcceptResult;
        try {
          ledger = await this.deps.ledger.accept(ledgerInput);
        } catch (error) {
          if (error instanceof SteerIdentityCapacityError) {
            throw new QueueEntrySteerError(
              'STEER_CAPACITY_EXHAUSTED',
              STEER_CAPACITY_EXHAUSTED_MESSAGE,
              503,
              'not-sent',
              await this.deps.queue.readChatExecutionControl(input.chatId),
            );
          }
          throw error;
        }
        this.support.throwOnConflict(
          ledger,
          'clientRequestId was reused with different payload',
        );
        outcomeTurnId = ledger.record.turnId;
        if (ledger.kind === 'duplicate') return this.#duplicateQueueResponse(ledger.record);
        outcomeTurnId = target?.identity.turnId;

        const command = {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId,
          entryId,
        };
        if (!this.deps.chats.getChat(input.chatId)) {
          const error = new QueueEntrySteerError(
            'SESSION_NOT_FOUND',
            'Session not found',
            404,
            'not-sent',
          );
          await this.#settleQueueFailure(command, error, 'not-sent');
          throw error;
        }
        if (!observedEntry) {
          const control = await this.deps.queue.readChatExecutionControl(input.chatId);
          const error = new QueueEntrySteerError(
            queueObservationErrorCode(control, entryId),
            'This queued message is no longer available',
            queueObservationErrorCode(control, entryId) === 'QUEUE_ENTRY_NOT_FOUND' ? 404 : 409,
            'not-sent',
            control,
          );
          await this.#settleQueueFailure(command, error, 'not-sent');
          throw error;
        }
        if (!target) {
          const control = await this.deps.queue.readChatExecutionControl(input.chatId);
          const error = new QueueEntrySteerError(
            'STEER_TURN_UNAVAILABLE',
            'There is no active turn to steer',
            409,
            'not-sent',
            control,
          );
          await this.#settleQueueFailure(command, error, 'not-sent');
          throw error;
        }

        const outcome = await this.deps.queue.deliverAcceptedQueueEntrySteer({
          command,
          content: observedEntry.content,
          providerContent,
          clientMessageId,
          transcriptViewId: input.transcriptViewId,
          target,
          expectedRevision: input.expectedRevision,
          expectedReorderRevision: input.expectedReorderRevision,
          settlement: this.support.settlement,
        });
        return {
          ...commandResultFromRecord(ledger.record),
          commandType: 'steer' as const,
          chatId: input.chatId,
          turnId: outcome.turnId,
          serverInstanceId: outcome.control.serverInstanceId,
          control: toClientChatExecutionControlState(outcome.control),
        };
      });
      const scheduled = await this.#preparationLocks.runExclusive(`chat:${input.chatId}`, async () => {
        if (observedEntry) {
          providerContent = await this.#resolveProviderContent({
            chatId: input.chatId,
            clientRequestId,
            content: observedEntry.content,
            projectPath: initialChat?.projectPath,
          });
        }
        return { response: scheduleResponse() };
      });
      const response = await scheduled.response;
      logSteerOutcome(logger, {
        chatId: input.chatId,
        clientRequestId,
        integrationId,
        turnId: response.turnId,
        source: 'queue-entry',
        entryId,
      }, { kind: 'accepted', status: response.status });
      return response;
    } catch (error) {
      logSteerOutcome(logger, {
        chatId: input.chatId,
        clientRequestId,
        integrationId,
        turnId: outcomeTurnId,
        source: 'queue-entry',
        entryId,
      }, { kind: 'failed', error });
      throw error;
    }
  }

  async #resolveProviderContent(input: {
    chatId: string;
    clientRequestId: string;
    content: string;
    projectPath?: string;
  }): Promise<string> {
    if (!input.projectPath) return input.content;
    if (
      this.#fileContextResolutions.has(input.chatId)
      || this.#fileContextResolutions.size >= STEER_FILE_CONTEXT_IN_FLIGHT_LIMIT
    ) {
      return input.content;
    }

    const resolution = this.deps.fileMentions.resolve(input.content, input.projectPath);
    this.#fileContextResolutions.set(input.chatId, resolution);
    const clearResolution = () => {
      if (this.#fileContextResolutions.get(input.chatId) === resolution) {
        this.#fileContextResolutions.delete(input.chatId);
      }
    };
    void resolution.then(clearResolution, clearResolution);

    try {
      return await withPromiseTimeout(
        resolution,
        STEER_FILE_CONTEXT_TIMEOUT_MS,
        'Steering file-context preparation',
      );
    } catch (error) {
      if (!(error instanceof PromiseTimeoutError)) throw error;
      logger.warn('steer file context timed out', {
        chatId: input.chatId,
        clientRequestId: input.clientRequestId,
      });
      return input.content;
    }
  }

  async #duplicateResponse(record: CommandLedgerRecord): Promise<SteerCommandResponse> {
    if (record.status === 'finished' && record.turnId) {
      return {
        ...commandResultFromRecord(record, 'duplicate'),
        commandType: 'steer',
        chatId: record.chatId,
        turnId: record.turnId,
      };
    }
    if (record.status === 'failed' || record.status === 'rejected') {
      throw recordedSteerError(record);
    }

    const error = new SteerDeliveryError(
      new Error('The previous steering attempt has no recorded terminal outcome'),
      'unknown',
    );
    this.deps.pendingInputs.markUnconfirmed(record.chatId, record.clientRequestId);
    await this.support.settlement.settleSteerFailure({
      key: record.key,
      chatId: record.chatId,
      clientRequestId: record.clientRequestId,
    }, error);
    throw error;
  }

  async #duplicateQueueResponse(
    record: CommandLedgerRecord,
  ): Promise<QueueEntrySteerCommandResponse> {
    const chatExists = Boolean(this.deps.chats.getChat(record.chatId));
    const currentControl = await this.deps.queue.readChatExecutionControl(record.chatId);
    const control = chatExists ? currentControl : undefined;
    if (record.status === 'finished' && record.turnId) {
      return {
        ...commandResultFromRecord(record, 'duplicate'),
        commandType: 'steer',
        chatId: record.chatId,
        turnId: record.turnId,
        serverInstanceId: currentControl.serverInstanceId,
        ...(control ? { control: toClientChatExecutionControlState(control) } : {}),
      };
    }
    if (record.status === 'failed' || record.status === 'rejected') {
      const code = queueSteerErrorCode(record.errorCode);
      throw new QueueEntrySteerError(
        code,
        record.error ?? 'The previous queued steering attempt did not complete',
        queueSteerErrorStatus(code),
        record.deliveryOutcome ?? (code === 'STEER_OUTCOME_UNKNOWN' ? 'unknown' : 'not-sent'),
        control,
      );
    }

    this.deps.pendingInputs.markUnconfirmed(record.chatId, record.clientRequestId);
    let recovered = control;
    let recoveryFailure: unknown;
    if (chatExists && record.entryId) {
      try {
        recovered = await this.deps.queue.recoverQueueEntrySteer(record.chatId, record.entryId);
      } catch (error) {
        recoveryFailure = error;
        logger.error('queued steer stale-record recovery failed', {
          chatId: record.chatId,
          entryId: record.entryId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const error = new QueueEntrySteerError(
      'STEER_OUTCOME_UNKNOWN',
      'The previous steering attempt has no recorded terminal outcome',
      500,
      'unknown',
      recovered,
      recoveryFailure === undefined ? undefined : { cause: recoveryFailure },
    );
    await this.#settleQueueFailure({
      key: record.key,
      chatId: record.chatId,
      clientRequestId: record.clientRequestId,
      ...(record.entryId ? { entryId: record.entryId } : {}),
    }, error, 'unknown');
    throw error;
  }

  async #settleQueueFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryOutcome: SteerDeliveryOutcome,
  ): Promise<void> {
    try {
      await this.support.settlement.settleSteerFailure(command, error, deliveryOutcome);
    } catch (settlementError) {
      logger.error('queued steer failure settlement failed', {
        chatId: command.chatId,
        entryId: command.entryId,
        error: settlementError instanceof Error ? settlementError.message : String(settlementError),
      });
    }
  }
}

interface SteerLogContext {
  chatId: string;
  clientRequestId: string;
  integrationId?: string;
  turnId?: string;
  source?: 'inline' | 'queue-entry';
  entryId?: string;
}

type SteerLogOutcome =
  | { kind: 'accepted'; status: SteerCommandResponse['status'] }
  | { kind: 'failed'; error: unknown };

export function logSteerOutcome(
  outcomeLogger: Logger,
  context: SteerLogContext,
  outcome: SteerLogOutcome,
): void {
  const details = {
    chatId: context.chatId,
    clientRequestId: context.clientRequestId,
    ...(context.integrationId ? { integrationId: context.integrationId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    source: context.source ?? 'inline',
    ...(context.entryId ? { entryId: context.entryId } : {}),
  };
  if (outcome.kind === 'accepted') {
    outcomeLogger.info('steer accepted', { ...details, status: outcome.status });
    return;
  }

  const errorCode = steerOutcomeErrorCode(outcome.error);
  const failureDetails = {
    ...details,
    errorCode,
    ...(outcome.error instanceof SteerDeliveryError
      ? { sendAttempted: outcome.error.outcome === 'unknown' }
      : {}),
    ...(outcome.error instanceof QueueEntrySteerError
      ? { deliveryOutcome: outcome.error.deliveryOutcome }
      : {}),
  };
  if (
    errorCode === 'STEER_OUTCOME_UNKNOWN'
    || errorCode === 'QUEUE_STEER_FINALIZATION_FAILED'
    || errorCode === 'QUEUE_STEER_RECOVERY_FAILED'
    || errorCode === 'INTERNAL_ERROR'
  ) {
    outcomeLogger.error('steer failed', failureDetails);
  } else {
    outcomeLogger.warn('steer rejected', failureDetails);
  }
}

function steerOutcomeErrorCode(error: unknown): CommandErrorCode {
  if (error instanceof CommandValidationError) return error.code;
  if (error instanceof DomainError) return queueSteerErrorCode(error.code);
  return 'INTERNAL_ERROR';
}

function recordedSteerError(record: CommandLedgerRecord): CommandValidationError {
  const code = steerErrorCode(record.errorCode);
  return new CommandValidationError(
    code,
    record.error ?? 'The previous steering attempt did not complete',
    steerErrorStatus(code),
    false,
  );
}

function steerErrorCode(value: string | undefined): CommandErrorCode {
  switch (value) {
    case 'VALIDATION_FAILED':
    case 'SESSION_NOT_FOUND':
    case 'IDEMPOTENCY_CONFLICT':
    case 'OPERATION_UNSUPPORTED':
    case 'SERVER_SHUTTING_DOWN':
    case 'STEER_NOT_DELIVERED':
    case 'STEER_OUTCOME_UNKNOWN':
    case 'STEER_PROVIDER_REJECTED':
    case 'STEER_TURN_UNAVAILABLE':
    case 'STEER_TURN_CHANGED':
    case 'STEER_TURN_NOT_STEERABLE':
    case 'STEER_CAPACITY_EXHAUSTED':
      return value;
    default:
      return 'INTERNAL_ERROR';
  }
}

function steerErrorStatus(code: CommandErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED': return 400;
    case 'SESSION_NOT_FOUND': return 404;
    case 'IDEMPOTENCY_CONFLICT':
    case 'STEER_PROVIDER_REJECTED':
    case 'STEER_TURN_UNAVAILABLE':
    case 'STEER_TURN_CHANGED':
    case 'STEER_TURN_NOT_STEERABLE': return 409;
    case 'OPERATION_UNSUPPORTED': return 422;
    case 'SERVER_SHUTTING_DOWN': return 503;
    case 'STEER_CAPACITY_EXHAUSTED': return 503;
    default: return 500;
  }
}

function queueObservationErrorCode(
  control: StoredChatExecutionControlState,
  entryId: string,
): 'QUEUE_ENTRY_NOT_FOUND' | 'QUEUE_ENTRY_ALREADY_SENT' | 'QUEUE_ENTRY_IN_FLIGHT' {
  const entry = control.entries.find((candidate) => candidate.id === entryId);
  if (entry?.status === 'sending' || control.recentlyDispatched.some((item) => item.entryId === entryId)) {
    return 'QUEUE_ENTRY_ALREADY_SENT';
  }
  if (entry?.status === 'steering') return 'QUEUE_ENTRY_IN_FLIGHT';
  return 'QUEUE_ENTRY_NOT_FOUND';
}

function queueSteerErrorCode(value: string | undefined): CommandErrorCode {
  switch (value) {
    case 'QUEUE_ENTRY_NOT_FOUND':
    case 'QUEUE_ENTRY_ALREADY_SENT':
    case 'QUEUE_ENTRY_IN_FLIGHT':
    case 'QUEUE_ENTRY_REVISION_CONFLICT':
    case 'QUEUE_ENTRY_REORDER_CONFLICT':
    case 'QUEUE_STEER_FINALIZATION_FAILED':
    case 'QUEUE_STEER_RECOVERY_FAILED':
      return value;
    default:
      return steerErrorCode(value);
  }
}

function queueSteerErrorStatus(code: CommandErrorCode): number {
  switch (code) {
    case 'QUEUE_ENTRY_NOT_FOUND': return 404;
    case 'QUEUE_ENTRY_ALREADY_SENT':
    case 'QUEUE_ENTRY_IN_FLIGHT':
    case 'QUEUE_ENTRY_REVISION_CONFLICT':
    case 'QUEUE_ENTRY_REORDER_CONFLICT': return 409;
    case 'QUEUE_STEER_FINALIZATION_FAILED':
    case 'QUEUE_STEER_RECOVERY_FAILED': return 500;
    default: return steerErrorStatus(code);
  }
}
