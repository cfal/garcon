import type {
  AgentSteerRejectionReason,
  AgentSteerResult,
} from '@garcon/server-agent-interface';
import type { AgentSteerOptions } from '../agents/session-types.ts';
import { DomainError, SteerDeliveryError } from '../lib/domain-error.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import type {
  AcceptedSteerOutcome,
  AgentTurnRunnerPort,
  CapturedSteerTarget,
  PendingInputsPort,
  PendingUserInputRegistrationOptions,
} from './types.ts';

interface SteerInputDeliveryOptions {
  turnRunner: AgentTurnRunnerPort;
  pendingInputs: PendingInputsPort;
  ownership: ExecutionOwnership;
  isShuttingDown(): boolean;
  registerPending(
    chatId: string,
    content: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
}

export class SteerInputDelivery {
  constructor(private readonly options: SteerInputDeliveryOptions) {}

  captureTarget(chatId: string): CapturedSteerTarget | null {
    const attempt = this.options.ownership.attempt(chatId);
    const identity = attempt?.identity();
    if (!attempt || attempt.isSettled || !identity?.turnId) return null;
    return Object.freeze({
      attempt,
      identity: Object.freeze({
        turnId: identity.turnId,
        ...(identity.clientRequestId ? { clientRequestId: identity.clientRequestId } : {}),
      }),
      providerTarget: this.options.turnRunner.captureSteerTarget(chatId),
    });
  }

  async deliver(
    chatId: string,
    content: string,
    providerContent: string,
    options: AgentSteerOptions,
    target: CapturedSteerTarget,
    afterPendingRegistered: (turnId: string) => Promise<void>,
  ): Promise<AcceptedSteerOutcome> {
    let pendingRegistered = false;
    let deliveryPrepared = false;
    let result: AgentSteerResult;
    try {
      result = await this.options.turnRunner.steerInput(
        chatId,
        providerContent,
        options,
        target.providerTarget,
        async () => {
          this.#assertTarget(chatId, target);
          await this.options.registerPending(chatId, content, {
            clientRequestId: options.clientRequestId,
            clientMessageId: options.clientMessageId,
            turnId: target.identity.turnId,
          });
          pendingRegistered = true;
          await afterPendingRegistered(target.identity.turnId);
          deliveryPrepared = true;
        },
      );
    } catch (error) {
      if (pendingRegistered) {
        this.#settlePending(chatId, options.clientRequestId, deliveryPrepared ? 'unknown' : 'not-sent');
      }
      if (error instanceof DomainError) throw error;
      throw new SteerDeliveryError(error, deliveryPrepared ? 'unknown' : 'not-sent');
    }

    if (result.kind === 'accepted') {
      if (!deliveryPrepared) {
        throw new SteerDeliveryError(
          new Error('Agent accepted steering without preparing delivery'),
          'not-sent',
        );
      }
      return { turnId: target.identity.turnId };
    }
    if (result.kind === 'rejected') {
      if (pendingRegistered) this.#settlePending(chatId, options.clientRequestId, 'not-sent');
      throw steerRejectionError(result.reason);
    }
    if (pendingRegistered) this.#settlePending(chatId, options.clientRequestId, result.outcome);
    throw new SteerDeliveryError(new Error(result.message), result.outcome);
  }

  #assertTarget(chatId: string, target: CapturedSteerTarget): void {
    if (this.options.isShuttingDown()) {
      throw new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503);
    }
    const currentAttempt = this.options.ownership.attempt(chatId);
    const currentIdentity = currentAttempt?.identity();
    if (
      currentAttempt !== target.attempt
      || target.attempt.isSettled
      || currentIdentity?.turnId !== target.identity.turnId
      || currentIdentity?.clientRequestId !== target.identity.clientRequestId
    ) {
      throw new DomainError(
        'STEER_TURN_CHANGED',
        'The active turn changed before steering could be applied',
        409,
      );
    }
  }

  #settlePending(
    chatId: string,
    clientRequestId: string,
    outcome: 'not-sent' | 'unknown',
  ): void {
    if (outcome === 'unknown') {
      this.options.pendingInputs.markUnconfirmed(chatId, clientRequestId);
    } else {
      this.options.pendingInputs.markFailed(chatId, clientRequestId);
    }
  }
}

function steerRejectionError(reason: AgentSteerRejectionReason): DomainError {
  switch (reason) {
    case 'no-active-turn':
      return new DomainError('STEER_TURN_UNAVAILABLE', 'There is no active turn to steer', 409);
    case 'turn-changed':
      return new DomainError(
        'STEER_TURN_CHANGED',
        'The active turn changed before steering could be applied',
        409,
      );
    case 'turn-not-steerable':
      return new DomainError(
        'STEER_TURN_NOT_STEERABLE',
        'This kind of active turn cannot be steered',
        409,
      );
    case 'invalid-input':
      return new DomainError('VALIDATION_FAILED', 'The steering input is invalid', 400);
    case 'provider-rejected':
      return new DomainError(
        'STEER_PROVIDER_REJECTED',
        'The agent rejected this steering input',
        409,
      );
  }
}
