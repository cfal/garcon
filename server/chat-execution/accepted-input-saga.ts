import crypto from 'crypto';
import type { AgentExecutionAdmission, RunAgentTurnOptions } from '../agents/session-types.ts';
import { ActiveInputDeliveryError, DomainError } from '../lib/domain-error.ts';
import { createLogger } from '../lib/log.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import type {
  AcceptedActiveInput,
  AcceptedActiveInputOutcome,
  AcceptedDirectInput,
  AcceptedDirectOperation,
  AcceptedQueueCreate,
  AcceptedQueueDelete,
  AcceptedQueueReplace,
  DirectTurnReservation,
  PendingInputsPort,
  PendingUserInputRegistrationOptions,
  QueueCommandMutationResult,
} from './types.ts';
import type { StoredChatExecutionControlState } from './control-state.ts';

const logger = createLogger('accepted-input');

// Coordinator-owned execution operations the accepted-input orchestration drives.
// Queue mutations and pending-input bookkeeping are performed directly against the
// injected control operations and pending-input store instead of through here.
export interface AcceptedInputCoordinator {
  requestDrain(chatId: string, context: string): void;
  reserveDirect(chatId: string, turn: TurnIdentity): DirectTurnReservation;
  checkpoint(reservation: DirectTurnReservation): void;
  registerPending(
    chatId: string,
    content: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
  releaseDirect(reservation: DirectTurnReservation): Promise<void>;
  runDirect(
    reservation: DirectTurnReservation,
    content: string,
    options: RunAgentTurnOptions,
    dispatch?: (admission: AgentExecutionAdmission) => Promise<void>,
    beforeFailureRelease?: (error: unknown) => Promise<void>,
  ): Promise<void>;
  trackDispatch(task: Promise<void>): void;
  deliverActive(
    chatId: string,
    content: string,
    options: RunAgentTurnOptions,
    beforeDelivery: () => Promise<void>,
  ): Promise<boolean>;
  hasAppliedCreate(chatId: string, commandKey: string, entryId: string): Promise<boolean>;
}

export interface AcceptedInputDeps {
  controls: ChatExecutionControlOperations;
  pendingInputs: PendingInputsPort;
  coordinator: AcceptedInputCoordinator;
}

export class AcceptedInputSaga {
  readonly #controls: ChatExecutionControlOperations;
  readonly #pendingInputs: PendingInputsPort;
  readonly #coordinator: AcceptedInputCoordinator;

  constructor(deps: AcceptedInputDeps) {
    this.#controls = deps.controls;
    this.#pendingInputs = deps.pendingInputs;
    this.#coordinator = deps.coordinator;
  }

  async enqueue(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult> {
    try {
      const result = await this.#controls.create(
        input.command.chatId,
        input.content,
        { key: input.command.key, entryId: input.command.entryId },
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

  async schedule(input: AcceptedDirectInput): Promise<void> {
    const reservation = await this.#prepareDirect(input);
    this.#coordinator.trackDispatch(
      this.#coordinator.runDirect(reservation, input.content, input.options, input.dispatch).catch((error) => {
        logger.error('commands: run failed:', error instanceof Error ? error.message : String(error));
      }),
    );
  }

  async runInitial(input: AcceptedDirectInput): Promise<void> {
    const reservation = await this.#prepareDirect(input);
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

  async deliverActive(input: AcceptedActiveInput): Promise<AcceptedActiveInputOutcome> {
    let deliveryAccepted = false;
    try {
      const delivered = await this.#coordinator.deliverActive(
        input.command.chatId,
        input.content,
        { clientRequestId: input.command.clientRequestId, turnId: input.command.turnId },
        () => input.settlement.markScheduled(input.command, input.command.turnId!),
      );
      if (delivered) {
        deliveryAccepted = true;
        await input.settlement.settleActiveInput(input.command);
        return { delivery: 'active', control: await this.#controls.read(input.command.chatId) };
      }
    } catch (error) {
      deliveryAccepted ||= error instanceof ActiveInputDeliveryError && error.deliveryAccepted;
      await input.settlement.settleActiveInputFailure(input.command, error, deliveryAccepted);
      throw error;
    }
    const queued = await this.enqueue({
      command: input.command,
      content: input.content,
      settlement: input.settlement,
    });
    return { delivery: 'queued', entryId: queued.entryId, control: queued.control };
  }

  async recoverActive(input: AcceptedActiveInput): Promise<AcceptedActiveInputOutcome> {
    const applied = await this.#coordinator.hasAppliedCreate(
      input.command.chatId,
      input.command.key,
      input.command.entryId,
    );
    if (!applied) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'The previous active-input delivery did not reach a recorded outcome',
        409,
      );
    }
    await input.settlement.settleQueueMutation(input.command, input.command.entryId);
    this.#coordinator.requestDrain(input.command.chatId, 'recovered active fallback');
    return {
      delivery: 'queued',
      entryId: input.command.entryId,
      control: await this.#controls.read(input.command.chatId),
    };
  }

  async #prepareDirect(input: AcceptedDirectInput): Promise<DirectTurnReservation> {
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
      await this.#checkpointAfter(reservation, Promise.resolve(input.preparation?.prepare()));
      await this.#checkpointAfter(
        reservation,
        this.#coordinator.registerPending(input.command.chatId, input.content, input.options),
      );
      await this.#checkpointAfter(
        reservation,
        input.settlement.markScheduled(input.command, input.options.turnId!),
      );
      return reservation;
    } catch (error) {
      this.#pendingInputs.markFailed(
        input.command.chatId,
        input.options.clientRequestId!,
      );
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

  // Awaits one reservation-scoped step, then re-validates the reservation exactly
  // once. Every await between reserve and run can be invalidated by an admission
  // abort or a concurrent clear, so each is paired with a single check here.
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
