import type { TurnEventMetadata } from '../agents/event-bus.js';
import {
  ExpectedUserAbortTracker,
  type ExpectedAbortAcknowledgementDisposition,
  type ExpectedAbortConsumption,
  type ExpectedUserAbortTrackerOptions,
} from '../lib/expected-user-aborts.js';
import type { PendingUserInputServiceContract } from './pending-user-input-service.js';
import {
  StopSettlementCoordinator,
  type StopSettlementCoordinatorOptions,
} from './stop-settlement-coordinator.js';

export interface UserAbortLifecycleCoordinatorOptions
  extends StopSettlementCoordinatorOptions {
  expectedAbortTracker?: ExpectedUserAbortTrackerOptions;
}

export interface UserAbortStopAcknowledgement {
  terminalDisposition: ExpectedAbortAcknowledgementDisposition;
  turn?: TurnEventMetadata;
}

/** Owns terminal attribution and pending-input settlement for user-initiated aborts. */
export class UserAbortLifecycleCoordinator {
  readonly #expectedAborts: ExpectedUserAbortTracker;
  readonly #settlement: StopSettlementCoordinator;

  constructor(
    pendingInputs: Pick<
      PendingUserInputServiceContract,
      'captureCohort' | 'settleNativeCohort'
    >,
    options: UserAbortLifecycleCoordinatorOptions = {},
  ) {
    this.#expectedAborts = new ExpectedUserAbortTracker(options.expectedAbortTracker);
    this.#settlement = new StopSettlementCoordinator(pendingInputs, options);
  }

  onStopRequested(
    chatId: string,
    stopId: string,
    turn: TurnEventMetadata | undefined,
  ): void {
    this.#expectedAborts.mark(chatId, turn, stopId);
    this.#settlement.onStopRequested(chatId, stopId, turn);
  }

  onSessionStopped(
    chatId: string,
    stopId: string,
    success: boolean,
  ): UserAbortStopAcknowledgement {
    const acknowledgement = this.#expectedAborts.acknowledge(chatId, stopId, success);
    this.#settlement.onSessionStopped(chatId, stopId, success);
    return {
      terminalDisposition: acknowledgement.disposition,
      ...(acknowledgement.identity ? { turn: acknowledgement.identity } : {}),
    };
  }

  onTurnTerminal(
    chatId: string,
    turn: TurnEventMetadata | undefined,
  ): ExpectedAbortConsumption {
    this.#settlement.onTurnTerminal(chatId, turn);
    return this.#expectedAborts.consume(chatId, turn);
  }

  onTurnSettled(chatId: string, turn: TurnEventMetadata | undefined): void {
    this.#settlement.onTurnTerminal(chatId, turn);
    this.#expectedAborts.completeTurn(chatId, turn);
  }

  discard(chatId: string): void {
    this.#expectedAborts.clear(chatId);
    this.#settlement.discard(chatId);
  }
}
