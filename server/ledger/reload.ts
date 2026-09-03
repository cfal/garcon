import type { IntegrationRegistry } from '../agents/integration-registry.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import {
  hasPendingTurnInput,
  type StoredChatExecutionControlState,
} from '../chat-execution/control-state.js';
import type { TranscriptSnapshotReservation } from '../chat-execution/types.js';
import { DomainError } from '../lib/domain-error.js';
import type { LedgerRowDraft, TranscriptView } from './contracts.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TranscriptAdoptionService } from './adoption.js';
import { LedgerFencedError } from './errors.js';
import { TranscriptLedgerService } from './service.js';
import { frozenConversationDrafts } from './projection.js';
import { importNativeHistoryDrafts } from './native-history-seed.js';
import { collectPreambleHistoryEvidence } from './preamble-history.js';

interface ReloadExecutionPort {
  reserveTranscriptSnapshot(chatId: string): TranscriptSnapshotReservation;
  releaseTranscriptSnapshot(reservation: TranscriptSnapshotReservation): Promise<void>;
  readChatExecutionControl(chatId: string): Promise<StoredChatExecutionControlState>;
}

export interface TranscriptReloadServiceOptions {
  readonly ledger: TranscriptLedgerService;
  readonly adoption: TranscriptAdoptionService;
  readonly registry: IChatRegistry;
  readonly integrations: IntegrationRegistry;
  readonly execution: ReloadExecutionPort;
  readonly reopenProducer: (chatId: string) => void;
  readonly getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly now?: () => string;
}

export class TranscriptReloadService {
  readonly #now: () => string;

  constructor(private readonly options: TranscriptReloadServiceOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async reload(chatId: string, signal = new AbortController().signal): Promise<TranscriptView> {
    await this.options.adoption.ensure(chatId, signal);
    return this.options.chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
      const reservation = this.#reserve(chatId);
      try {
        const queue = await this.options.execution.readChatExecutionControl(chatId);
        if (hasPendingTurnInput(queue)) {
          throw new DomainError(
            'CHAT_RUNNING',
            'Run or remove queued messages before reloading from native history.',
            409,
            false,
          );
        }
        signal.throwIfAborted();
        return await this.#reloadReserved(chatId, signal);
      } finally {
        await this.options.execution.releaseTranscriptSnapshot(reservation);
      }
    });
  }

  #reserve(chatId: string): TranscriptSnapshotReservation {
    try {
      return this.options.execution.reserveTranscriptSnapshot(chatId);
    } catch (error) {
      throw new DomainError(
        'CHAT_RUNNING',
        'Wait for the current chat operation to finish before reloading.',
        409,
        true,
        { cause: error },
      );
    }
  }

  async #reloadReserved(chatId: string, signal: AbortSignal): Promise<TranscriptView> {
    let entry = this.options.registry.getChat(chatId);
    const current = this.options.ledger.currentView(chatId);
    const session = this.options.ledger.currentSession(chatId);
    if (!entry || !current) {
      throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
    }
    const integration = this.options.integrations.require(entry.agentId);
    if (!session || !integration.nativeHistoryImport) {
      throw new DomainError(
        'HISTORY_LOAD_FAILED',
        'This chat has no native history available to reload.',
        422,
        false,
      );
    }

    const currentRows = this.options.ledger.currentRows(chatId);
    const bindingRows = currentRows.filter((row) => row.ordinal >= current.contentStartOrdinal);
    const preambleEvidence = collectPreambleHistoryEvidence(bindingRows);
    const pending = entry.pendingPreambleBoundary;
    if (pending && this.options.ledger.hasPreambleBoundaryProof(chatId, pending)) {
      const updated = await this.options.registry.updateChat(
        chatId,
        { pendingPreambleBoundary: null },
        { flush: true },
      );
      if (!updated) throw new DomainError('SESSION_NOT_FOUND', 'Session not found', 404, false);
      entry = updated;
    }

    this.options.ledger.closeProducer(chatId);
    let staging: TranscriptView | null = null;
    let replacement: TranscriptView;
    try {
      const prefix = frozenConversationDrafts(
        currentRows
          .filter((row) => row.ordinal < current.contentStartOrdinal),
      );
      const sessionDraft: LedgerRowDraft = {
        kind: 'session',
        at: session.at,
        detail: session.detail,
        providerMeta: null,
      };
      const imported = await importNativeHistoryDrafts({
        chatId,
        entry,
        integration,
        nativeHistoryImport: integration.nativeHistoryImport,
        session: session.detail,
        carryOverRevision: this.options.getCarryOverRevision(entry),
        signal,
        now: this.#now,
        preambleEvidence,
      });
      const contentStartOrdinal = prefix.length + 1;
      staging = this.options.ledger.stageView(
        chatId,
        [...prefix, sessionDraft, ...imported],
        contentStartOrdinal,
      );
      replacement = this.options.ledger.replaceCurrentView(
        chatId,
        current.viewId,
        staging.viewId,
      );
    } catch (error) {
      let failure = error;
      try {
        if (staging) this.options.ledger.discardStagingView(chatId, staging.viewId);
      } catch (cleanupError) {
        if (!(cleanupError instanceof LedgerFencedError)) failure = cleanupError;
      } finally {
        this.options.reopenProducer(chatId);
      }
      throw failure;
    }
    this.options.reopenProducer(chatId);
    return replacement;
  }
}
