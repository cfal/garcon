import crypto from 'node:crypto';
import { AgentCallError, type AgentSteerRejectionReason } from '@garcon/server-agent-interface';
import type { AgentSteerOptions } from '../agents/session-types.ts';
import { DomainError, SteerDeliveryError } from '../../common/domain-error.ts';
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
  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void;
}

export class SteerInputDelivery {
  constructor(private readonly options: SteerInputDeliveryOptions) {}

  async captureTarget(chatId: string): Promise<CapturedSteerTarget | null> {
    const captured = this.#captureAttempt(chatId);
    if (!captured) return null;
    return Object.freeze({
      ...captured,
      providerTarget: await this.options.turnRunner.captureSteerTarget(chatId),
    });
  }

  async captureControlTarget(chatId: string): Promise<CapturedSteerTarget | null> {
    const captured = this.#captureAttempt(chatId);
    if (!captured) return null;
    let providerTarget: CapturedSteerTarget['providerTarget'] = null;
    try {
      providerTarget = await this.options.turnRunner.captureSteerTarget(chatId);
    } catch {
      // Capture cannot deliver input; fallback still waits for this exact attempt.
    }
    return Object.freeze({ ...captured, providerTarget });
  }

  #captureAttempt(chatId: string): Omit<CapturedSteerTarget, 'providerTarget'> | null {
    const attempt = this.options.ownership.attempt(chatId);
    const identity = attempt?.identity();
    if (!attempt || attempt.isSettled || !identity?.turnId) return null;
    // Delivery revalidates the captured attempt before control callers settle it and fall back.
    return Object.freeze({
      attempt,
      identity: Object.freeze({ ...identity, turnId: identity.turnId }),
    });
  }

  async deliver(
    chatId: string,
    content: string,
    providerContent: string,
    options: AgentSteerOptions,
    target: CapturedSteerTarget,
    afterPendingRegistered: (turnId: string) => Promise<void>,
    userMessagePresentation?: UserInputAdmissionOptions['userMessagePresentation'],
  ): Promise<AcceptedSteerOutcome> {
    let inserted = false;
    try {
      this.#assertTarget(chatId, target);
      inserted = await this.options.admitInput(chatId, content, {
        clientRequestId: options.clientRequestId,
        clientMessageId: options.clientMessageId,
        transcriptViewId: options.transcriptViewId,
        turnId: target.identity.turnId,
        commandType: 'steer',
        userMessagePresentation,
      });
      if (!inserted) return { turnId: target.identity.turnId, duplicate: true };
      await afterPendingRegistered(target.identity.turnId);
      await this.#deliverToProvider(chatId, providerContent, options, target);
      return { turnId: target.identity.turnId, duplicate: false };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new SteerDeliveryError(error, 'not-sent');
    } finally {
      if (inserted) this.options.discardPreparedInput(chatId, options.clientMessageId);
    }
  }

  async deliverControl(
    chatId: string, content: string, transcriptViewId: string, target: CapturedSteerTarget,
  ): Promise<void> {
    const clientMessageId = crypto.randomUUID();
    await this.#deliverToProvider(chatId, content, {
      clientRequestId: clientMessageId,
      clientMessageId,
      transcriptViewId,
    }, target);
  }

  async #deliverToProvider(
    chatId: string, content: string, options: AgentSteerOptions, target: CapturedSteerTarget,
  ): Promise<void> {
    let deliveryPrepared = false;
    try {
      this.#assertTarget(chatId, target);
      const result = await this.options.turnRunner.steerInput(
        chatId,
        content,
        options,
        target.providerTarget,
        async () => {
          this.#assertTarget(chatId, target);
          deliveryPrepared = true;
        },
      );
      if (result.kind === 'accepted') {
        if (!deliveryPrepared) {
          throw new SteerDeliveryError(
            new Error('Agent accepted steering without preparing delivery'),
            'unknown',
          );
        }
        return;
      }
      if (result.kind === 'rejected') throw steerRejectionError(result.reason);
      throw new SteerDeliveryError(new Error(result.message), result.outcome);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const uncertain = error instanceof AgentCallError
        ? error.outcome === 'unknown'
        : deliveryPrepared;
      throw new SteerDeliveryError(error, uncertain ? 'unknown' : 'not-sent');
    }
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
