import crypto from 'crypto';
import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import {
  hasPendingTurnInput,
  type StoredControlInputEntry,
  type StoredQueueEntry,
} from './control-state.ts';
import { createLogger } from '../lib/log.ts';
import { DomainError } from '../lib/domain-error.ts';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import type { DequeuedTurnInput } from './chat-execution-control-transitions.ts';
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
  appendControlReceipt(chatId: string, entry: StoredControlInputEntry): void;
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

function optionsForTurn(
  options: RunAgentTurnOptions,
  input: DequeuedTurnInput,
): RunAgentTurnOptions & { createdAt: string } {
  const submission = input.kind === 'user' ? input.entry.submission : null;
  return {
    ...options,
    clientRequestId: crypto.randomUUID(),
    clientMessageId: submission?.clientMessageId ?? crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    ...(input.kind === 'control'
      ? { transcriptViewId: input.entry.transcriptViewId, commandType: 'agent-run' as const }
      : submission ? { transcriptViewId: submission.transcriptViewId } : {}),
    ...(submission?.excludedResendOrdinals?.length
      ? { excludedResendOrdinals: [...submission.excludedResendOrdinals] }
      : {}),
    createdAt: input.entry.createdAt,
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
        if (!hasPendingTurnInput(control)) return;
        await lingering.waitUntilSettled();
        continue;
      }

      let options: RunAgentTurnOptions | undefined;
      let inputInserted = false;
      const admission = { failure: null as DomainError | null };
      let result: Awaited<ReturnType<ChatExecutionControlOperations['dequeueNextTurn']>>;
      try {
        result = await controls.dequeueNextTurn(chatId, (input) => {
          options = optionsForTurn(this.deps.getDrainOptions(chatId), input);
          if (input.kind === 'control') {
            callbacks.appendControlReceipt(chatId, input.entry);
            inputInserted = true;
            return true;
          }
          try {
            inputInserted = callbacks.registerQueued(chatId, input.entry.content, options);
          } catch (error) {
            if (
              !(error instanceof DomainError)
              || error.code !== 'PREAMBLE_SLASH_COMMAND_BLOCKED'
            ) throw error;
            admission.failure = error;
            return false;
          }
          return inputInserted;
        });
      } catch (error) {
        if (inputInserted) callbacks.discardPreparedInput(chatId, options?.clientMessageId);
        throw error;
      }
      if (!result) {
        const control = await controls.read(chatId);
        if (!hasPendingTurnInput(control)) callbacks.publishIdle(chatId);
        return;
      }
      if (!options) throw new Error('Queued input admission did not produce dispatch options');
      if (admission.failure) {
        logger.warn('queue: queued turn rejected before admission', {
          chatId,
          entryId: result.input.entry.id,
          code: admission.failure.code,
        });
        callbacks.publishTurnFailed(chatId, admission.failure.message, options);
        continue;
      }
      if (!result.inserted) continue;
      try {
        const input = result.input;
        const turn = executionTurnIdentity(options)!;
        const attempt = new QueueExecutionAttempt(
          turn,
          input.kind === 'user' ? input.entry.id : undefined,
        );
        const dispatchOptions = {
          ...options,
          executionAdmission: ownership.installAttempt(chatId, attempt),
        };
        const finalization = ownership.beginFinalization(chatId, turn.turnId!);
        if (input.kind === 'user') ownership.setActiveDrainEntry(chatId, input.entry.id);

        if (callbacks.isShuttingDown()) {
          finalization.settle('not-committed');
          callbacks.retireAttempt(chatId, attempt);
          return;
        }

        finalization.settle('committed');
        attempt.markLaunching();
        const shouldContinue = await this.#runEntry(chatId, input, dispatchOptions, attempt);
        if (!shouldContinue) return;
      } finally {
        if (result.input.kind === 'user') {
          callbacks.discardPreparedInput(chatId, options.clientMessageId);
        }
      }
    }
  }

  async #runEntry(
    chatId: string,
    input: DequeuedTurnInput,
    options: RunAgentTurnOptions,
    attempt: QueueExecutionAttempt,
  ): Promise<boolean> {
    const result = await this.#runProvider(chatId, input.entry, options, attempt);
    if (result.kind !== 'failed' || attempt.isSettled) return true;

    const message = result.error instanceof Error ? result.error.message : String(result.error);
    logger.error('queue: queued turn failed:', {
      chatId,
      entryId: input.entry.id,
      inputKind: input.kind,
      message,
    });
    if (input.kind === 'user') await this.deps.controls.pauseAfterDispatchFailure(chatId, input.entry.id);
    this.deps.callbacks.publishTurnFailed(chatId, message, options);
    if (!attempt.isSettled) this.deps.callbacks.retireAttempt(chatId, attempt);
    return input.kind === 'control';
  }

  async #runProvider(
    chatId: string,
    entry: StoredQueueEntry | StoredControlInputEntry,
    options: RunAgentTurnOptions,
    attempt: QueueExecutionAttempt,
  ): Promise<ProviderDispatchResult> {
    try {
      return await Promise.race([
        this.deps.turnRunner.runAgentTurn(chatId, entry.content, options)
          .then<ProviderDispatchResult, ProviderDispatchResult>(
            () => ({ kind: 'completed' }),
            (error) => ({ kind: 'failed', error }),
          ),
        attempt.waitUntilSettled().then((): ProviderDispatchResult => ({ kind: 'retired' })),
      ]);
    } catch (error) {
      return { kind: 'failed', error };
    }
  }
}

type ProviderDispatchResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'retired' }
  | { readonly kind: 'failed'; readonly error: unknown };
