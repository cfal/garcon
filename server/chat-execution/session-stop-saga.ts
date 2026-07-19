import type { ChatStopIntent } from '../../common/chat-types.ts';
import type { StoredChatExecutionControlState } from '../chat-execution-control-state.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import type { QueueExecutionAttempt } from './execution-attempt.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import type {
  AgentTurnRunnerPort,
  DrainSuppressionReason,
  SessionStopInFlight,
  StopActiveTurnResult,
} from './types.ts';

export interface SessionStopSagaHost {
  pauseQueue(chatId: string): Promise<StoredChatExecutionControlState>;
  readControl(chatId: string): Promise<StoredChatExecutionControlState>;
  requestDrain(chatId: string, context: string): void;
  addSuppression(chatId: string, reason: DrainSuppressionReason): void;
  removeSuppression(chatId: string, reason: DrainSuppressionReason): void;
  stopRequested(chatId: string, stopId: string, turn: TurnIdentity | undefined): void;
  stopped(chatId: string, success: boolean, intent: ChatStopIntent, stopId: string): void;
  settleAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
}

export class SessionStopSaga {
  constructor(
    private readonly ownership: ExecutionOwnership,
    private readonly runner: AgentTurnRunnerPort,
    private readonly host: SessionStopSagaHost,
  ) {}

  async abort(chatId: string, intent: ChatStopIntent): Promise<boolean> {
    const operation = this.ownership.reserveStop(chatId, intent);
    this.#start(chatId, operation);
    try {
      return await operation.promise;
    } finally {
      this.ownership.clearStop(chatId, operation);
    }
  }

  drainStop(chatId: string): Promise<boolean> | null {
    const operation = this.ownership.drainStop(chatId);
    if (!operation) return null;
    return operation.promise.finally(() => {
      this.ownership.consumeDrainStop(chatId, operation);
    });
  }

  async stop(chatId: string): Promise<StopActiveTurnResult> {
    const drainWasActive = this.ownership.isDraining(chatId);
    this.host.addSuppression(chatId, 'abort');
    this.host.addSuppression(chatId, 'manual-stop');
    const existingStop = this.ownership.stop(chatId);
    const operation = this.ownership.reserveStop(chatId, 'stop');
    const ownsStop = existingStop === undefined;
    try {
      await this.host.pauseQueue(chatId);
    } catch (error) {
      if (ownsStop && !operation.started) operation.resolve(false);
      if (ownsStop) this.ownership.clearStop(chatId, operation);
      this.host.removeSuppression(chatId, 'abort');
      this.host.removeSuppression(chatId, 'manual-stop');
      throw error;
    }
    let stopped: boolean;
    try {
      this.#start(chatId, operation);
      stopped = await operation.promise;
    } finally {
      this.ownership.clearStop(chatId, operation);
      this.host.removeSuppression(chatId, 'abort');
      if (!drainWasActive || !this.ownership.isDraining(chatId)) {
        this.host.removeSuppression(chatId, 'manual-stop');
      }
    }
    return { stopped, control: await this.host.readControl(chatId) };
  }

  async interrupt(chatId: string): Promise<boolean> {
    try {
      const stopped = await this.abort(chatId, 'interrupt-and-send');
      if (stopped) this.host.removeSuppression(chatId, 'abort');
      return stopped;
    } finally {
      this.host.requestDrain(chatId, 'interrupt');
    }
  }

  async abortForDeletion(chatId: string): Promise<boolean> {
    this.host.addSuppression(chatId, 'deletion');
    try {
      const attempt = this.ownership.attempt(chatId);
      if (!attempt && !this.runner.isChatRunning(chatId)) return true;
      const aborted = await this.abort(chatId, 'chat-deletion');
      if (!aborted) {
        const retired = !this.runner.isChatRunning(chatId)
          && this.ownership.isAttemptRetired(chatId, attempt);
        if (!retired) this.#rollbackDeletion(chatId);
        return retired;
      }
      if (attempt) await attempt.waitUntilSettled();
      const retired = !this.runner.isChatRunning(chatId)
        && this.ownership.isAttemptRetired(chatId, attempt);
      if (!retired) this.#rollbackDeletion(chatId);
      return retired;
    } catch (error) {
      this.#rollbackDeletion(chatId);
      throw error;
    }
  }

  #start(chatId: string, operation: SessionStopInFlight): void {
    if (operation.started) return;
    operation.started = true;
    this.#perform(chatId, operation.intent, operation.stopId).then(
      operation.resolve,
      operation.reject,
    );
  }

  async #perform(chatId: string, intent: ChatStopIntent, stopId: string): Promise<boolean> {
    const attempt = this.ownership.attempt(chatId);
    const registered = attempt?.entryId ? await attempt.waitUntilRegistered() : Boolean(attempt);
    const currentAttempt = attempt && this.ownership.isCurrentAttempt(chatId, attempt)
      ? attempt
      : undefined;
    try {
      this.host.stopRequested(chatId, stopId, currentAttempt?.identity());
    } catch (error) {
      currentAttempt?.allowLaunch();
      throw error;
    }
    if (currentAttempt && registered) {
      currentAttempt.allowLaunch();
      const abortable = await this.#waitUntilAbortable(chatId, currentAttempt);
      if (!abortable) {
        this.host.stopped(chatId, false, intent, stopId);
        return false;
      }
      if (currentAttempt.entryId) currentAttempt.expectAbort(stopId);
    }
    try {
      const success = await this.runner.abortSession(chatId);
      if (!success) currentAttempt?.clearExpectedAbort(stopId);
      this.host.stopped(chatId, success, intent, stopId);
      if (success && currentAttempt && !this.runner.isChatRunning(chatId)) {
        currentAttempt.markTerminalObserved();
        this.host.settleAttempt(chatId, currentAttempt);
      }
      return success;
    } catch (error) {
      currentAttempt?.clearExpectedAbort(stopId);
      this.host.stopped(chatId, false, intent, stopId);
      throw error;
    }
  }

  async #waitUntilAbortable(chatId: string, attempt: QueueExecutionAttempt): Promise<boolean> {
    const controller = new AbortController();
    const runtimeAbortable = this.runner.waitUntilTurnAbortable(
      chatId,
      attempt.identity(),
      controller.signal,
    ).then(
      (isAbortable) => {
        if (isAbortable && this.ownership.isCurrentAttempt(chatId, attempt)) attempt.markAbortable();
        return isAbortable;
      },
      () => false,
    );
    try {
      return await Promise.race([attempt.waitUntilAbortable(), runtimeAbortable]);
    } finally {
      controller.abort();
    }
  }

  #rollbackDeletion(chatId: string): void {
    this.host.removeSuppression(chatId, 'deletion');
    this.host.requestDrain(chatId, 'deletion rollback');
  }
}
