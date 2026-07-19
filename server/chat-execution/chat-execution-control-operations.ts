import crypto from 'crypto';
import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import {
  bumpStoredChatExecutionControl,
  cloneStoredChatExecutionControl,
  emptyStoredChatExecutionControl,
  normalizeStoredChatExecutionControlState,
  type StoredChatExecutionControlState,
  type StoredQueueEntry,
} from '../chat-execution-control-state.ts';
import { DomainError } from '../lib/domain-error.ts';
import { createLogger } from '../lib/log.ts';
import type { ChatExecutionControlRepository } from './chat-execution-control-repository.ts';
import {
  clearQueue,
  consumeEmptyRecoveredInputContinuation,
  continueRecoveredInput,
  createQueueEntry,
  deleteQueueEntry,
  dropRecoveredInputContinuation,
  installRecoveryPause,
  pauseQueue,
  popNextQueueEntry,
  removeSentQueueEntry,
  replaceQueueEntry,
  requeueAndPause,
  restoreStoppedQueueEntry,
  resumeQueue,
  returnUnsentQueueEntry,
  type ControlTransition,
  type QueueCommandIdentity,
  type ReceiptRetention,
} from './chat-execution-control-transitions.ts';
import {
  EMPTY_RECEIPT_RETENTION,
  transitionContext,
  transitionError,
  type QueueCommandMutationResult,
} from './types.ts';

const logger = createLogger('chat-execution-control');

export interface ChatExecutionControlOperationsHost {
  runExclusive<T>(chatId: string, operation: () => Promise<T>): Promise<T>;
  assertRecoveryReady(): void;
  chatExists(chatId: string): boolean;
  publish(chatId: string, control: StoredChatExecutionControlState): void;
}

export interface ControlRecoveryResult {
  queuesToDrain: ReadonlySet<string>;
}

export class ChatExecutionControlOperations {
  constructor(
    private readonly repository: ChatExecutionControlRepository,
    private readonly host: ChatExecutionControlOperationsHost,
  ) {}

  async read(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => (
      cloneStoredChatExecutionControl(await this.#load(chatId))
    ));
  }

