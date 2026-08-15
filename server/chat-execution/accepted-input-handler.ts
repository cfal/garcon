import crypto from 'crypto';
import type { CommandErrorCode } from '../../common/chat-command-contracts.ts';
import type {
  AgentExecutionAdmission,
  AgentSteerOptions,
  RunAgentTurnOptions,
} from '../agents/session-types.ts';
import {
  GoalControlDeliveryError,
  DomainError,
  QueueEntrySteerError,
  QUEUE_STEER_FINALIZATION_FAILED_MESSAGE,
  QUEUE_STEER_RECOVERY_FAILED_MESSAGE,
  STEER_NOT_DELIVERED_MESSAGE,
  STEER_OUTCOME_UNKNOWN_MESSAGE,
  SteerDeliveryError,
} from '../lib/domain-error.ts';
import { createLogger } from '../lib/log.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import type {
  AcceptedGoalControl,
  AcceptedGoalControlOutcome,
  AcceptedDirectInput,
  AcceptedDirectOperation,
  AcceptedQueueCreate,
  AcceptedQueueDelete,
  AcceptedQueueMove,
  AcceptedQueueReplace,
  AcceptedSteerInput,
  AcceptedSteerOutcome,
  AcceptedQueueEntrySteer,
  AcceptedQueueEntrySteerOutcome,
  CapturedSteerTarget,
  DirectTurnReservation,
  UserInputAdmissionOptions,
  QueueCommandMutationResult,
} from './types.ts';
import type { StoredChatExecutionControlState } from './control-state.ts';
import { DuplicateGoalControlInputError } from './goal-control-delivery.ts';

const logger = createLogger('accepted-input');

// Exposes coordinator-owned operations that accepted-input handling drives.
export interface AcceptedInputCoordinator {
  requestDrain(chatId: string, context: string): void;
  reserveDirect(chatId: string, turn: TurnIdentity): DirectTurnReservation;
  checkpoint(reservation: DirectTurnReservation): void;
  admitInput(
    chatId: string,
    content: string,
    options: UserInputAdmissionOptions,
  ): Promise<boolean>;
  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void;
  releaseDirect(reservation: DirectTurnReservation): Promise<void>;
  runDirect(
    reservation: DirectTurnReservation,
    content: string,
    options: RunAgentTurnOptions,
    dispatch?: (admission: AgentExecutionAdmission) => Promise<void>,
    beforeFailureRelease?: (error: unknown) => Promise<void>,
  ): Promise<void>;
  trackDispatch(task: Promise<void>): void;
  deliverGoalControl(
    chatId: string,
    content: string,
    options: RunAgentTurnOptions,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean>;
  steer(
    chatId: string,
    content: string,
    providerContent: string,
    options: AgentSteerOptions,
    target: CapturedSteerTarget,
    afterPendingRegistered: (turnId: string) => Promise<void>,
  ): Promise<AcceptedSteerOutcome>;
}

export interface AcceptedInputDeps {
  controls: ChatExecutionControlOperations;
  coordinator: AcceptedInputCoordinator;
}

export class AcceptedInputHandler {
  readonly #controls: ChatExecutionControlOperations;
  readonly #coordinator: AcceptedInputCoordinator;

  constructor(deps: AcceptedInputDeps) {
    this.#controls = deps.controls;
    this.#coordinator = deps.coordinator;
  }

  async enqueue(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult> {
    try {
      const result = await this.#controls.create(
        input.command.chatId,
        input.content,
        { key: input.command.key, entryId: input.command.entryId },
        {
          clientMessageId: input.clientMessageId,
          transcriptViewId: input.transcriptViewId,
          ...(input.excludedResendOrdinals?.length
            ? { excludedResendOrdinals: [...input.excludedResendOrdinals] }
            : {}),
        },
      );
      await input.settlement.settleQueueMutation(input.command, result.entryId);
      this.#coordinator.requestDrain(input.command.chatId, 'accepted enqueue');
      return result;
    } catch (error) {
      await input.settlement.settleQueueMutationFailure(input.command, error);
      throw error;
    }
  }

