import type {
  CommandErrorCode,
  SteerCommandRequest,
  SteerCommandResponse,
} from '../../common/chat-command-contracts.ts';
import { DomainError, SteerDeliveryError } from '../lib/domain-error.ts';
import { createLogger, type Logger } from '../lib/log.ts';
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

const logger = createLogger('commands:steer');
const STEER_CAPACITY_EXHAUSTED_MESSAGE =
  'Steering is temporarily unavailable because the server has retained its maximum number of steering identities';

export class SteerCommands {
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
    if (!initialChat) {
      const error = new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
      logSteerOutcome(logger, {
        chatId: input.chatId,
        clientRequestId,
      }, { kind: 'failed', error });
      throw error;
    }
    const integrationId = initialChat.agentId;
    const target = this.deps.queue.captureSteerTarget(input.chatId);
    let outcomeTurnId: string | undefined;

    try {
      const response = await this.support.withChatMutationLock(input.chatId, async () => {
        let ledger: LedgerAcceptResult;
        try {
          ledger = await this.deps.ledger.accept({
            commandType: 'steer',
            chatId: input.chatId,
            clientRequestId,
            payload: {
              chatId: input.chatId,
              content: input.content,
              clientMessageId,
            },
          });
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
          clientMessageId,
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
}

interface SteerLogContext {
  chatId: string;
  clientRequestId: string;
  integrationId?: string;
  turnId?: string;
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
  };
  if (errorCode === 'STEER_OUTCOME_UNKNOWN' || errorCode === 'INTERNAL_ERROR') {
    outcomeLogger.error('steer failed', failureDetails);
  } else {
    outcomeLogger.warn('steer rejected', failureDetails);
  }
}

function steerOutcomeErrorCode(error: unknown): CommandErrorCode {
  if (error instanceof CommandValidationError) return error.code;
  if (error instanceof DomainError) return steerErrorCode(error.code);
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