  async create(
    chatId: string,
    content: string,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        createQueueEntry(current, { content, command }, transitionContext(), receipts),
      );
      const result = committed.value;
      if (!result.duplicate) {
        this.#logMutation('create', chatId, result.entryId, committed.control, result.entry?.revision);
      }
      return { ...result, control: committed.control };
    });
  }

  async replace(
    chatId: string,
    entryId: string,
    content: string,
    expectedRevision: number,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = replaceQueueEntry(current, {
        entryId,
        content,
        expectedRevision,
        command,
      }, transitionContext(), receipts);
      if (transition.outcome.status === 'rejected') {
        this.#logMutation(
          'replace',
          chatId,
          entryId,
          current,
          current.entries.find((entry) => entry.id === entryId)?.revision,
          transition.outcome.rejection.code,
        );
      }
      const committed = await this.#commitTransition(chatId, current, transition);
      const result = committed.value;
      if (!result.duplicate) {
        this.#logMutation('replace', chatId, entryId, committed.control, result.entry?.revision);
      }
      return { ...result, control: committed.control };
    });
  }

  async delete(
    chatId: string,
    entryId: string,
    command?: QueueCommandIdentity,
    receipts: ReceiptRetention = EMPTY_RECEIPT_RETENTION,
  ): Promise<QueueCommandMutationResult> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = deleteQueueEntry(
        current,
        { entryId, command },
        transitionContext(),
        receipts,
      );
      if (transition.outcome.status === 'rejected') {
        this.#logMutation(
          'delete',
          chatId,
          entryId,
          current,
          current.entries.find((entry) => entry.id === entryId)?.revision,
          transition.outcome.rejection.code,
        );
      }
      const committed = await this.#commitTransition(chatId, current, transition);
      if (!committed.value.duplicate) this.#logMutation('delete', chatId, entryId, committed.control);
      return {
        entryId: committed.value.entryId,
        control: committed.control,
        duplicate: committed.value.duplicate,
      };
    });
  }

  async clear(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      return (await this.#commitTransition(
        chatId,
        current,
        clearQueue(current, transitionContext()),
      )).control;
    });
  }

  async pause(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        pauseQueue(current, transitionContext()),
      );
      if (committed.changed) this.#logPauseMutation('pause', chatId, committed.control);
      return committed.control;
    });
  }

  async resume(
    chatId: string,
    pauseId: string,
  ): Promise<{ control: StoredChatExecutionControlState; changed: boolean }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        resumeQueue(current, pauseId, transitionContext()),
      );
      if (committed.changed) this.#logPauseMutation('resume', chatId, committed.control);
      return { control: committed.control, changed: committed.changed };
    });
  }

  async continueRecoveredInput(
    chatId: string,
    continuationId: string,
  ): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = continueRecoveredInput(current, continuationId, transitionContext());
      if (transition.outcome.status === 'rejected') {
        this.#logRecoveredInputContinuation(
          transition.outcome.rejection.code === 'RECOVERED_INPUT_CONTINUATION_CHANGED'
            ? 'stale-reject'
            : 'empty-queue-reject',
          chatId,
          current,
        );
      }
      const committed = (await this.#commitTransition(chatId, current, transition)).control;
      this.#logRecoveredInputContinuation('explicit-continue', chatId, committed);
      return committed;
    });
  }

  async consumeEmptyContinuation(
    chatId: string,
    checkpoint: () => void,
  ): Promise<{ control: StoredChatExecutionControlState; changed: boolean }> {
    return this.host.runExclusive(chatId, async () => {
      checkpoint();
      const current = await this.#load(chatId);
      checkpoint();
      const result = await this.#commitTransition(
        chatId,
        current,
        consumeEmptyRecoveredInputContinuation(current, transitionContext()),
      );
      if (result.changed) {
        this.#logRecoveredInputContinuation('interactive-continue', chatId, result.control);
      }
      checkpoint();
      return { control: result.control, changed: result.changed };
    });
  }

  async dropRecoveredInputContinuation(
    chatId: string,
  ): Promise<{ control: StoredChatExecutionControlState; changed: boolean }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const result = await this.#commitTransition(
        chatId,
        current,
        dropRecoveredInputContinuation(current, transitionContext()),
      );
      if (result.changed) {
        this.#logRecoveredInputContinuation('native-settlement', chatId, result.control);
      }
      return { control: result.control, changed: result.changed };
    });
  }

  async hasAppliedCreate(chatId: string, commandKey: string, entryId: string): Promise<boolean> {
    return this.host.runExclusive(chatId, async () => {
      const control = await this.#load(chatId);
      return control.appliedCommands.some((command) => (
        command.key === commandKey
        && command.operation === 'create'
        && command.entryId === entryId
      ));
    });
  }

  async pop(
    chatId: string,
  ): Promise<{ entry: StoredQueueEntry; control: StoredChatExecutionControlState } | null> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        popNextQueueEntry(current, transitionContext()),
      );
      if (!committed.value) return null;
      const entry = committed.control.entries.find(
        (candidate) => candidate.id === committed.value!.entry.id,
      )!;
      this.#logMutation('pop', chatId, entry.id, committed.control, entry.revision);
      return { entry, control: committed.control };
    });
  }

  async removeSent(chatId: string, entryId: string): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        removeSentQueueEntry(current, entryId, transitionContext()),
      );
      this.#logMutation('sent', chatId, entryId, committed.control);
      return committed.control;
    });
  }

  async requeueAndPause(
    chatId: string,
    entryId: string,
    kind: AutomaticQueuePauseKind,
  ): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const priorEntry = current.entries.find((entry) => entry.id === entryId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        requeueAndPause(current, { entryId, kind }, transitionContext()),
      );
      if (priorEntry) {
        this.#logMutation('requeue', chatId, entryId, committed.control, priorEntry.revision);
      }
      this.#logPauseMutation('pause', chatId, committed.control, entryId);
      return committed.control;
    });
  }

  async returnUnsent(chatId: string, entryId: string): Promise<void> {
    await this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const entry = current.entries.find((candidate) => candidate.id === entryId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        returnUnsentQueueEntry(current, entryId, transitionContext()),
      );
      if (committed.changed) {
        this.#logMutation('requeue', chatId, entryId, committed.control, entry?.revision);
      }
    });
  }

  async restoreStopped(chatId: string, entryId: string): Promise<void> {
    await this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const entry = current.entries.find((candidate) => candidate.id === entryId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        restoreStoppedQueueEntry(current, entryId, transitionContext()),
      );
      if (committed.changed) {
        this.#logMutation('requeue', chatId, entryId, committed.control, entry?.revision);
        this.#logPauseMutation('pause', chatId, committed.control, entryId);
      }
    });
  }

  deleteStored(chatId: string): Promise<void> {
    return this.repository.delete(chatId);
  }

  async recover(
    chatsWithRecoveredInput: ReadonlySet<string>,
  ): Promise<ControlRecoveryResult> {
    const storedChatIds = await this.repository.listStoredChatIds();
    const queuesToDrain = new Set<string>();
    const storedChatIdSet = new Set(storedChatIds);
    for (const chatId of storedChatIds) {
      try {
        if (!this.host.chatExists(chatId)) {
          await this.repository.delete(chatId);
          logger.warn('queue: removed state for a deleted chat', { chatId });
          continue;
        }
        const snapshot = await this.repository.loadFresh(chatId);
        const control = snapshot.control;
        let modified = snapshot.needsCanonicalization;
        const recoveredIds = new Set<string>();
        for (const entry of control.entries) {
          if (entry.status !== 'sending') continue;
          entry.status = 'queued';
          recoveredIds.add(entry.id);
          modified = true;
        }
        if (recoveredIds.size > 0) {
          control.recentlyDispatched = control.recentlyDispatched.filter(
            (entry) => !recoveredIds.has(entry.entryId),
          );
          installRecoveryPause(control, {
            id: crypto.randomUUID(),
            kind: 'recovered-inflight',
            entryId: control.entries.find((entry) => recoveredIds.has(entry.id))!.id,
            pausedAt: new Date().toISOString(),
          });
        }
        const shouldInstallContinuation = chatsWithRecoveredInput.has(chatId);
        if (shouldInstallContinuation) {
          control.recoveredInputContinuation = {
            id: crypto.randomUUID(),
            installedAt: new Date().toISOString(),
          };
          modified = true;
        } else if (control.recoveredInputContinuation) {
          control.recoveredInputContinuation = null;
          modified = true;
        }
        const committed = modified
          ? await this.repository.save(
              chatId,
              normalizeStoredChatExecutionControlState(bumpStoredChatExecutionControl(control)),
            )
          : control;
        if (shouldInstallContinuation) {
          this.#logRecoveredInputContinuation('startup-install', chatId, committed);
        }
        if (recoveredIds.size > 0) {
          logger.info('queue: recovered stale chat queue', { chatId, recoveredCount: recoveredIds.size });
          this.#logPauseMutation(
            'recover',
            chatId,
            committed,
            committed.pause && 'entryId' in committed.pause ? committed.pause.entryId : undefined,
          );
        }
        if (
          !committed.pause
          && !committed.recoveredInputContinuation
          && committed.entries.some((entry) => entry.status === 'queued')
        ) {
          queuesToDrain.add(chatId);
        }
      } catch (error: unknown) {
        logger.warn(`queue: could not recover chat queue ${chatId}.queue.json:`, (error as Error).message);
        throw new Error(
          `Could not recover chat queue ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    for (const chatId of chatsWithRecoveredInput) {
      if (storedChatIdSet.has(chatId) || !this.host.chatExists(chatId)) continue;
      try {
        const control = bumpStoredChatExecutionControl(emptyStoredChatExecutionControl());
        control.recoveredInputContinuation = {
          id: crypto.randomUUID(),
          installedAt: new Date().toISOString(),
        };
        const committed = await this.repository.save(
          chatId,
          normalizeStoredChatExecutionControlState(control),
        );
        this.#logRecoveredInputContinuation('startup-install', chatId, committed);
      } catch (error: unknown) {
        throw new Error(
          `Could not persist recovered-input continuation for ${chatId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
    return { queuesToDrain };
  }

  async #load(chatId: string): Promise<StoredChatExecutionControlState> {
    this.host.assertRecoveryReady();
    return this.repository.load(chatId);
  }

  async #commit(
    chatId: string,
    control: StoredChatExecutionControlState,
  ): Promise<StoredChatExecutionControlState> {
    if (!this.host.chatExists(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Chat queue owner no longer exists', 404);
    }
    const result = await this.repository.save(
      chatId,
      normalizeStoredChatExecutionControlState(control),
    );
    this.host.publish(chatId, result);
    return result;
  }

  async #commitTransition<T>(
    chatId: string,
    current: StoredChatExecutionControlState,
    transition: ControlTransition<T>,
  ): Promise<{ value: T; control: StoredChatExecutionControlState; changed: boolean }> {
    if (transition.outcome.status === 'rejected') {
      throw transitionError(transition.outcome.rejection, current);
    }
    if (!transition.changed) {
      return {
        value: transition.outcome.value,
        control: cloneStoredChatExecutionControl(current),
        changed: false,
      };
    }
    return {
      value: transition.outcome.value,
      control: await this.#commit(chatId, transition.next),
      changed: true,
    };
  }

  #logMutation(
    operation: 'create' | 'replace' | 'delete' | 'pop' | 'requeue' | 'sent',
    chatId: string,
    entryId: string,
    control: StoredChatExecutionControlState,
    revision?: number,
    errorCode?: string,
  ): void {
    logger.debug('queue mutation', {
      chatId,
      operation,
      entryId,
      ...(revision === undefined ? {} : { revision }),
      queueVersion: control.version,
      queuedCount: control.entries.filter((entry) => entry.status === 'queued').length,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  #logPauseMutation(
    operation: 'pause' | 'resume' | 'recover',
    chatId: string,
    control: StoredChatExecutionControlState,
    entryId?: string,
  ): void {
    logger.debug('queue pause mutation', {
      chatId,
      operation,
      ...(entryId ? { entryId } : {}),
      ...(control.pause ? { pauseId: control.pause.id, pauseKind: control.pause.kind } : {}),
      queueVersion: control.version,
      queuedCount: control.entries.filter((entry) => entry.status === 'queued').length,
    });
  }

  #logRecoveredInputContinuation(
    operation: 'startup-install'
      | 'interactive-continue'
      | 'explicit-continue'
      | 'native-settlement'
      | 'stale-reject'
      | 'empty-queue-reject',
    chatId: string,
    control: StoredChatExecutionControlState,
  ): void {
    logger.debug('recovered-input continuation', {
      chatId,
      operation,
      ...(control.recoveredInputContinuation
        ? { continuationId: control.recoveredInputContinuation.id }
        : {}),
      controlVersion: control.version,
      queuedCount: control.entries.filter((entry) => entry.status === 'queued').length,
    });
  }
}
