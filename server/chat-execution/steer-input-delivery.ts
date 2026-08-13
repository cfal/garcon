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
  UserInputAdmissionOptions,
} from './types.ts';

interface SteerInputDeliveryOptions {
  turnRunner: AgentTurnRunnerPort;
  ownership: ExecutionOwnership;
  isShuttingDown(): boolean;
  admitInput(
    chatId: string,
    content: string,
    options: UserInputAdmissionOptions,
  ): Promise<boolean>;
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
    let deliveryPrepared = false;
    let result: AgentSteerResult;
    try {
      this.#assertTarget(chatId, target);
      const inserted = await this.options.admitInput(chatId, content, {
        clientRequestId: options.clientRequestId,
        clientMessageId: options.clientMessageId,
        transcriptViewId: options.transcriptViewId,
        turnId: target.identity.turnId,
        commandType: 'steer',
      });
      if (!inserted) return { turnId: target.identity.turnId, duplicate: true };
      await afterPendingRegistered(target.identity.turnId);
      result = await this.options.turnRunner.steerInput(
        chatId,
        providerContent,
        options,
        target.providerTarget,
        async () => {
          this.#assertTarget(chatId, target);
          deliveryPrepared = true;
        },
      );
    } catch (error) {
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
      return { turnId: target.identity.turnId, duplicate: false };
    }
    if (result.kind === 'rejected') {
      throw steerRejectionError(result.reason);
    }
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
