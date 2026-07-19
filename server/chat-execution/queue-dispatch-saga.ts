import crypto from 'crypto';
import type { AutomaticQueuePauseKind } from '../../common/queue-state.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import type { StoredChatExecutionControlState, StoredQueueEntry } from '../chat-execution-control-state.ts';
import { createLogger } from '../lib/log.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import type { QueuedTurnFinalizationHandle } from './turn-finalization-tracker.ts';
import { executionTurnIdentity } from './types.ts';

const logger = createLogger('queue-dispatch');

export interface QueueDispatchHost {
  shouldHalt(chatId: string): boolean;
  isShuttingDown(): boolean;
  hasManualStop(chatId: string): boolean;
  stopBarrier(chatId: string): Promise<boolean> | null;
  popNext(chatId: string): Promise<{ entry: StoredQueueEntry; control: StoredChatExecutionControlState } | null>;
  readControl(chatId: string): Promise<StoredChatExecutionControlState>;
  setActiveEntry(chatId: string, entryId: string): void;
  setAdmissionController(chatId: string, controller: AbortController): void;
  shutdownTargetsEntry(chatId: string, entryId: string): boolean;
  resolveOptions(chatId: string, entry: StoredQueueEntry): RunAgentTurnOptions;
  usesRecoveredHistory(chatId: string): boolean;
  beginFinalization(chatId: string, turnId: string): QueuedTurnFinalizationHandle;
  installAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
  registerPending(chatId: string, content: string, options: RunAgentTurnOptions): Promise<void>;
  publishDispatching(chatId: string, entry: StoredQueueEntry): void;
  waitUntilTurnAbortable(
    chatId: string,
    turn: TurnIdentity,
    signal: AbortSignal,
  ): Promise<boolean>;
  runProvider(chatId: string, content: string, options: RunAgentTurnOptions): Promise<void>;
  isProviderRunning(chatId: string): boolean;
  settleAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
  discardPending(chatId: string, clientRequestId: string): void;
  returnUnsent(chatId: string, entryId: string): Promise<void>;
  restoreStopped(chatId: string, entryId: string): Promise<void>;
  requeueAndPause(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<void>;
  removeSent(chatId: string, entryId: string): Promise<void>;
  publishIdle(chatId: string): void;
  publishTurnFailed(chatId: string, message: string, options: RunAgentTurnOptions): void;
}

function optionsForQueuedTurn(
  options: RunAgentTurnOptions,
  entry: StoredQueueEntry,
): RunAgentTurnOptions {
  const delivery = entry.delivery ?? {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  };
  return { ...options, ...delivery };
}

export class QueueDispatchSaga {
  constructor(private readonly host: QueueDispatchHost) {}

  async run(chatId: string): Promise<void> {
    while (!this.host.shouldHalt(chatId)) {
      const result = await this.host.popNext(chatId);
      if (!result) {
        const control = await this.host.readControl(chatId);
        if (!control.entries.some((entry) => entry.status === 'queued' || entry.status === 'sending')) {
          this.host.publishIdle(chatId);
        }
        return;
      }

      const { entry } = result;
      this.host.setActiveEntry(chatId, entry.id);
      if (this.host.isShuttingDown()) {
        await this.host.returnUnsent(chatId, entry.id);
        return;
      }
      if (this.host.hasManualStop(chatId)) {
        await this.host.restoreStopped(chatId, entry.id);
        return;
      }
      const stop = this.host.stopBarrier(chatId);
      if (stop) {
        const stopped = await stop.catch(() => false);
        if (this.host.hasManualStop(chatId)) {
          await this.host.restoreStopped(chatId, entry.id);
          return;
        }
        if (!stopped) {
          await this.host.returnUnsent(chatId, entry.id);
          return;
        }
      }
      const shouldContinue = await this.#dispatchEntry(chatId, entry);
      if (!shouldContinue) return;
    }
  }

  async #dispatchEntry(chatId: string, entry: StoredQueueEntry): Promise<boolean> {
    let options: RunAgentTurnOptions = {};
    let stage: 'preparing' | 'running' | 'finalizing' = 'preparing';
    let attempt: QueueExecutionAttempt | undefined;
    let finalization: QueuedTurnFinalizationHandle | undefined;
    let executionStarted = false;
    const admissionController = new AbortController();
    this.host.setAdmissionController(chatId, admissionController);