  async replace(input: AcceptedQueueReplace): Promise<QueueCommandMutationResult> {
    try {
      const result = await this.#controls.replace(
        input.command.chatId,
        input.command.entryId,
        input.content,
        input.expectedRevision,
        { key: input.command.key, entryId: input.command.entryId },
      );
      await input.settlement.settleQueueMutation(input.command, result.entryId);
      return result;
    } catch (error) {
      await input.settlement.settleQueueMutationFailure(input.command, error);
      throw error;
    }
  }

  async delete(input: AcceptedQueueDelete): Promise<QueueCommandMutationResult> {
    try {
      const result = await this.#controls.delete(
        input.command.chatId,
        input.command.entryId,
        { key: input.command.key, entryId: input.command.entryId },
      );
      await input.settlement.settleQueueMutation(input.command, result.entryId);
      return result;
    } catch (error) {
      await input.settlement.settleQueueMutationFailure(input.command, error);
      throw error;
    }
  }

  async move(input: AcceptedQueueMove): Promise<QueueCommandMutationResult> {
    try {
      const result = await this.#controls.move(
        input.command.chatId,
        {
          entryId: input.command.entryId,
          targetEntryId: input.targetEntryId,
          placement: input.placement,
          expectedReorderRevision: input.expectedReorderRevision,
          expectedSourceRevision: input.expectedSourceRevision,
          expectedTargetRevision: input.expectedTargetRevision,
        },
        { key: input.command.key, entryId: input.command.entryId },
      );
      await input.settlement.settleQueueMutation(input.command, result.entryId);
      return result;
    } catch (error) {
      await input.settlement.settleQueueMutationFailure(input.command, error);
      throw error;
    }
  }

  async schedule(input: AcceptedDirectInput): Promise<void> {
    const reservation = await this.#prepareDirect(input);
    if (!reservation) return;
    this.#coordinator.trackDispatch(
      this.#coordinator.runDirect(reservation, input.content, input.options, input.dispatch).catch((error) => {
        logger.error('commands: run failed:', error instanceof Error ? error.message : String(error));
      }),
    );
  }

  async runInitial(input: AcceptedDirectInput): Promise<void> {
    const reservation = await this.#prepareDirect(input);
    if (!reservation) return;
    await this.#coordinator.runDirect(
      reservation,
      input.content,
      input.options,
      input.dispatch,
      (error) => this.#settleInitialFailure(input, error),
    );
  }

  async scheduleOperation(input: AcceptedDirectOperation): Promise<void> {
    const options = withTurnIdentifiers(input.command);
    let reservation: DirectTurnReservation;
    try {
      reservation = this.#coordinator.reserveDirect(input.command.chatId, options);
    } catch (error) {
      await this.#recordAdmissionFailure(input, error);
      throw error;
    }
    try {
      this.#checkpoint(reservation);
      const control = await this.#checkpointAfter(reservation, this.#controls.read(input.command.chatId));
      assertDirectControlAvailable(control);
      await this.#checkpointAfter(
        reservation,
        input.settlement.markScheduled(input.command, options.turnId!),
      );
    } catch (error) {
      let failure = error;
      try {
        await this.#coordinator.releaseDirect(reservation);
      } catch (releaseError) {
        failure = aggregateFailure(
          failure,
          releaseError,
          `Failed to release direct operation for ${input.command.chatId}`,
        );
      }
      try {
        await this.#recordAdmissionFailure(input, failure);
      } catch (settlementError) {
        failure = aggregateFailure(
          failure,
          settlementError,
          `Failed to settle direct operation admission for ${input.command.chatId}`,
        );
      }
      throw failure;
    }
    this.#coordinator.trackDispatch(
      this.#coordinator.runDirect(reservation, '', options, input.dispatch).catch(async (error) => {
        logger.error('compact: failed to compact chat:', error instanceof Error ? error.message : String(error));
        try {
          await input.settlement.settleOperationFailure(input.command, error);
        } catch (settlementError) {
          logger.error(
            'compact: failed to record command failure:',
            settlementError instanceof Error ? settlementError.message : String(settlementError),
          );
        }
      }),
    );
  }

  async deliverGoalControl(input: AcceptedGoalControl): Promise<AcceptedGoalControlOutcome> {
    const turnId = input.command.turnId;
    if (!turnId) {
      throw new DomainError('INTERNAL_ERROR', 'Accepted goal control is missing a turn identifier', 500);
    }
    const delivery = {
      clientRequestId: input.command.clientRequestId,
      clientMessageId: input.clientMessageId,
      transcriptViewId: input.transcriptViewId,
      turnId,
    };
    let deliveryAccepted = false;
    try {
      const delivered = await this.#coordinator.deliverGoalControl(
        input.command.chatId,
        input.content,
        delivery,
        () => input.settlement.markScheduled(input.command, turnId),
      );
      if (delivered) {
        deliveryAccepted = true;
        await input.settlement.settleGoalControl(input.command);
        return { delivery: 'active', control: await this.#controls.read(input.command.chatId) };
      }
    } catch (error) {
      if (error instanceof DuplicateGoalControlInputError) {
        await input.settlement.settleDuplicateInput(input.command);
        return {
          delivery: 'active',
          control: await this.#controls.read(input.command.chatId),
        };
      }
      deliveryAccepted ||= error instanceof GoalControlDeliveryError && error.deliveryAccepted;
      await input.settlement.settleGoalControlFailure(input.command, error, deliveryAccepted);
      throw error;
    }
    const queued = await this.enqueue({
      command: input.command,
      content: input.content,
      clientMessageId: input.clientMessageId,
      transcriptViewId: input.transcriptViewId,
      settlement: input.settlement,
    });
    return { delivery: 'queued', entryId: queued.entryId, control: queued.control };
  }

  async steer(input: AcceptedSteerInput): Promise<AcceptedSteerOutcome> {
    try {
      const outcome = await this.#coordinator.steer(
        input.command.chatId,
        input.content,
        input.providerContent,
        {
          clientRequestId: input.command.clientRequestId,
          clientMessageId: input.clientMessageId,
          transcriptViewId: input.transcriptViewId,
        },
        input.target,
        (turnId) => input.settlement.markScheduled(input.command, turnId),
      );
      if (outcome.duplicate) {
        await input.settlement.settleDuplicateInput(input.command);
      } else {
        await input.settlement.settleSteerSuccess(input.command, outcome.turnId);
      }
      return outcome;
    } catch (error) {
      await input.settlement.settleSteerFailure(input.command, error);
      throw error;
    }
  }

  async steerQueueEntry(input: AcceptedQueueEntrySteer): Promise<AcceptedQueueEntrySteerOutcome> {
    let reservation: Awaited<ReturnType<ChatExecutionControlOperations['reserveSteer']>>;
    try {
      reservation = await this.#controls.reserveSteer(input.command.chatId, {
        entryId: input.command.entryId,
        expectedRevision: input.expectedRevision,
        expectedReorderRevision: input.expectedReorderRevision,
      });
    } catch (error) {
      const wrapped = this.#queueSteerError(error, 'not-sent');
      await this.#settleQueueSteerFailure(input, wrapped, 'not-sent');
      throw wrapped;
    }

    let outcome: AcceptedSteerOutcome;
    try {
      outcome = await this.#coordinator.steer(
        input.command.chatId,
        reservation.entry.content,
        input.providerContent,
        {
          clientRequestId: input.command.clientRequestId,
          clientMessageId: input.clientMessageId,
          transcriptViewId: input.transcriptViewId,
        },
        input.target,
        (turnId) => input.settlement.markScheduled(input.command, turnId),
      );
    } catch (error) {
      const deliveryOutcome = error instanceof SteerDeliveryError ? error.outcome : 'not-sent';
      if (deliveryOutcome === 'unknown') {
        throw await this.#finishUnknownQueueSteer(input, error);
      }
      throw await this.#releaseRejectedQueueSteer(input, error);
    }

    let control: StoredChatExecutionControlState;
    try {
      control = await this.#controls.consumeSteer(input.command.chatId, input.command.entryId);
    } catch (error) {
      throw await this.#failAcceptedQueueFinalization(input, error);
    }
    this.#coordinator.requestDrain(input.command.chatId, 'queued steer consumed');
    try {
      if (outcome.duplicate) {
        await input.settlement.settleDuplicateInput(input.command);
      } else {
        await input.settlement.settleSteerSuccess(input.command, outcome.turnId);
      }
    } catch (error) {
      logger.error('queued steer ledger settlement failed', {
        chatId: input.command.chatId,
        entryId: input.command.entryId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ...outcome, control };
  }

  async recoverQueueEntrySteer(
    chatId: string,
    entryId: string,
  ): Promise<StoredChatExecutionControlState> {
    const control = await this.#controls.read(chatId);
    const source = control.entries.find((entry) => entry.id === entryId);
    if (source?.status !== 'queued' && source?.status !== 'steering') return control;
    return this.#controls.requeueAndPause(chatId, entryId, 'completion-uncertain');
  }

  async #finishUnknownQueueSteer(
    input: AcceptedQueueEntrySteer,
    error: unknown,
  ): Promise<QueueEntrySteerError> {
    try {
      const control = await this.#controls.consumeSteer(input.command.chatId, input.command.entryId);
      this.#coordinator.requestDrain(input.command.chatId, 'unconfirmed queued steer consumed');
      const wrapped = this.#queueSteerError(error, 'unknown', control);
      await this.#settleQueueSteerFailure(input, wrapped, 'unknown');
      return wrapped;
    } catch (consumeError) {
      if (this.#isMissingSession(consumeError)) {
        const wrapped = this.#queueSteerError(consumeError, 'unknown');
        await this.#settleQueueSteerFailure(input, wrapped, 'unknown');
        return wrapped;
      }
      let control: StoredChatExecutionControlState | undefined;
      try {
        control = await this.#controls.requeueAndPause(
          input.command.chatId,
          input.command.entryId,
          'completion-uncertain',
        );
      } catch (pauseError) {
        logger.error('unconfirmed queued steer recovery failed', {
          chatId: input.command.chatId,
          entryId: input.command.entryId,
          error: pauseError instanceof Error ? pauseError.message : String(pauseError),
        });
      }
      const wrapped = this.#queueSteerError(error, 'unknown', control);
      await this.#settleQueueSteerFailure(input, wrapped, 'unknown');
      return wrapped;
    }
  }

  async #releaseRejectedQueueSteer(
    input: AcceptedQueueEntrySteer,
    error: unknown,
  ): Promise<QueueEntrySteerError> {
    try {
      const control = await this.#controls.releaseSteer(input.command.chatId, input.command.entryId);
      this.#coordinator.requestDrain(input.command.chatId, 'rejected queued steer released');
      const wrapped = this.#queueSteerError(error, 'not-sent', control);
      await this.#settleQueueSteerFailure(input, wrapped, 'not-sent');
      return wrapped;
    } catch (releaseError) {
      if (this.#isMissingSession(releaseError)) {
        const wrapped = this.#queueSteerError(releaseError, 'not-sent');
        await this.#settleQueueSteerFailure(input, wrapped, 'not-sent');
        return wrapped;
      }
      try {
        const control = await this.#controls.requeueAndPause(
          input.command.chatId,
          input.command.entryId,
          'completion-uncertain',
        );
        const wrapped = this.#queueSteerError(error, 'not-sent', control);
        await this.#settleQueueSteerFailure(input, wrapped, 'not-sent');
        return wrapped;
      } catch (recoveryError) {
        const wrapped = new QueueEntrySteerError(
          'QUEUE_STEER_RECOVERY_FAILED',
          QUEUE_STEER_RECOVERY_FAILED_MESSAGE,
          500,
          'not-sent',
          undefined,
          { cause: new AggregateError([releaseError, recoveryError]) },
        );
        await this.#settleQueueSteerFailure(input, wrapped, 'not-sent');
        return wrapped;
      }
    }
  }

  async #failAcceptedQueueFinalization(
    input: AcceptedQueueEntrySteer,
    error: unknown,
  ): Promise<QueueEntrySteerError> {
    if (this.#isMissingSession(error)) {
      const wrapped = this.#queueSteerError(error, 'accepted');
      await this.#settleQueueSteerFailure(input, wrapped, 'accepted');
      return wrapped;
    }
    let control: StoredChatExecutionControlState | undefined;
    try {
      control = await this.#controls.requeueAndPause(
        input.command.chatId,
        input.command.entryId,
        'completion-uncertain',
      );
    } catch (pauseError) {
      logger.error('accepted queued steer recovery failed', {
        chatId: input.command.chatId,
        entryId: input.command.entryId,
        error: pauseError instanceof Error ? pauseError.message : String(pauseError),
      });
    }
    const wrapped = new QueueEntrySteerError(
      'QUEUE_STEER_FINALIZATION_FAILED',
      QUEUE_STEER_FINALIZATION_FAILED_MESSAGE,
      500,
      'accepted',
      control,
      { cause: error },
    );
    await this.#settleQueueSteerFailure(input, wrapped, 'accepted');
    return wrapped;
  }

  async #settleQueueSteerFailure(
    input: AcceptedQueueEntrySteer,
    error: unknown,
    deliveryOutcome: 'not-sent' | 'unknown' | 'accepted',
  ): Promise<void> {
    try {
      await input.settlement.settleSteerFailure(input.command, error, deliveryOutcome);
    } catch (settlementError) {
      logger.error('queued steer failure settlement failed', {
        chatId: input.command.chatId,
        entryId: input.command.entryId,
        error: settlementError instanceof Error ? settlementError.message : String(settlementError),
      });
    }
  }

  #queueSteerError(
    error: unknown,
    deliveryOutcome: 'not-sent' | 'unknown' | 'accepted',
    control?: StoredChatExecutionControlState,
  ): QueueEntrySteerError {
    if (error instanceof QueueEntrySteerError) return error;
    if (error instanceof DomainError) {
      const errorControl = 'control' in error
        ? (error as DomainError & { control?: StoredChatExecutionControlState }).control
        : undefined;
      return new QueueEntrySteerError(
        queueSteerDomainErrorCode(error.code),
        error.message,
        error.status,
        deliveryOutcome,
        control ?? errorControl,
        { cause: error },
      );
    }
    return new QueueEntrySteerError(
      deliveryOutcome === 'unknown' ? 'STEER_OUTCOME_UNKNOWN' : 'STEER_NOT_DELIVERED',
      deliveryOutcome === 'unknown' ? STEER_OUTCOME_UNKNOWN_MESSAGE : STEER_NOT_DELIVERED_MESSAGE,
      500,
      deliveryOutcome,
      control,
      { cause: error },
    );
  }

  #isMissingSession(error: unknown): boolean {
    return error instanceof DomainError && error.code === 'SESSION_NOT_FOUND';
  }

  async #prepareDirect(input: AcceptedDirectInput): Promise<DirectTurnReservation | null> {
    let reservation: DirectTurnReservation;
    try {
      reservation = this.#coordinator.reserveDirect(input.command.chatId, input.options);
    } catch (error) {
      await this.#recordAdmissionFailure(input, error);
      throw error;
    }
    try {
      this.#checkpoint(reservation);
      const control = await this.#checkpointAfter(reservation, this.#controls.read(input.command.chatId));
      assertDirectControlAvailable(control);
      await this.#checkpointAfter(reservation, Promise.resolve(input.preparation?.prepare({
          signal: reservation.executionAdmission.signal,
          assertAdmissionActive: () => this.#checkpoint(reservation),
        })));
      const inserted = await this.#checkpointAfter(
        reservation,
        this.#coordinator.admitInput(input.command.chatId, input.content, input.options),
      );
      if (inserted === false) {
        await input.settlement.settleDuplicateInput(input.command);
        await this.#coordinator.releaseDirect(reservation);
        return null;
      }
      await this.#checkpointAfter(
        reservation,
        input.settlement.markScheduled(input.command, input.options.turnId!),
      );
      return reservation;
    } catch (error) {
      let failure: unknown = error;
      let retryable = true;
      let preserveForkPreparation = false;
      if (input.preparation) {
        try {
          await input.preparation.compensate();
        } catch (compensationError) {
          retryable = false;
          preserveForkPreparation = true;
          failure = aggregateFailure(
            failure,
            compensationError,
            `Failed to prepare and roll back ${input.preparation.operation} for ${input.command.chatId}`,
          );
        }
      }
      try {
        this.#coordinator.discardPreparedInput(
          input.command.chatId,
          input.options.clientMessageId,
        );
        await this.#coordinator.releaseDirect(reservation);
      } catch (releaseError) {
        failure = aggregateFailure(
          failure,
          releaseError,
          `Failed to release direct input for ${input.command.chatId}`,
        );
      }
      try {
        await input.settlement.markPreScheduleFailure(input.command, {
          error: failure,
          retryable,
          preserveForkPreparation,
        });
      } catch (settlementError) {
        failure = aggregateFailure(
          failure,
          settlementError,
          `Failed to settle direct input admission for ${input.command.chatId}`,
        );
      }
      throw failure;
    }
  }

  async #settleInitialFailure(input: AcceptedDirectInput, error: unknown): Promise<void> {
    let failure = error;
    if (input.preparation) {
      try {
        await input.preparation.compensate();
      } catch (compensationError) {
        failure = aggregateFailure(
          failure,
          compensationError,
          `Failed to roll back ${input.preparation.operation} for ${input.command.chatId}`,
        );
      }
    }
    try {
      await input.settlement.settleOperationFailure(input.command, failure);
    } catch (settlementError) {
      failure = aggregateFailure(
        failure,
        settlementError,
        `Failed to settle initial input for ${input.command.chatId}`,
      );
    }
    if (failure !== error) throw failure;
  }

  #checkpoint(reservation: DirectTurnReservation): void {
    this.#coordinator.checkpoint(reservation);
  }

  // Revalidates after every awaited step that can race an admission abort or clear.
  async #checkpointAfter<T>(reservation: DirectTurnReservation, promise: Promise<T>): Promise<T> {
    const result = await promise;
    this.#coordinator.checkpoint(reservation);
    return result;
  }

  async #recordAdmissionFailure(
    input: AcceptedDirectInput | AcceptedDirectOperation,
    error: unknown,
  ): Promise<void> {
    await input.settlement.markPreScheduleFailure(input.command, {
      error,
      retryable: true,
    });
  }
}

