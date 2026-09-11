import crypto from 'crypto';
import type { PreparedExecutionTurn, RunAgentTurnOptions } from '../agents/session-types.ts';
import {
  hasPendingTurnInput,
  type StoredControlInputEntry,
  type StoredQueueEntry,
} from './control-state.ts';
import { createLogger } from '../lib/log.ts';
import { DomainError, ProjectUnavailableError } from '../lib/domain-error.ts';
import { isRecoverablePreambleAdmissionError } from '../preambles/selection.js';
import { QueueExecutionAttempt } from './execution-attempt.ts';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.ts';
import { peekNextTurn, type DequeuedTurnInput } from './chat-execution-control-transitions.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import {
  executionTurnIdentity,
  type AgentTurnRunnerPort,
  type ProjectAdmissionPort,
  type UserInputAdmissionOptions,
} from './types.ts';

const logger = createLogger('queue-dispatch');

export interface QueueDispatchCallbacks {
  isShuttingDown(): boolean;
  registerQueued(chatId: string, content: string, options: RunAgentTurnOptions & Pick<UserInputAdmissionOptions, 'validateBeforeCommit'>): boolean;
  appendControlReceipt(chatId: string, entry: StoredControlInputEntry): void;
  isControlInputViewCurrent(chatId: string, viewId: string): boolean;
  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void;
  publishIdle(chatId: string): void;
  publishProjectUnavailable(chatId: string, error: ProjectUnavailableError): void;
  publishTurnFailed(chatId: string, message: string, options: RunAgentTurnOptions): void;
  retireAttempt(chatId: string, attempt: QueueExecutionAttempt): void;
}

export interface QueueDispatchDeps {
  ownership: ExecutionOwnership;
  controls: ChatExecutionControlOperations;
  turnRunner: AgentTurnRunnerPort;
  // Shared with selection Save and direct admission; held around the dequeue
  // transition so a queued input resolves selection at admission, never before
  // a Save's update-notice attempt. Expressed as a function port so the lock
  // type itself stays inside the coordinator.
  runSelectionAdmissionExclusive<T>(chatId: string, operation: () => Promise<T>): Promise<T>;
  projectAdmission: ProjectAdmissionPort;
  callbacks: QueueDispatchCallbacks;
}

function optionsForTurn(input: DequeuedTurnInput): RunAgentTurnOptions & { createdAt: string } {
  const submission = input.kind === 'user' ? input.entry.submission : null;
  return {
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

      const pending = await controls.read(chatId);
      if (!hasPendingTurnInput(pending)) {
        callbacks.publishIdle(chatId);
        return;
      }
      const candidate = peekNextTurn(pending);
      if (!candidate || this.#shouldHalt(chatId)) return;
      if (pending.entries.length > 0) {
        try {
          await this.deps.projectAdmission.assertAvailable(chatId);
        } catch (error) {
          if (!(error instanceof ProjectUnavailableError)) throw error;
          if (this.#shouldHalt(chatId)) return;
          const paused = await controls.pauseForUnavailableProject(chatId);
          if (!paused.changed) continue;
          callbacks.publishProjectUnavailable(chatId, error);
          return;
        }
      }
      if (this.#shouldHalt(chatId)) return;

      const options = optionsForTurn(candidate);
      let prepared: PreparedExecutionTurn | undefined;
      try {
        try {
          prepared = await this.deps.turnRunner.prepareTurn(chatId, options, ownership.drainSignal(chatId));
        } catch (error) {
          if (await this.#preparationFailed(chatId, candidate, options, error)) continue;
          return;
        }
        if (this.#shouldHalt(chatId)) return;
        options.preparedExecution = prepared;
        let inputInserted = false;
        const admission = { failure: null as DomainError | null };
        let result: Awaited<ReturnType<ChatExecutionControlOperations['dequeueNextTurn']>>;
        try {
          // The dequeue transition and its synchronous registerQueued() callback
          // run inside the selection/admission lock; the callback itself stays
          // synchronous, so it never awaits inside the dequeue.
          result = await this.deps.runSelectionAdmissionExclusive(
            chatId,
            () => controls.dequeueNextTurn(chatId, candidate, (input) => {
              if (this.#shouldHalt(chatId)) throw new DOMException('Queue admission cancelled', 'AbortError');
              if (input.kind === 'control') {
                if (!callbacks.isControlInputViewCurrent(chatId, input.entry.transcriptViewId)) {
                  logger.debug('queue: discarded stale control input', {
                    chatId,
                    entryId: input.entry.id,
                    transcriptViewId: input.entry.transcriptViewId,
                  });
                  return false;
                }
                prepared!.validate();
                callbacks.appendControlReceipt(chatId, input.entry);
                inputInserted = true;
                return true;
              }
              try {
                inputInserted = callbacks.registerQueued(chatId, input.entry.content, { ...options, validateBeforeCommit: prepared!.validate });
              } catch (error) {
                if (!isRecoverablePreambleAdmissionError(error)) throw error;
                admission.failure = error;
                return false;
              }
              return inputInserted;
            }),
          );
        } catch (error) {
          if (inputInserted) callbacks.discardPreparedInput(chatId, options.clientMessageId);
          if (this.#shouldHalt(chatId)) return;
          if (!inputInserted && error instanceof DomainError && error.code === 'SESSION_BUSY') {
            if (await this.#preparationFailed(chatId, candidate, options, error)) continue;
            return;
          }
          throw error;
        }
        if (!result) continue;
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
          if (this.#shouldHalt(chatId) || ownership.drainSignal(chatId).aborted) return;
          const input = result.input;
          const turn = executionTurnIdentity(options)!;
          const attempt = new QueueExecutionAttempt(turn, input.kind === 'user' ? input.entry.id : undefined);
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
          if (!await this.#runEntry(chatId, input, dispatchOptions, attempt)) return;
        } finally {
          if (result.input.kind === 'user') callbacks.discardPreparedInput(chatId, options.clientMessageId);
        }
      } finally {
        prepared?.release();
      }
    }
  }

  async #preparationFailed(chatId: string, candidate: DequeuedTurnInput, options: RunAgentTurnOptions, error: unknown): Promise<boolean> {
    if (this.#shouldHalt(chatId) || this.deps.ownership.drainSignal(chatId).aborted) return false;
    if (candidate.kind === 'user') {
      if (!await this.deps.controls.pauseBeforeDispatchFailure(chatId, candidate)) return true;
    } else {
      try {
        const removed = await this.deps.controls.dequeueNextTurn(chatId, candidate, () => {
          this.deps.ownership.drainSignal(chatId).throwIfAborted();
          if (this.#shouldHalt(chatId)) throw new DOMException('Queue admission cancelled', 'AbortError');
          return false;
        });
        if (!removed) return true;
      } catch (failure) {
        if (this.#shouldHalt(chatId) || this.deps.ownership.drainSignal(chatId).aborted) return false;
        throw failure;
      }
    }
    this.deps.callbacks.publishTurnFailed(chatId, error instanceof Error ? error.message : String(error), options);
    return candidate.kind === 'control';
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
