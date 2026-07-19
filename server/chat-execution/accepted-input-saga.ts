import crypto from 'crypto';
import type { AgentExecutionAdmission, RunAgentTurnOptions } from '../agents/session-types.ts';
import { ActiveInputDeliveryError, DomainError } from '../lib/domain-error.ts';
import { createLogger } from '../lib/log.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { QueueCommandIdentity, ReceiptRetention } from './chat-execution-control-transitions.ts';
import type {
  AcceptedActiveInput,
  AcceptedActiveInputOutcome,
  AcceptedDirectInput,
  AcceptedDirectOperation,
  AcceptedQueueCreate,
  AcceptedQueueDelete,
  AcceptedQueueReplace,
  DirectTurnReservation,
  PendingUserInputRegistrationOptions,
  QueueCommandMutationResult,
} from './types.ts';
import type { StoredChatExecutionControlState } from '../chat-execution-control-state.ts';

const logger = createLogger('accepted-input');

export interface AcceptedInputSagaHost {
  createQueueEntry(
    chatId: string,
    content: string,
    command: QueueCommandIdentity,
    receipts: ReceiptRetention,
  ): Promise<QueueCommandMutationResult>;
  replaceQueueEntry(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command: QueueCommandIdentity,
    receipts: ReceiptRetention,
  ): Promise<QueueCommandMutationResult>;
  deleteQueueEntry(
    chatId: string,
    entryId: string,
    command: QueueCommandIdentity,
    receipts: ReceiptRetention,
  ): Promise<QueueCommandMutationResult>;
  requestDrain(chatId: string, context: string): void;
  reserveDirect(chatId: string, turn: TurnIdentity): DirectTurnReservation;
  checkpoint(reservation: DirectTurnReservation): void;
  consumeRecoveredInput(reservation: DirectTurnReservation): Promise<void>;
  readControl(chatId: string): Promise<StoredChatExecutionControlState>;
  registerPending(
    chatId: string,
    content: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
  markPendingFailed(chatId: string, clientRequestId: string): boolean;
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

export class AcceptedInputSaga {
  constructor(private readonly host: AcceptedInputSagaHost) {}

  async enqueue(input: AcceptedQueueCreate): Promise<QueueCommandMutationResult> {
    try {
      const receipts = await this.#receipts(input.command.chatId, input.settlement);
      const result = await this.host.createQueueEntry(
        input.command.chatId,
        input.content,
        { key: input.command.key, entryId: input.command.entryId },
        receipts,
      );
      await input.settlement.settleQueueMutation(input.command, result.entryId);
      this.host.requestDrain(input.command.chatId, 'accepted enqueue');
      return result;
    } catch (error) {
      await input.settlement.settleQueueMutationFailure(input.command, error);
      throw error;
    }
  }

  async replace(input: AcceptedQueueReplace): Promise<QueueCommandMutationResult> {
    try {
      const receipts = await this.#receipts(input.command.chatId, input.settlement);
      const result = await this.host.replaceQueueEntry(
        input.command.chatId,
        input.command.entryId,
        input.content,
        input.expectedRevision,
        { key: input.command.key, entryId: input.command.entryId },
        receipts,
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
      const receipts = await this.#receipts(input.command.chatId, input.settlement);
      const result = await this.host.deleteQueueEntry(
        input.command.chatId,
        input.command.entryId,
        { key: input.command.key, entryId: input.command.entryId },
        receipts,
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
    this.host.trackDispatch(
      this.host.runDirect(reservation, input.content, input.options, input.dispatch).catch((error) => {
        logger.error('commands: run failed:', error instanceof Error ? error.message : String(error));
      }),
    );
  }

  async runInitial(input: AcceptedDirectInput): Promise<void> {
    const reservation = await this.#prepareDirect(input);
    await this.host.runDirect(
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
      reservation = this.host.reserveDirect(input.command.chatId, options);
    } catch (error) {
      await this.#recordAdmissionFailure(input, error);
      throw error;
    }
    try {
      this.host.checkpoint(reservation);
      const control = await this.host.readControl(input.command.chatId);
      this.host.checkpoint(reservation);
      assertDirectControlAvailable(control);
      await input.settlement.markScheduled(input.command, options.turnId!, false);
      this.host.checkpoint(reservation);
    } catch (error) {
      let failure = error;
      try {
        await this.host.releaseDirect(reservation);
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
    this.host.trackDispatch(
      this.host.runDirect(reservation, '', options, input.dispatch).catch(async (error) => {
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
      const delivered = await this.host.deliverActive(
        input.command.chatId,
        input.content,
        { clientRequestId: input.command.clientRequestId, turnId: input.command.turnId },
        () => input.settlement.markScheduled(input.command, input.command.turnId!, true),
      );
      if (delivered) {
        deliveryAccepted = true;
        await input.settlement.settleActiveInput(input.command);
        return { delivery: 'active', control: await this.host.readControl(input.command.chatId) };
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
    const applied = await this.host.hasAppliedCreate(
      input.command.chatId,
      input.command.key,
      input.command.entryId,
    );
    if (!applied) {
      throw new DomainError(
        'INTERNAL_ERROR',
        'The previous active-input delivery did not reach a durable outcome',
        409,
      );
    }
    await input.settlement.settleQueueMutation(input.command, input.command.entryId);
    this.host.requestDrain(input.command.chatId, 'recovered active fallback');
    return {
      delivery: 'queued',
      entryId: input.command.entryId,
      control: await this.host.readControl(input.command.chatId),
    };
  }

  async #prepareDirect(input: AcceptedDirectInput): Promise<DirectTurnReservation> {
    let reservation: DirectTurnReservation;
    try {
      reservation = this.host.reserveDirect(input.command.chatId, input.options);
    } catch (error) {
      await this.#recordAdmissionFailure(input, error);
      throw error;
    }
    try {
      this.host.checkpoint(reservation);
      if (input.continueRecoveredInput) {
        await this.host.consumeRecoveredInput(reservation);
        this.host.checkpoint(reservation);
      }
      const control = await this.host.readControl(input.command.chatId);
      this.host.checkpoint(reservation);
      assertDirectControlAvailable(control);
      await input.preparation?.prepare();
      this.host.checkpoint(reservation);
      await this.host.registerPending(input.command.chatId, input.content, input.options);
      this.host.checkpoint(reservation);
      await input.settlement.markScheduled(input.command, input.options.turnId!, true);
      this.host.checkpoint(reservation);
      return reservation;
    } catch (error) {
      const pendingInputRecovery = this.host.markPendingFailed(
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
        await this.host.releaseDirect(reservation);
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
          pendingInputRecovery,
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

  #receipts(
    chatId: string,
    settlement: AcceptedQueueCreate['settlement'],
  ): Promise<ReceiptRetention> {
    return settlement.listUnsettledQueueReceiptKeys(chatId).then((protectedKeys) => ({ protectedKeys }));
  }

  async #recordAdmissionFailure(
    input: AcceptedDirectInput | AcceptedDirectOperation,
    error: unknown,
  ): Promise<void> {
    await input.settlement.markPreScheduleFailure(input.command, {
      error,
      pendingInputRecovery: false,
      retryable: true,
    });
  }
}

function assertDirectControlAvailable(control: StoredChatExecutionControlState): void {
  if (control.entries.length === 0 && !control.pause && !control.recoveredInputContinuation) return;
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
