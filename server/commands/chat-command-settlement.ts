import {
  PRE_SCHEDULE_FAILURE_ERROR_CODE,
  type CommandLedger,
} from './command-ledger.ts';
import {
  QueueEntryMutationError,
  type AcceptedExecutionCommand,
  type CommandSettlementPort,
  type PreScheduleFailure,
} from '../chat-execution/types.ts';

export class ChatCommandSettlement implements CommandSettlementPort {
  constructor(private readonly ledger: CommandLedger) {}

  async markScheduled(
    command: AcceptedExecutionCommand,
    turnId: string,
  ): Promise<void> {
    await this.ledger.update(command.key, {
      status: 'scheduled',
      turnId,
      forkPreparation: undefined,
    });
  }

  async markPreScheduleFailure(
    command: AcceptedExecutionCommand,
    failure: PreScheduleFailure,
  ): Promise<void> {
    const patch = {
      status: 'failed' as const,
      error: failure.error instanceof Error ? failure.error.message : String(failure.error),
      errorCode: failure.retryable ? PRE_SCHEDULE_FAILURE_ERROR_CODE : undefined,
      ...(failure.preserveForkPreparation ? {} : { forkPreparation: undefined }),
    };
    await this.ledger.update(command.key, patch);
  }

  async settleQueueMutation(command: AcceptedExecutionCommand, entryId: string): Promise<void> {
    await this.ledger.update(command.key, { status: 'finished', entryId });
  }

  async settleQueueMutationFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
  ): Promise<void> {
    const mutationError = error instanceof QueueEntryMutationError ? error : null;
    await this.ledger.update(command.key, {
      status: mutationError ? 'rejected' : 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode: mutationError ? mutationError.code : PRE_SCHEDULE_FAILURE_ERROR_CODE,
    });
  }

  async settleActiveInput(command: AcceptedExecutionCommand): Promise<void> {
    await this.ledger.update(command.key, { status: 'finished', entryId: undefined });
  }

  async settleActiveInputFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryAccepted: boolean,
  ): Promise<void> {
    await this.ledger.update(command.key, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode: deliveryAccepted
        ? 'ACTIVE_INPUT_OUTCOME_UNKNOWN'
        : PRE_SCHEDULE_FAILURE_ERROR_CODE,
    });
  }

  async settleOperationFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void> {
    await this.ledger.settleTerminal(command.key, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

}
