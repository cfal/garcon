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
import { DomainError } from '../../common/domain-error.ts';
import type { SteerDeliveryOutcome } from '../../../common/chat-command-contracts.ts';
import { AgentCallError } from '@garcon/server-agent-interface';

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
      errorCode: failure.retryable ? PRE_SCHEDULE_FAILURE_ERROR_CODE : failure.error instanceof DomainError ? failure.error.code : undefined,
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

  async settleSteerSuccess(command: AcceptedExecutionCommand, turnId: string): Promise<void> {
    await this.ledger.update(command.key, {
      status: 'finished',
      turnId,
      entryId: command.entryId,
      error: undefined,
      errorCode: undefined,
      deliveryOutcome: undefined,
    });
  }

  async settleSteerFailure(
    command: AcceptedExecutionCommand,
    error: unknown,
    deliveryOutcome?: SteerDeliveryOutcome,
  ): Promise<void> {
    const domainError = error instanceof DomainError ? error : null;
    const rejected = domainError !== null && domainError.status < 500;
    await this.ledger.update(command.key, {
      status: rejected ? 'rejected' : 'failed',
      error: domainError?.message ?? (error instanceof Error ? error.message : String(error)),
      errorCode: domainError?.code ?? 'INTERNAL_ERROR',
      entryId: command.entryId,
      deliveryOutcome,
    });
  }

  recordOperationFailure(command: AcceptedExecutionCommand, error: unknown): void {
    this.ledger.recordDispatchFailure(command.key, error instanceof AgentCallError ? error.outcome : 'untyped');
  }

  async settleOperationFailure(command: AcceptedExecutionCommand, error: unknown): Promise<void> {
    this.recordOperationFailure(command, error);
    const domainError = error instanceof DomainError ? error
      : error instanceof AgentCallError && error.cause instanceof DomainError ? error.cause : null;
    await this.ledger.settleTerminal(command.key, 'failed', {
      error: error instanceof Error ? error.message : String(error),
      errorCode: domainError?.code ?? 'INTERNAL_ERROR',
    });
  }

  async settleDuplicateInput(command: AcceptedExecutionCommand): Promise<void> {
    await this.ledger.settleTerminal(command.key, 'finished');
  }

}
