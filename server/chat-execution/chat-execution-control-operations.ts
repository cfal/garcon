import type { AutomaticQueuePauseKind, QueueEntry } from '../../common/queue-state.ts';
import type { QueueEntryPlacement } from '../../common/chat-command-contracts.ts';
import {
  cloneStoredChatExecutionControl,
  type StoredChatExecutionControlState,
  type StoredControlInputEntry,
  type StoredQueueSubmissionIdentity,
  type StoredQueueEntry,
} from './control-state.ts';
import { DomainError } from '../lib/domain-error.ts';
import { createLogger } from '../lib/log.ts';
import type { ChatExecutionControlRepository } from './chat-execution-control-repository.ts';
import {
  clearQueue,
  discardPendingInput,
  createQueueEntry,
  deleteQueueEntry,
  moveQueueEntry,
  pauseQueue,
  dequeueNextTurn,
  enqueueControlInput,
  consumeQueueSteer,
  releaseQueueSteer,
  replaceQueueEntry,
  reserveQueueSteer,
  requeueAndPause,
  pauseAfterDispatchFailure,
  resumeQueue,
  type ControlTransition,
  type DequeuedTurnInput,
  type QueueCommandIdentity,
} from './chat-execution-control-transitions.ts';
import {
  transitionContext,
  transitionError,
  type ProjectAdmissionPort,
  type QueueCommandMutationResult,
} from './types.ts';

const logger = createLogger('chat-execution-control');

export interface ChatExecutionControlOperationsHost {
  runExclusive<T>(chatId: string, operation: () => Promise<T>): Promise<T>;
  chatExists(chatId: string): boolean;
  unsettledQueueReceiptKeys(chatId: string): ReadonlySet<string>;
  publish(chatId: string, control: StoredChatExecutionControlState): void;
}

