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
import { DomainError } from '../lib/domain-error.ts';

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
      payload: {},
      retainedPrivateTerminal: true as const,
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

  async settleGoalControl(command: AcceptedExecutionCommand): Promise<void> {
    await this.ledger.update(command.key, { status: 'finished', entryId: undefined });
  }

  async settleGoalControlFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryAccepted: boolean,
  ): Promise<void> {
    await this.ledger.update(command.key, {
      status: deliveryAccepted ? 'accepted' : 'failed',
      error: error instanceof Error ? error.message : String(error),
      errorCode: deliveryAccepted
        ? 'GOAL_CONTROL_OUTCOME_UNKNOWN'
        : PRE_SCHEDULE_FAILURE_ERROR_CODE,
    });
  }

  async settleSteerSuccess(command: AcceptedExecutionCommand, turnId: string): Promise<void> {
    await this.ledger.update(command.key, {
      status: 'finished',
      turnId,
      entryId: undefined,
      error: undefined,
      errorCode: undefined,
    });
  }

  async settleSteerFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void> {
    const domainError = error instanceof DomainError ? error : null;
    const rejected = domainError !== null && domainError.status < 500;
    await this.ledger.update(command.key, {
      status: rejected ? 'rejected' : 'failed',
      error: domainError?.message ?? (error instanceof Error ? error.message : String(error)),
      errorCode: domainError?.code ?? 'INTERNAL_ERROR',
      entryId: undefined,
    });
  }

  async settleOperationFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void> {
    await this.ledger.settleTerminal(command.key, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

}
