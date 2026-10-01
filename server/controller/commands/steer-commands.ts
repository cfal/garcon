import crypto from 'node:crypto';
import type {
  CommandAcceptedResponse,
  CommandErrorCode,
  QueuedQueueEntrySteerCommandResponse,
  QueuedSteerCommandResponse,
  QueueEntrySteerCommandRequest,
  QueueEntrySteerCommandResponse,
  SteerDeliveryOutcome,
  SteerCommandRequest,
  SteerCommandResponse,
} from '../../../common/chat-command-contracts.ts';
import {
  DomainError,
  STEER_NOT_DELIVERED_MESSAGE,
  SteerDeliveryError,
  steeringUnsupportedError,
  steerTurnChangedError,
} from '../../common/domain-error.js';
import { QueueEntrySteerError } from '../chat-execution/queue-steer-error.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { AcceptedExecutionCommand, CapturedSteerTarget } from '../chat-execution/types.ts';
import { KeyedPromiseLock } from '../../common/keyed-lock.ts';
import { createLogger, type Logger } from '../../common/log.ts';
import {
  SteerIdentityCapacityError,
  type LedgerAcceptResult,
  type CommandLedgerRecord,
} from './command-ledger.ts';
import {
  CommandSupport,
  CommandValidationError,
  commandResultFromRecord,
} from './command-support.ts';
import { SteerFileContext } from './steer-file-context.ts';

const logger = createLogger('commands:steer');
const STEER_CAPACITY_EXHAUSTED_MESSAGE =
  'Steering is temporarily unavailable because the server has retained its maximum number of steering identities';

export class SteerCommands {
  // Preserves steering admission order without holding the command lock during file reads.
  readonly #preparationLocks = new KeyedPromiseLock();
  readonly #fileContext: SteerFileContext;

  constructor(private readonly support: CommandSupport) {
    this.#fileContext = new SteerFileContext(support.deps.fileMentions);
  }

  private get deps() {
    return this.support.deps;
  }

  async submit(input: SteerCommandRequest): Promise<SteerCommandResponse | QueuedSteerCommandResponse> {
    this.support.assertContent(input.content);
    const clientRequestId = this.support.requireClientRequestId(input.clientRequestId);
    const clientMessageId = this.support.requireClientRequestId(
      input.clientMessageId,
      'clientMessageId',
    );
    const initialChat = this.deps.chats.getChat(input.chatId);
    const integrationId = initialChat?.agentId;
    const observedTarget = initialChat ? await this.#captureBeforeLock(input.chatId) : null;
    const ledgerInput = {
      commandType: 'steer',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        chatId: input.chatId,
        transcriptViewId: input.transcriptViewId,
        content: input.content,
        clientMessageId,
        userMessagePresentation: input.userMessagePresentation ?? null,
        whenTurnUnavailable: input.whenTurnUnavailable ?? 'reject',
      },
    };
    let outcomeTurnId = observedTarget?.identity.turnId;
    const queueWhenUnavailable = input.whenTurnUnavailable === 'queue';

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

