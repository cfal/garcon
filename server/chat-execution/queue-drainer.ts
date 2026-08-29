import crypto from 'crypto';
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
  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void;
  publishIdle(chatId: string): void;
  publishTurnFailed(chatId: string, message: string, options: RunAgentTurnOptions): void;
  retireAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
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
      let inputInserted = false;
      let result: Awaited<ReturnType<ChatExecutionControlOperations['dequeue']>>;
      try {
        result = await controls.dequeue(chatId, (entry) => {
          options = optionsForQueuedTurn(this.deps.getDrainOptions(chatId), entry);
          inputInserted = callbacks.registerQueued(chatId, entry.content, options);
          return inputInserted;
        });
      } catch (error) {
        if (inputInserted) callbacks.discardPreparedInput(chatId, options?.clientMessageId);
        throw error;
      }
      if (!result) {
        const control = await controls.read(chatId);
        if (control.entries.length === 0) callbacks.publishIdle(chatId);
        return;
      }
      if (!options) throw new Error('Queued input admission did not produce dispatch options');
      if (!result.inserted) continue;
      try {
        const turn = executionTurnIdentity(options)!;
        const attempt = new QueueExecutionAttempt(turn, result.entry.id);
        const dispatchOptions = {
          ...options,
          executionAdmission: ownership.installAttempt(chatId, attempt),
        };
        ownership.notifyOwnersChanged(chatId);
        ownership.beginFinalization(chatId, turn.turnId!).settle('committed');
        ownership.setActiveDrainEntry(chatId, result.entry.id);

        if (callbacks.isShuttingDown()) {
          callbacks.retireAttempt(chatId, attempt);
          return;
        }

        attempt.markLaunching();
        const shouldContinue = await this.#runEntry(chatId, result.entry, dispatchOptions, attempt);
        if (!shouldContinue) return;
      } finally {
        callbacks.discardPreparedInput(chatId, options.clientMessageId);
      }
    }
  }

  async #runEntry(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    attempt: QueueExecutionAttempt,
  ): Promise<boolean> {
    const result = await this.#runProvider(chatId, entry, options, attempt);
    if (result.kind !== 'failed') return true;
    if (attempt.isSettled) return true;

    const message = result.error instanceof Error ? result.error.message : String(result.error);
    logger.error('queue: queued turn failed:', { chatId, entryId: entry.id, message });
    await this.deps.controls.pauseAfterDispatchFailure(chatId, entry.id);
    this.deps.callbacks.publishTurnFailed(chatId, message, options);
    if (!attempt.isSettled) this.deps.callbacks.retireAttempt(chatId, attempt);
    return false;
  }

  #runProvider(
    chatId: string,
    entry: StoredQueueEntry,
    options: RunAgentTurnOptions,
    attempt: QueueExecutionAttempt,
  ): Promise<ProviderDispatchResult> {
    let run: Promise<void>;
    try {
      run = this.deps.turnRunner.runAgentTurn(chatId, entry.content, options);
    } catch (error) {
      return Promise.resolve({ kind: 'failed', error });
    }
    const completion: Promise<ProviderDispatchResult> = run.then(
      () => ({ kind: 'completed' }),
      (error) => ({ kind: 'failed', error }),
    );
    return Promise.race([
      completion,
      attempt.waitUntilSettled().then((): ProviderDispatchResult => ({ kind: 'retired' })),
    ]);
  }
}

type ProviderDispatchResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'retired' }
  | { readonly kind: 'failed'; readonly error: unknown };
