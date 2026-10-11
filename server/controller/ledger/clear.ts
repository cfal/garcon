import type { ClearChatRequest, ClearChatResponse } from '../../../common/chat-clear.js';
import { DomainError } from '../../common/domain-error.js';
import type { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatRegistryEntry } from '../chats/registry-contracts.js';
import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { AgentDirectory } from '../agents/directory.js';
import { ownershipTransferPendingError } from '../agents/ownership-transfer-fence.js';
import type { ChatExecutionService } from '../chat-execution/chat-execution-coordinator.js';
import { hasPendingTurnInput, type StoredChatExecutionControlState } from '../chat-execution/control-state.js';
import type { TranscriptAdoptionService } from './adoption.js';
import type { TranscriptView } from './contracts.js';
import { LedgerFencedError } from './errors.js';
import { PreambleHistoryCollector, retainedPreambleHistoryMetadata } from './preamble-history.js';
import type { TranscriptLedgerService } from './service.js';

interface TranscriptClearOptions {
  readonly ledger: TranscriptLedgerService;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly registry: Pick<IChatRegistry, 'getChat' | 'updateChat' | 'flush'>;
  readonly ownership: Pick<AgentOwnershipJournal, 'hasPending'>;
  readonly integrations: Pick<AgentDirectory, 'get'>;
  readonly execution: Pick<
    ChatExecutionService,
    'reserveTranscriptSnapshot' | 'releaseTranscriptSnapshot' | 'readChatExecutionControl' | 'withChatExecutionControl'
  >;
  readonly reopenProducer: (chatId: string) => void;
  readonly chatMutationLock: KeyedPromiseLock;
}

export class TranscriptClearService {
  constructor(private readonly options: TranscriptClearOptions) {}

  async clear(request: ClearChatRequest, signal: AbortSignal): Promise<ClearChatResponse> {
    const { chatId } = request;
    this.#requireChat(chatId);
    return this.options.chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
      const { ledger } = this.options;
      const entry = this.#requireChat(chatId);
      if (this.options.ownership.hasPending(chatId)) throw ownershipTransferPendingError();
      if (!this.options.integrations.get(entry.agentId, entry.executorId)?.literalExecution) {
        throw new DomainError('OPERATION_UNSUPPORTED', 'Clearing displayed history is not available for this agent.', 422, false);
      }
      const reservation = this.#reserve(chatId);
      let promoted = false;
      try {
        try {
          await this.options.adoption.ensure(chatId, signal);
          const queue = await this.options.execution.readChatExecutionControl(chatId);
          this.#assertEmptyQueue(queue);
          const current = ledger.currentView(chatId);
          if (!current) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
          this.#assertUnchanged(request);
          signal.throwIfAborted();
          ledger.closeProducer(chatId);
          let staging: TranscriptView | null = null;
          try {
            staging = await this.#stageClearedView(chatId, current, entry, signal);
            const stagedViewId = staging.viewId;
            return await this.options.execution.withChatExecutionControl<ClearChatResponse>(chatId, async (queue) => {
              signal.throwIfAborted();
              this.#assertEmptyQueue(queue);
              this.#assertUnchanged(request);
              const replacement = ledger.replaceCurrentView(chatId, current.viewId, stagedViewId);
              promoted = true;
              staging = null;
              return { success: true, chatId, transcriptViewId: replacement.viewId };
            });
          } catch (error) {
            try {
              if (staging) await ledger.discardStagingView(chatId, staging.viewId);
            } catch (cleanupError) {
              if (!(cleanupError instanceof LedgerFencedError)) throw cleanupError;
            }
            throw error;
          } finally {
            this.options.reopenProducer(chatId);
          }
        } finally {
          await this.options.execution.releaseTranscriptSnapshot(reservation);
        }
      } catch (error) {
        if (promoted) {
          throw new DomainError(
            'TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN',
            'Clear may have completed. Refresh the chat before taking another action.',
            503,
            false,
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  async #stageClearedView(
    chatId: string,
    current: TranscriptView,
    entry: ChatRegistryEntry,
    signal: AbortSignal,
  ): Promise<TranscriptView> {
    const { ledger, registry } = this.options;
    const session = ledger.currentSession(chatId);
    const collector = new PreambleHistoryCollector();
    if (session) {
      for await (const page of ledger.rowPagesThrough(
        chatId,
        ledger.highWatermark(chatId),
        current.contentStartOrdinal,
        signal,
      )) {
        collector.add(page);
      }
    }
    const pending = entry.pendingPreambleBoundary;
    if (pending && ledger.hasPreambleBoundaryProof(chatId, pending)) {
      registry.updateChat(chatId, { pendingPreambleBoundary: null });
    }
    // Flushes consumed boundaries before deleting their only durable input proof.
    await registry.flush();
    const drafts = session
      ? [
          {
            kind: 'session' as const,
            at: session.at,
            detail: session.detail,
            providerMeta: retainedPreambleHistoryMetadata(collector.finish()),
          },
        ]
      : [];
    return ledger.stageView(chatId, drafts, 1);
  }

  #assertEmptyQueue(queue: StoredChatExecutionControlState): void {
    if (hasPendingTurnInput(queue)) {
      throw new DomainError('CHAT_RUNNING', 'Run or remove queued messages before clearing history.', 409, false);
    }
  }

  #requireChat(chatId: string) {
    const entry = this.options.registry.getChat(chatId);
    if (!entry) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
    return entry;
  }

  #reserve(chatId: string) {
    try {
      return this.options.execution.reserveTranscriptSnapshot(chatId);
    } catch (error) {
      throw new DomainError(
        'CHAT_RUNNING',
        'Wait for the current chat operation to finish before clearing history.',
        409,
        true,
        { cause: error },
      );
    }
  }

  #assertUnchanged(request: ClearChatRequest): void {
    const watermark = this.options.ledger.highWatermark(request.chatId);
    if (watermark.viewId !== request.transcriptViewId || watermark.ordinal !== request.lastOrdinal) {
      throw new DomainError(
        'STALE_TRANSCRIPT_VIEW',
        'Chat history changed. Review it and run /clear again.',
        409,
        false,
      );
    }
  }
}