        outcomeTurnId = observedTarget?.identity.turnId;
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
        let target: CapturedSteerTarget | null;
        try {
          target = queueWhenUnavailable
            ? await this.#targetUnlessSteersQueued(input.chatId, observedTarget)
            : await this.#currentTarget(input.chatId, observedTarget);
        } catch (error) {
          await this.support.settlement.settleSteerFailure(command, error);
          throw error;
        }
        outcomeTurnId = target?.identity.turnId;
        if (queueWhenUnavailable && !target?.providerTarget) {
          return this.#queueSteer(input, clientMessageId, ledger.record);
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
          userMessagePresentation: input.userMessagePresentation,
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
        const preparation = {
          chatId: input.chatId,
          clientRequestId,
          content: input.content,
          projectPath: initialChat?.projectPath,
          executorId: initialChat?.executorId,
        };
        providerContent = await (queueWhenUnavailable
          ? this.#fileContext.resolveOrTyped(preparation)
          : this.#fileContext.resolve(preparation));
        // Enqueues the command lock before releasing steering preparation order.
        return { response: scheduleResponse() };
      });
      const response = await scheduled.response;
      logSteerOutcome(logger, {
        chatId: input.chatId,
        clientRequestId,
        integrationId,
        turnId: response.turnId,
        ...(response.delivery === 'queued' ? { entryId: response.entryId } : {}),
      }, { kind: response.delivery === 'queued' ? 'queued' : 'accepted', status: response.status });
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
  ): Promise<QueueEntrySteerCommandResponse | QueuedQueueEntrySteerCommandResponse> {
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
    const clientMessageId = observedEntry?.submission?.clientMessageId ?? entryId;
    const observedTarget = initialChat ? await this.#captureBeforeLock(input.chatId) : null;
    // The payload holds only request fields: a retry derives the client message ID from an
    // entry that delivery may have consumed, so including it could turn the retry into a
    // conflict once the record's payload is compacted away.
    const ledgerInput = {
      commandType: 'steer',
      chatId: input.chatId,
      clientRequestId,
      payload: {
        chatId: input.chatId,
        transcriptViewId: input.transcriptViewId,
        source: {
          kind: 'queue-entry',
          entryId,
          expectedRevision: input.expectedRevision,
          expectedReorderRevision: input.expectedReorderRevision,
        },
      },
      entryId,
    };
    let outcomeTurnId = observedTarget?.identity.turnId;

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
        outcomeTurnId = observedTarget?.identity.turnId;

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
        // Steering delivers text only; attachments never change for an entry.
        if (observedEntry.images.length > 0) {
          const error = new QueueEntrySteerError(
            'OPERATION_UNSUPPORTED',
            'Queued messages with attachments cannot steer the active turn',
            409,
            'not-sent',
            await this.deps.queue.readChatExecutionControl(input.chatId),
          );
          await this.#settleQueueFailure(command, error, 'not-sent');
          throw error;
        }
        let target: CapturedSteerTarget | null;
        try {
          target = await this.#queueableTarget(input.chatId, observedTarget);
        } catch (failure) {
          const error = queueSteerCaptureError(
            failure,
            await this.deps.queue.readChatExecutionControl(input.chatId),
          );
          await this.#settleQueueFailure(command, error, 'not-sent');
          throw error;
        }
        outcomeTurnId = target?.identity.turnId;
        // The message waits as a steer while the turn cannot take it, or behind a steer in flight.
        const inFlight = (await this.deps.queue.readChatExecutionControl(input.chatId)).entries
          .some((entry) => entry.status === 'steering');
        if (!target?.providerTarget || inFlight) {
          const control = await this.deps.queue.markAcceptedQueueEntrySteer({
            command,
            expectedRevision: input.expectedRevision,
            expectedReorderRevision: input.expectedReorderRevision,
            settlement: this.support.settlement,
          });
          return queuedQueueEntrySteerResponse(ledger.record, input.chatId, entryId, control);
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
          providerContent = await this.#fileContext.resolveOrTyped({
            chatId: input.chatId,
            clientRequestId,
            content: observedEntry.content,
            projectPath: initialChat?.projectPath,
            executorId: initialChat?.executorId,
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
      }, { kind: response.delivery === 'queued' ? 'queued' : 'accepted', status: response.status });
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

  // Earlier queued steers go first, so a steer waits behind them even for a steerable turn.
  async #targetUnlessSteersQueued(
    chatId: string,
    observed: CapturedSteerTarget | null,
  ): Promise<CapturedSteerTarget | null> {
    const control = await this.deps.queue.readChatExecutionControl(chatId);
    if (!control.entries.some((entry) => entry.kind === 'steer')) {
      return this.#queueableTarget(chatId, observed);
    }
    this.#assertSteerable(chatId);
    return null;
  }

  // A steer that can wait in the queue waits when its target cannot be captured, unless the
  // agent cannot be steered at all.
  async #queueableTarget(
    chatId: string,
    observed: CapturedSteerTarget | null,
  ): Promise<CapturedSteerTarget | null> {
    this.#assertSteerable(chatId);
    try {
      return await this.#currentTarget(chatId, observed);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'OPERATION_UNSUPPORTED') throw error;
      return null;
    }
  }

  // Capture reports an agent that cannot be steered only while a turn runs, so a steer that
  // would wait for one is checked against the agent itself. An agent its executor has not
  // reported yet may still be steerable, so its steer waits like any other, and runs as the
  // next turn if the agent turns out to lack steering.
  #assertSteerable(chatId: string): void {
    const chat = this.deps.chats.getChat(chatId);
    if (chat && this.deps.agents.steeringSupport(chat.agentId, chat.executorId) === 'unsupported') {
      throw steeringUnsupportedError();
    }
  }

  async #queueSteer(
    input: SteerCommandRequest,
    clientMessageId: string,
    record: CommandLedgerRecord,
  ): Promise<QueuedSteerCommandResponse> {
    const result = await this.deps.queue.enqueueAcceptedSteer({
      command: {
        key: record.key,
        chatId: input.chatId,
        clientRequestId: record.clientRequestId,
        entryId: crypto.randomUUID(),
      },
      content: input.content,
      clientMessageId,
      transcriptViewId: input.transcriptViewId,
      settlement: this.support.settlement,
    });
    return queuedSteerResponse(
      record,
      input.chatId,
      result.entryId,
      result.control,
      result.duplicate ? 'duplicate' : 'accepted',
    );
  }

  // Captures before the chat lock, so a steer does not hold the lock for the capture.
  // A failure is left to the capture under the lock to report.
  async #captureBeforeLock(chatId: string): Promise<CapturedSteerTarget | null> {
    try {
      return await this.deps.queue.captureSteerTarget(chatId);
    } catch {
      return null;
    }
  }

  // A steer can wait for the chat lock longer than its turn takes to become steerable,
  // for example behind a new chat's start, so a capture without a provider target is
  // repeated. The steer stays with the turn it saw: a turn that replaced it meanwhile is a
  // changed turn. Capture precedes admission, so a failure means nothing was sent.
  async #currentTarget(
    chatId: string,
    observed: CapturedSteerTarget | null,
  ): Promise<CapturedSteerTarget | null> {
    if (observed?.providerTarget) return observed;
    let current: CapturedSteerTarget | null;
    try {
      current = await this.deps.queue.captureSteerTarget(chatId);
    } catch (error) {
      throw error instanceof DomainError ? error : new SteerDeliveryError(error, 'not-sent');
    }
    if (observed && current && current.identity.turnId !== observed.identity.turnId) {
      throw steerTurnChangedError();
    }
    return current;
  }

  async #duplicateResponse(
    record: CommandLedgerRecord,
  ): Promise<SteerCommandResponse | QueuedSteerCommandResponse> {
    if (record.status === 'finished' && record.turnId) {
      return {
        ...commandResultFromRecord(record, 'duplicate'),
        commandType: 'steer',
        chatId: record.chatId,
        turnId: record.turnId,
      };
    }
    if (record.status === 'finished' && record.entryId) {
      const control = await this.deps.queue.readChatExecutionControl(record.chatId);
      return queuedSteerResponse(record, record.chatId, record.entryId, control, 'duplicate');
    }
    if (record.status === 'failed' || record.status === 'rejected') {
      throw recordedSteerError(record);
    }

    const error = new SteerDeliveryError(
      new Error('The previous steering attempt has no recorded terminal outcome'),
      'unknown',
    );
    await this.support.settlement.settleSteerFailure({
      key: record.key,
      chatId: record.chatId,
      clientRequestId: record.clientRequestId,
    }, error);
    throw error;
  }

  async #duplicateQueueResponse(
    record: CommandLedgerRecord,
  ): Promise<QueueEntrySteerCommandResponse | QueuedQueueEntrySteerCommandResponse> {
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
    // A finished record without a turn kept its message as a steer entry; a duplicate
    // input, the only other way to finish without one, leaves nothing to deliver either.
    if (record.status === 'finished' && record.entryId) {
      return queuedQueueEntrySteerResponse(record, record.chatId, record.entryId, currentControl, 'duplicate');
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
  | { kind: 'accepted' | 'queued'; status: SteerCommandResponse['status'] }
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
  if (outcome.kind !== 'failed') {
    outcomeLogger.info(`steer ${outcome.kind}`, { ...details, status: outcome.status });
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

function queueSteerCaptureError(
  error: unknown,
  control: StoredChatExecutionControlState,
): QueueEntrySteerError {
  if (error instanceof DomainError) {
    const code = queueSteerErrorCode(error.code);
    if (code !== 'INTERNAL_ERROR') {
      return new QueueEntrySteerError(code, error.message, error.status, 'not-sent', control, {
        cause: error,
      });
    }
  }
  return new QueueEntrySteerError(
    'STEER_NOT_DELIVERED',
    STEER_NOT_DELIVERED_MESSAGE,
    500,
    'not-sent',
    control,
    { cause: error },
  );
}

function queuedSteerResponse(
  record: CommandLedgerRecord,
  chatId: string,
  entryId: string,
  control: StoredChatExecutionControlState,
  status: CommandAcceptedResponse['status'] = 'accepted',
): QueuedSteerCommandResponse {
  return {
    ...commandResultFromRecord(record, status),
    commandType: 'steer',
    chatId,
    delivery: 'queued',
    entryId,
    control: toClientChatExecutionControlState(control),
  };
}

function queuedQueueEntrySteerResponse(
  record: CommandLedgerRecord,
  chatId: string,
  entryId: string,
  control: StoredChatExecutionControlState,
  status: CommandAcceptedResponse['status'] = 'accepted',
): QueuedQueueEntrySteerCommandResponse {
  return {
    ...queuedSteerResponse(record, chatId, entryId, control, status),
    serverInstanceId: control.serverInstanceId,
  };
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
    case 'EXECUTOR_UNAVAILABLE':
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
    case 'EXECUTOR_UNAVAILABLE': return 503;
    case 'STEER_CAPACITY_EXHAUSTED': return 503;
    default: return 500;
  }
}

function queueObservationErrorCode(
  control: StoredChatExecutionControlState,
  entryId: string,
): 'QUEUE_ENTRY_NOT_FOUND' | 'QUEUE_ENTRY_ALREADY_SENT' | 'QUEUE_ENTRY_IN_FLIGHT' {
  const entry = control.entries.find((candidate) => candidate.id === entryId);
  if (control.recentlyDispatched.some((item) => item.entryId === entryId)) {
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