function assertDirectControlAvailable(control: StoredChatExecutionControlState): void {
  if (control.entries.length === 0 && !control.pause) return;
  throw new DomainError('SESSION_BUSY', 'Chat execution is blocked by pending control state', 409, true);
}

function withTurnIdentifiers(command: AcceptedDirectOperation['command']): RunAgentTurnOptions {
  return {
    clientRequestId: command.clientRequestId,
    clientMessageId: crypto.randomUUID(),
    turnId: command.turnId ?? crypto.randomUUID(),
  };
}

function aggregateFailure(primary: unknown, secondary: unknown, message: string): AggregateError {
  return new AggregateError([primary, secondary], message);
}

function queueSteerDomainErrorCode(code: DomainError['code']): CommandErrorCode {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'SESSION_NOT_FOUND':
    case 'QUEUE_ENTRY_NOT_FOUND':
    case 'QUEUE_ENTRY_ALREADY_SENT':
    case 'QUEUE_ENTRY_IN_FLIGHT':
    case 'QUEUE_ENTRY_REVISION_CONFLICT':
    case 'QUEUE_ENTRY_REORDER_CONFLICT':
    case 'STEER_NOT_DELIVERED':
    case 'STEER_OUTCOME_UNKNOWN':
    case 'STEER_PROVIDER_REJECTED':
    case 'STEER_TURN_UNAVAILABLE':
    case 'STEER_TURN_CHANGED':
    case 'STEER_TURN_NOT_STEERABLE':
    case 'STEER_CAPACITY_EXHAUSTED':
    case 'QUEUE_STEER_FINALIZATION_FAILED':
    case 'QUEUE_STEER_RECOVERY_FAILED':
    case 'OPERATION_UNSUPPORTED':
    case 'SERVER_SHUTTING_DOWN':
      return code;
    default:
      return 'INTERNAL_ERROR';
  }
}