    try {
      options = optionsForQueuedTurn(this.host.resolveOptions(chatId, entry), entry);
      if (this.host.usesRecoveredHistory(chatId)) options.directHistoryRecovery = 'allow-empty';
      options.executionAdmission = Object.freeze({
        signal: admissionController.signal,
        markStarted: () => { executionStarted = true; },
      });
      if (this.host.isShuttingDown()) {
        admissionController.abort(new Error('Turn interrupted because the server is shutting down'));
      }
      const turn = executionTurnIdentity(options)!;
      finalization = this.host.beginFinalization(chatId, turn.turnId!);
      attempt = new QueueExecutionAttempt(turn, entry.id);
      this.host.installAttempt(chatId, attempt);
      await this.host.registerPending(chatId, entry.content, options);
      attempt.markRegistered();
      if (this.host.shouldHalt(chatId)) {
        stage = 'running';
        const shouldStart = await attempt.waitForLaunchDecision(admissionController.signal);
        if (!shouldStart) throw new Error('Queued turn stopped before runtime start');
      }
      this.host.publishDispatching(chatId, entry);
      stage = 'running';
      attempt.markLaunching();
      await this.#runProvider(chatId, entry, options, attempt);

      if (this.host.shutdownTargetsEntry(chatId, entry.id)) {
        await this.#compensateShutdown(chatId, entry, options, executionStarted);
        finalization.settle('not-committed');
        return false;
      }
      stage = 'finalizing';
      await this.host.removeSent(chatId, entry.id);
      finalization.settle('committed');
      return true;
    } catch (error: unknown) {
      if (this.host.shutdownTargetsEntry(chatId, entry.id)) {
        attempt?.clearExpectedAbort();
        await this.#tryShutdownCompensation(chatId, entry, options, executionStarted);
        finalization?.settle('not-committed');
        return false;
      }
      if (stage === 'running' && attempt?.isExpectedAbort === true) {
        attempt.clearExpectedAbort();
        return this.#settleExpectedAbort(chatId, entry, options, error, finalization);
      }
      await this.#settleFailure(chatId, entry, options, stage, error, finalization);
      return false;
    } finally {
      finalization?.settle('not-committed');
      if (attempt && !attempt.isRunSettled) {
        attempt.markRunSettled();
        if (!this.host.isProviderRunning(chatId)) attempt.markTerminalObserved();
        this.host.settleAttempt(chatId, attempt);
      }
    }
  }

  async #runProvider(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    attempt: QueueExecutionAttempt,
  ): Promise<void> {
    const abortableWaitController = new AbortController();
    const abortable = this.host.waitUntilTurnAbortable(
      chatId,
      attempt.identity(),
      abortableWaitController.signal,
    ).then(
      (isAbortable) => {
        if (isAbortable) attempt.markAbortable();
        return isAbortable;
      },
      () => false,
    );
    try {
      const run = this.host.runProvider(chatId, entry.content, options);
      void Promise.race([abortable, run.then(() => false, () => false)])
        .finally(() => abortableWaitController.abort());
      await run;
    } finally {
      abortableWaitController.abort();
      attempt.markRunSettled();
      if (!this.host.isProviderRunning(chatId)) attempt.markTerminalObserved();
      this.host.settleAttempt(chatId, attempt);
    }
  }

  async #compensateShutdown(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    executionStarted: boolean,
  ): Promise<void> {
    if (executionStarted) {
      await this.host.requeueAndPause(chatId, entry.id, 'completion-uncertain');
      return;
    }
    if (options.clientRequestId) this.host.discardPending(chatId, options.clientRequestId);
    await this.host.returnUnsent(chatId, entry.id);
  }

  async #tryShutdownCompensation(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    executionStarted: boolean,
  ): Promise<void> {
    try {
      await this.#compensateShutdown(chatId, entry, options, executionStarted);
    } catch (error: unknown) {
      logger.error('queue: failed to preserve shutdown-aborted entry:', {
        chatId,
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #settleExpectedAbort(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    runError: unknown,
    finalization: QueuedTurnFinalizationHandle | undefined,
  ): Promise<boolean> {
    let stopped = false;
    try {
      const stop = this.host.stopBarrier(chatId);
      stopped = stop ? await stop : false;
    } catch {
      // The provider failure remains authoritative when the stop acknowledgement fails.
    }
    if (!stopped) {
      await this.#settleFailure(chatId, entry, options, 'running', runError, finalization);
      return false;
    }

    try {
      await this.host.removeSent(chatId, entry.id);
      finalization?.settle('committed');
      return true;
    } catch (error: unknown) {
      logger.error('queue: aborted entry finalization failed:', {
        chatId,
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.host.requeueAndPause(chatId, entry.id, 'completion-uncertain');
      } catch (compensationError: unknown) {
        logger.error('queue: failed to record aborted-entry pause:', {
          chatId,
          entryId: entry.id,
          message: compensationError instanceof Error
            ? compensationError.message
            : String(compensationError),
        });
      }
      return false;
    }
  }

  async #settleFailure(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    stage: 'preparing' | 'running' | 'finalizing',
    error: unknown,
    finalization: QueuedTurnFinalizationHandle | undefined,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const kind: AutomaticQueuePauseKind = stage === 'finalizing'
      ? 'completion-uncertain'
      : 'queued-turn-failed';
    if (kind === 'queued-turn-failed') {
      logger.error('queue: queued turn failed:', { chatId, entryId: entry.id, stage, message });
    } else {
      logger.error('queue: sent-entry finalization failed:', { chatId, entryId: entry.id, stage });
    }
    let compensated = false;
    try {
      await this.host.requeueAndPause(chatId, entry.id, kind);
      compensated = true;
    } catch (compensationError: unknown) {
      logger.error('queue: failed to record automatic pause:', {
        chatId,
        entryId: entry.id,
        stage,
        message: compensationError instanceof Error ? compensationError.message : String(compensationError),
      });
    }
    finalization?.settle('not-committed');
    if (kind === 'queued-turn-failed' && compensated) {
      this.host.publishTurnFailed(chatId, message, options);
    }
  }
}
