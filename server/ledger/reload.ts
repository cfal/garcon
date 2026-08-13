import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { ChatMessage } from '../../common/chat-types.js';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import type { IntegrationRegistry } from '../agents/integration-registry.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.js';
import type { TranscriptSnapshotReservation } from '../chat-execution/types.js';
import { DomainError } from '../lib/domain-error.js';
import type { LedgerRow, LedgerRowDraft, TranscriptView } from './contracts.js';
import type { TranscriptAdoptionService } from './adoption.js';
import { TranscriptLedgerService } from './service.js';
import { frozenConversationDrafts } from './projection.js';

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
  readonly now?: () => string;
}

export class TranscriptReloadService {
  readonly #now: () => string;

  constructor(private readonly options: TranscriptReloadServiceOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async reload(chatId: string, signal = new AbortController().signal): Promise<TranscriptView> {
    await this.options.adoption.ensure(chatId, signal);
    const reservation = this.#reserve(chatId);
    try {
      const queue = await this.options.execution.readChatExecutionControl(chatId);
      if (queue.entries.length > 0) {
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
    const entry = this.options.registry.getChat(chatId);
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

    this.options.ledger.closeProducer(chatId);
    let staging: TranscriptView | null = null;
    let replacement: TranscriptView;
    try {
      const prefix = frozenConversationDrafts(
        this.options.ledger.currentRows(chatId)
          .filter((row) => row.ordinal < current.contentStartOrdinal),
      );
      const sessionDraft: LedgerRowDraft = {
        kind: 'session',
        at: session.at,
        detail: session.detail,
        providerMeta: null,
      };
      const imported = await this.#importCurrent(
        chatId,
        entry,
        integration,
        session.detail,
        signal,
      );
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
      if (staging) this.options.ledger.discardStagingView(chatId, staging.viewId);
      this.options.reopenProducer(chatId);
      throw error;
    }
    this.options.reopenProducer(chatId);
    return replacement;
  }

  async #importCurrent(
    chatId: string,
    entry: AgentChatEntry,
    integration: AgentIntegration,
    session: Extract<LedgerRow, { readonly kind: 'session' }>['detail'],
    signal: AbortSignal,
  ): Promise<LedgerRowDraft[]> {
    const imported: Array<{
      readonly message: ChatMessage;
      readonly providerMeta: LedgerRowDraft['providerMeta'];
    }> = [];
    const chat = toAgentChatReference(
      integration,
      chatId,
      {
        ...entry,
        agentSessionId: session.agentSessionId,
        nativeSession: session.nativeSession,
        nativeSeedReceipt: session.nativeSeedReceipt,
      },
      this.options.getCarryOverRevision(entry),
    );
    for await (const batch of integration.nativeHistoryImport!.load({ chat, signal })) {
      signal.throwIfAborted();
      for (const row of batch) {
        imported.push({ message: row.message, providerMeta: row.providerMeta ?? null });
      }
    }
    const sanitized = sanitizeRecordedCarriedContext({
      messages: imported.map((row) => row.message),
      receipt: session.nativeSeedReceipt,
      agentSessionId: session.agentSessionId,
    });
    if (sanitized.kind === 'mismatch') {
      throw new DomainError(
        'CONTEXT_ENVELOPE_MISMATCH',
        'The native transcript seed does not match this chat.',
        422,
        false,
      );
    }
    return sanitized.messages.flatMap((message, index) => importedDraft(
      message,
      imported[index]!.providerMeta,
      this.#now,
    ));
  }
}

function importedDraft(
  message: ChatMessage,
  providerMeta: LedgerRowDraft['providerMeta'],
  now: () => string,
): readonly LedgerRowDraft[] {
  if (message.type === 'permission-request'
      || message.type === 'permission-resolved'
      || message.type === 'permission-cancelled'
      || message.type === 'permission-expired') return [];
  const at = message.timestamp || now();
  if (message.type === 'user-message') {
    return [{
      kind: 'user-input',
      at,
      detail: {
        clientMessageId: null,
        message,
        attachments: (message.images ?? []).map((image) => ({
          kind: 'image',
          data: image.data,
          name: image.name || null,
          mimeType: image.mimeType ?? 'application/octet-stream',
        })),
        steer: false,
      },
      providerMeta,
    }];
  }
  return [{ kind: 'provider-row', at, message, providerMeta }];
}
