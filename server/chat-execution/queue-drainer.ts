import crypto from 'crypto';
import { isAbortAcknowledged, type ChatStopOutcome } from '../../common/chat-types.ts';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import type { StoredQueueEntry } from './control-state.ts';
import { createLogger } from '../lib/log.ts';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import {
  executionTurnIdentity,
  type AgentTurnRunnerPort,
  type QueueDrainOptionsResolver,
} from './types.ts';

const logger = createLogger('queue-dispatch');

export interface QueueDispatchCallbacks {
  isShuttingDown(): boolean;
  registerQueued(chatId: string, content: string, options: RunAgentTurnOptions): boolean;
  publishIdle(chatId: string): void;
  publishTurnFailed(chatId: string, message: string, options: RunAgentTurnOptions): void;
  settleAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
  stopBarrier(chatId: string): Promise<ChatStopOutcome> | null;
}

export interface QueueDispatchDeps {
  ownership: ExecutionOwnership;
  controls: ChatExecutionControlOperations;
  turnRunner: AgentTurnRunnerPort;
  getDrainOptions: QueueDrainOptionsResolver;
  callbacks: QueueDispatchCallbacks;
}

function optionsForQueuedTurn(
  options: RunAgentTurnOptions,
  entry: StoredQueueEntry,
): RunAgentTurnOptions & { createdAt: string } {
  return {
    ...options,
    clientRequestId: crypto.randomUUID(),
    clientMessageId: entry.submission?.clientMessageId ?? crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    ...(entry.submission ? { transcriptViewId: entry.submission.transcriptViewId } : {}),
    ...(entry.submission?.excludedResendOrdinals?.length
      ? { excludedResendOrdinals: [...entry.submission.excludedResendOrdinals] }
      : {}),
    createdAt: entry.createdAt,
  };
}

export class QueueDrainer {
  constructor(private readonly deps: QueueDispatchDeps) {}

  #shouldHalt(chatId: string): boolean {
    const { ownership, turnRunner, callbacks } = this.deps;
    return callbacks.isShuttingDown()
      || ownership.hasSuppression(chatId, 'abort')
      || ownership.hasSuppression(chatId, 'deletion')
      || ownership.hasSuppression(chatId, 'manual-stop')
      || ownership.hasDirect(chatId)
      || ownership.stop(chatId) !== undefined
      || turnRunner.isChatRunning(chatId);
  }

  async run(chatId: string): Promise<void> {
    const { ownership, controls, callbacks } = this.deps;
    while (!this.#shouldHalt(chatId)) {
      const lingering = ownership.attempt(chatId);
      if (lingering) {
        const control = await controls.read(chatId);
        if (control.entries.length === 0) return;
        await lingering.waitUntilSettled();
        continue;
      }

      let options: RunAgentTurnOptions | undefined;
      const result = await controls.dequeue(chatId, (entry) => {
        options = optionsForQueuedTurn(this.deps.getDrainOptions(chatId), entry);
        return callbacks.registerQueued(chatId, entry.content, options);
      });
      if (!result) {
        const control = await controls.read(chatId);
        if (control.entries.length === 0) callbacks.publishIdle(chatId);
        return;
      }
      if (!options) throw new Error('Queued input admission did not produce dispatch options');
      if (!result.inserted) continue;

      const turn = executionTurnIdentity(options)!;
      const attempt = new QueueExecutionAttempt(turn, result.entry.id);
      attempt.markRegistered();
      ownership.installAttempt(chatId, attempt);
      ownership.beginFinalization(chatId, turn.turnId!).settle('committed');
      ownership.setActiveDrainEntry(chatId, result.entry.id);

      if (callbacks.isShuttingDown()) {
        attempt.markRunSettled();
        attempt.markTerminalObserved();
        callbacks.settleAttempt(chatId, attempt);
        return;
      }

      attempt.markLaunching();
      const shouldContinue = await this.#runEntry(chatId, result.entry, options, attempt);
      if (!shouldContinue) return;
    }
  }

  async #runEntry(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    attempt: QueueExecutionAttempt,
  ): Promise<boolean> {
    try {
      await this.#runProvider(chatId, entry, options, attempt);
      return true;
    } catch (error) {
      if (attempt.isExpectedAbort) {
        attempt.clearExpectedAbort();
        const stop = this.deps.callbacks.stopBarrier(chatId);
        const outcome = stop ? await stop.catch((): ChatStopOutcome => 'failed') : 'failed';
        if (isAbortAcknowledged(outcome)) return true;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error('queue: queued turn failed:', { chatId, entryId: entry.id, message });
      await this.deps.controls.pauseAfterDispatchFailure(chatId, entry.id);
      this.deps.callbacks.publishTurnFailed(chatId, message, options);
      return false;
    } finally {
      if (!attempt.isRunSettled) {
        attempt.markRunSettled();
        if (!this.deps.turnRunner.isChatRunning(chatId)) attempt.markTerminalObserved();
        this.deps.callbacks.settleAttempt(chatId, attempt);
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
    let completed = false;
    const abortable = this.deps.turnRunner.waitUntilTurnAbortable(
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
      const run = this.deps.turnRunner.runAgentTurn(chatId, entry.content, options);
      void Promise.race([abortable, run.then(() => false, () => false)])
        .finally(() => abortableWaitController.abort());
      await run;
      completed = true;
    } finally {
      abortableWaitController.abort();
      attempt.markRunSettled();
      if (!completed) attempt.markTerminalObserved();
      this.deps.callbacks.settleAttempt(chatId, attempt);
    }
  }
}