export class ChatExecutionControlOperations {
  constructor(
    private readonly repository: ChatExecutionControlRepository,
    private readonly host: ChatExecutionControlOperationsHost,
    private readonly projectAdmission: ProjectAdmissionPort,
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
    submission?: StoredQueueSubmissionIdentity,
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = createQueueEntry(
        current,
        { content, command, submission },
        this.#transitionContext(chatId),
      );
      if (transition.outcome.status === 'ok' && !transition.outcome.value.duplicate) {
        await this.projectAdmission.assertAvailable(chatId);
      }
      const committed = await this.#commitTransition(chatId, current, transition);
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
  ): Promise<QueueCommandMutationResult & { entry: QueueEntry | null }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = replaceQueueEntry(current, {
        entryId,
        content,
        expectedRevision,
        command,
      }, this.#transitionContext(chatId));
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
  ): Promise<QueueCommandMutationResult> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = deleteQueueEntry(
        current,
        { entryId, command },
        this.#transitionContext(chatId),
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

  async move(
    chatId: string,
    input: {
      entryId: string;
      targetEntryId: string;
      placement: QueueEntryPlacement;
      expectedReorderRevision: number;
      expectedSourceRevision: number;
      expectedTargetRevision: number;
    },
    command?: QueueCommandIdentity,
  ): Promise<QueueCommandMutationResult & { rebased: boolean | null }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const transition = moveQueueEntry(
        current,
        { ...input, command },
        this.#transitionContext(chatId),
      );
      if (transition.outcome.status === 'rejected') {
        this.#logMove(
          chatId,
          input,
          current,
          null,
          transition.outcome.rejection.code,
        );
      }
      const committed = await this.#commitTransition(chatId, current, transition);
      if (!committed.value.duplicate) {
        this.#logMove(chatId, input, committed.control, committed.value.rebased);
      }
      return {
        entryId: committed.value.entryId,
        control: committed.control,
        duplicate: committed.value.duplicate,
        rebased: committed.value.rebased,
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

  async discardPendingInput(chatId: string): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      return (await this.#commitTransition(
        chatId,
        current,
        discardPendingInput(current, transitionContext()),
      )).control;
    });
  }

  async enqueueControl(
    chatId: string,
    input: Omit<StoredControlInputEntry, 'id'>,
  ): Promise<{ entry: StoredControlInputEntry; control: StoredChatExecutionControlState }> {
    return this.host.runExclusive(chatId, async () => {
      this.#assertChatExists(chatId);
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        enqueueControlInput(current, input, transitionContext()),
      );
      this.#logControlMutation('enqueue', chatId, committed.value, committed.control);
      return { entry: committed.value, control: committed.control };
    });
  }

  async pause(chatId: string): Promise<{
    control: StoredChatExecutionControlState;
    changed: boolean;
  }> {
    return this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        pauseQueue(current, transitionContext()),
      );
      if (committed.changed) this.#logPauseMutation('pause', chatId, committed.control);
      return { control: committed.control, changed: committed.changed };
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

  async dequeueNextTurn(
    chatId: string,
    admit: (input: DequeuedTurnInput) => boolean,
  ): Promise<{
    input: DequeuedTurnInput;
    control: StoredChatExecutionControlState;
    inserted: boolean;
  } | null> {
    return this.host.runExclusive(chatId, () => {
      const current = this.#load(chatId);
      const transition = dequeueNextTurn(current, transitionContext());
      if (transition.outcome.status === 'rejected') {
        throw transitionError(transition.outcome.rejection, current);
      }
      if (!transition.outcome.value) return Promise.resolve(null);
      const inserted = admit(transition.outcome.value);
      const control = this.#commitNow(chatId, transition.next, transition.publicChanged);
      const committed = { value: transition.outcome.value, control };
      if (committed.value.kind === 'control') {
        this.#logControlMutation('dequeue', chatId, committed.value.entry, committed.control);
      } else {
        const entry = committed.value.entry;
        this.#logMutation('pop', chatId, entry.id, committed.control, entry.revision);
      }
      return Promise.resolve({ input: committed.value, control: committed.control, inserted });
    });
  }

  async reserveSteer(
    chatId: string,
    input: {
      entryId: string;
      expectedRevision: number;
      expectedReorderRevision: number;
    },
  ): Promise<{ entry: StoredQueueEntry; control: StoredChatExecutionControlState }> {
    return this.host.runExclusive(chatId, async () => {
      this.#assertChatExists(chatId);
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        reserveQueueSteer(current, input, transitionContext()),
      );
      const entry = committed.control.entries.find((candidate) => candidate.id === input.entryId)!;
      this.#logMutation('steer-reserve', chatId, entry.id, committed.control, entry.revision);
      return { entry, control: committed.control };
    });
  }

  async releaseSteer(
    chatId: string,
    entryId: string,
  ): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      this.#assertChatExists(chatId);
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        releaseQueueSteer(current, entryId, transitionContext()),
      );
      if (committed.changed) this.#logMutation('steer-release', chatId, entryId, committed.control);
      return committed.control;
    });
  }

  async consumeSteer(
    chatId: string,
    entryId: string,
  ): Promise<StoredChatExecutionControlState> {
    return this.host.runExclusive(chatId, async () => {
      this.#assertChatExists(chatId);
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        consumeQueueSteer(current, entryId, transitionContext()),
      );
      if (committed.changed) this.#logMutation('steer-consume', chatId, entryId, committed.control);
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

  async pauseAfterDispatchFailure(chatId: string, entryId: string): Promise<void> {
    await this.host.runExclusive(chatId, async () => {
      const current = await this.#load(chatId);
      const committed = await this.#commitTransition(
        chatId,
        current,
        pauseAfterDispatchFailure(current, entryId, transitionContext()),
      );
      if (committed.changed) this.#logPauseMutation('pause', chatId, committed.control, entryId);
    });
  }

  deleteStored(chatId: string): Promise<void> {
    this.repository.delete(chatId);
    return Promise.resolve();
  }

  #load(chatId: string): StoredChatExecutionControlState {
    return this.repository.load(chatId);
  }

  #transitionContext(chatId: string) {
    return transitionContext(() => this.host.unsettledQueueReceiptKeys(chatId));
  }

  async #commit(
    chatId: string,
    control: StoredChatExecutionControlState,
    publish = true,
  ): Promise<StoredChatExecutionControlState> {
    if (!this.host.chatExists(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Chat queue owner no longer exists', 404);
    }
    return this.#commitNow(chatId, control, publish);
  }

  #commitNow(
    chatId: string,
    control: StoredChatExecutionControlState,
    publish = true,
  ): StoredChatExecutionControlState {
    if (!this.host.chatExists(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Chat queue owner no longer exists', 404);
    }
    const result = this.repository.save(chatId, control);
    if (publish) {
      try {
        this.host.publish(chatId, result);
      } catch (error) {
        logger.warn(`execution-control publication failed after commit for ${chatId}:`, error);
      }
    }
    return result;
  }

  #assertChatExists(chatId: string): void {
    if (!this.host.chatExists(chatId)) {
      throw new DomainError('SESSION_NOT_FOUND', 'Chat queue owner no longer exists', 404);
    }
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
      control: await this.#commit(chatId, transition.next, transition.publicChanged),
      changed: true,
    };
  }

  #logMutation(
    operation:
      | 'create'
      | 'replace'
      | 'delete'
      | 'pop'
      | 'requeue'
      | 'steer-reserve'
      | 'steer-release'
      | 'steer-consume',
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
      queuedCount: control.entries.filter(isPendingQueueEntry).length,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  #logMove(
    chatId: string,
    input: {
      entryId: string;
      targetEntryId: string;
      placement: QueueEntryPlacement;
      expectedReorderRevision: number;
    },
    control: StoredChatExecutionControlState,
    rebased: boolean | null,
    errorCode?: string,
  ): void {
    logger.debug('queue mutation', {
      chatId,
      operation: 'move',
      entryId: input.entryId,
      targetEntryId: input.targetEntryId,
      placement: input.placement,
      expectedReorderRevision: input.expectedReorderRevision,
      reorderRevision: control.reorderRevision,
      queueVersion: control.version,
      queuedCount: control.entries.filter(isPendingQueueEntry).length,
      ...(rebased === null ? {} : { rebased }),
      ...(errorCode ? { errorCode } : {}),
    });
  }

  #logPauseMutation(
    operation: 'pause' | 'resume',
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
      queuedCount: control.entries.filter(isPendingQueueEntry).length,
    });
  }

  #logControlMutation(
    operation: 'enqueue' | 'dequeue',
    chatId: string,
    entry: StoredControlInputEntry,
    control: StoredChatExecutionControlState,
  ): void {
    logger.debug('control input lane mutation', {
      chatId,
      operation,
      entryId: entry.id,
      laneDepth: control.controlEntries.length,
    });
  }
}

function isPendingQueueEntry(entry: StoredQueueEntry): boolean {
  return entry.status === 'queued' || entry.status === 'steering';
}
