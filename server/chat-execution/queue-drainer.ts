import crypto from 'crypto';
import type { AutomaticQueuePauseKind } from '../../common/queue-state.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import type { StoredQueueEntry } from './control-state.ts';
import { createLogger } from '../lib/log.ts';
import type { TurnIdentity } from '../lib/turn-identity.ts';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import type { QueuedTurnFinalizationHandle } from './turn-finalization-tracker.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import {
  executionTurnIdentity,
  type AgentTurnRunnerPort,
  type PendingInputsPort,
  type QueueDrainOptionsResolver,
} from './types.ts';

const logger = createLogger('queue-dispatch');

// Exposes coordinator-owned effects that the drain loop cannot perform through
// its ownership, controls, turn runner, or pending-input collaborators.
export interface QueueDispatchCallbacks {
  isShuttingDown(): boolean;
  registerPending(chatId: string, content: string, options: RunAgentTurnOptions): Promise<void>;
  publishDispatching(chatId: string, entry: StoredQueueEntry): void;
  publishIdle(chatId: string): void;
  publishTurnFailed(chatId: string, message: string, options: RunAgentTurnOptions): void;
  settleAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
  stopBarrier(chatId: string): Promise<boolean> | null;
  removeSent(chatId: string, entryId: string): Promise<unknown>;
}

export interface QueueDispatchDeps {
  ownership: ExecutionOwnership;
  controls: ChatExecutionControlOperations;
  turnRunner: AgentTurnRunnerPort;
  pendingInputs: PendingInputsPort;
  getDrainOptions: QueueDrainOptionsResolver;
  callbacks: QueueDispatchCallbacks;
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

export class QueueDrainer {
  readonly #ownership: ExecutionOwnership;
  readonly #controls: ChatExecutionControlOperations;
  readonly #turnRunner: AgentTurnRunnerPort;
  readonly #pendingInputs: PendingInputsPort;
  readonly #getDrainOptions: QueueDrainOptionsResolver;
  readonly #callbacks: QueueDispatchCallbacks;

  constructor(deps: QueueDispatchDeps) {
    this.#ownership = deps.ownership;
    this.#controls = deps.controls;
    this.#turnRunner = deps.turnRunner;
    this.#pendingInputs = deps.pendingInputs;
    this.#getDrainOptions = deps.getDrainOptions;
    this.#callbacks = deps.callbacks;
  }

  #shouldHalt(chatId: string): boolean {
    return this.#callbacks.isShuttingDown()
      || this.#ownership.hasSuppression(chatId, 'abort')
      || this.#ownership.hasSuppression(chatId, 'deletion')
      || this.#ownership.hasSuppression(chatId, 'manual-stop')
      || this.#ownership.hasDirect(chatId)
      || this.#ownership.stop(chatId) !== undefined
      || this.#turnRunner.isChatRunning(chatId);
  }

  #hasManualStop(chatId: string): boolean {
    return this.#ownership.hasSuppression(chatId, 'manual-stop');
  }

  async run(chatId: string): Promise<void> {
    while (!this.#shouldHalt(chatId)) {
      const result = await this.#controls.pop(chatId);
      if (!result) {
        const control = await this.#controls.read(chatId);
        if (!control.entries.some((entry) => entry.status === 'queued' || entry.status === 'sending')) {
          this.#callbacks.publishIdle(chatId);
        }
        return;
      }

      const { entry } = result;
      this.#ownership.setActiveDrainEntry(chatId, entry.id);
      if (this.#callbacks.isShuttingDown()) {
        await this.#controls.returnUnsent(chatId, entry.id);
        return;
      }
      if (this.#hasManualStop(chatId)) {
        await this.#controls.restoreStopped(chatId, entry.id);
        return;
      }
      const stop = this.#callbacks.stopBarrier(chatId);
      if (stop) {
        const stopped = await stop.catch(() => false);
        if (this.#hasManualStop(chatId)) {
          await this.#controls.restoreStopped(chatId, entry.id);
          return;
        }
        if (!stopped) {
          await this.#controls.returnUnsent(chatId, entry.id);
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
    this.#ownership.setDrainAdmission(chatId, admissionController);

    try {
      options = optionsForQueuedTurn(this.#getDrainOptions(chatId), entry);
      options.executionAdmission = Object.freeze({
        signal: admissionController.signal,
        markStarted: () => { executionStarted = true; },
      });
      if (this.#callbacks.isShuttingDown()) {
        admissionController.abort(new Error('Turn interrupted because the server is shutting down'));
      }
      const turn = executionTurnIdentity(options)!;
      finalization = this.#ownership.beginFinalization(chatId, turn.turnId!);
      attempt = new QueueExecutionAttempt(turn, entry.id);
      this.#ownership.installAttempt(chatId, attempt);
      await this.#callbacks.registerPending(chatId, entry.content, options);
      attempt.markRegistered();
      if (this.#shouldHalt(chatId)) {
        stage = 'running';
        const shouldStart = await attempt.waitForLaunchDecision(admissionController.signal);
        if (!shouldStart) throw new Error('Queued turn stopped before runtime start');
      }
      this.#callbacks.publishDispatching(chatId, entry);
      stage = 'running';
      attempt.markLaunching();
      await this.#runProvider(chatId, entry, options, attempt);

      if (this.#ownership.shutdownTargetsEntry(chatId, entry.id)) {
        await this.#compensateShutdown(chatId, entry, options, executionStarted);
        finalization.settle('not-committed');
        return false;
      }
      stage = 'finalizing';
      await this.#callbacks.removeSent(chatId, entry.id);
      finalization.settle('committed');
      return true;
    } catch (error: unknown) {
      if (this.#ownership.shutdownTargetsEntry(chatId, entry.id)) {
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
        if (!this.#turnRunner.isChatRunning(chatId)) attempt.markTerminalObserved();
        this.#callbacks.settleAttempt(chatId, attempt);
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
    const abortable = this.#turnRunner.waitUntilTurnAbortable(
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
      const run = this.#turnRunner.runAgentTurn(chatId, entry.content, options);
      void Promise.race([abortable, run.then(() => false, () => false)])
        .finally(() => abortableWaitController.abort());
      await run;
    } finally {
      abortableWaitController.abort();
      attempt.markRunSettled();
      if (!this.#turnRunner.isChatRunning(chatId)) attempt.markTerminalObserved();
      this.#callbacks.settleAttempt(chatId, attempt);
    }
  }

  async #compensateShutdown(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    executionStarted: boolean,
  ): Promise<void> {
    if (executionStarted) {
      await this.#controls.requeueAndPause(chatId, entry.id, 'completion-uncertain');
      return;
    }
    if (options.clientRequestId) this.#pendingInputs.discard(chatId, options.clientRequestId);
    await this.#controls.returnUnsent(chatId, entry.id);
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
      const stop = this.#callbacks.stopBarrier(chatId);
      stopped = stop ? await stop : false;
    } catch {
      // The provider failure remains authoritative when the stop acknowledgement fails.
    }
    if (!stopped) {
      await this.#settleFailure(chatId, entry, options, 'running', runError, finalization);
      return false;
    }

    try {
      await this.#callbacks.removeSent(chatId, entry.id);
      finalization?.settle('committed');
      return true;
    } catch (error: unknown) {
      logger.error('queue: aborted entry finalization failed:', {
        chatId,
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.#controls.requeueAndPause(chatId, entry.id, 'completion-uncertain');
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
      await this.#controls.requeueAndPause(chatId, entry.id, kind);
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
      this.#callbacks.publishTurnFailed(chatId, message, options);
    }
  }
}
