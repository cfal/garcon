import { isDeepStrictEqual } from 'node:util';
import {
  AgentIntegrationError,
  type AgentIntegration,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import type { ChatMessage } from '../../common/chat-types.js';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import type { IntegrationRegistry } from '../agents/integration-registry.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { LedgerRowDraft, TranscriptView } from './contracts.js';
import { frozenDrafts, importedDrafts, type ImportedRow } from './imported-drafts.js';
import { TranscriptLedgerService } from './service.js';

export interface TranscriptAdoptionOptions {
  readonly ledger: TranscriptLedgerService;
  readonly registry: IChatRegistry;
  readonly integrations: IntegrationRegistry;
  readonly getCarryOverRevision: (entry: AgentChatEntry) => string;
  readonly loadFrozenPrefix: (
    chatId: string,
    entry: AgentChatEntry,
    signal: AbortSignal,
  ) => Promise<readonly ChatMessage[]>;
  readonly logger?: Pick<AgentLogger, 'warn'>;
  readonly now?: () => string;
}

export class TranscriptAdoptionService {
  readonly #locks = new KeyedPromiseLock();
  readonly #now: () => string;

  constructor(private readonly options: TranscriptAdoptionOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async ensure(
    chatId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TranscriptView> {
    const currentView = this.options.ledger.currentView(chatId);
    if (currentView) {
      this.#repairSessionCache(chatId);
      return currentView;
    }
    return this.#locks.runExclusive(chatId, async () => {
      const reopened = this.options.ledger.currentView(chatId);
      if (reopened) {
        this.#repairSessionCache(chatId);
        return reopened;
      }
      signal.throwIfAborted();
      const entry = this.options.registry.getChat(chatId);
      if (!entry) throw new TypeError(`Cannot adopt transcript for unknown chat ${chatId}`);
      const integration = this.options.integrations.require(entry.agentId);
      const prefix = entry.carryOverMigrationQuarantine
        ? []
        : await this.#loadPrefix(chatId, entry, signal);
      signal.throwIfAborted();
      const legacyRows = await this.#loadLegacy(chatId, entry, integration, signal);
      signal.throwIfAborted();
      const latest = this.options.registry.getChat(chatId);
      if (!latest || latest.agentOwnershipEpoch !== entry.agentOwnershipEpoch) {
        throw new TypeError(`Chat ownership changed while adopting ${chatId}`);
      }

      const prefixRows = entry.carryOverMigrationQuarantine
        ? [quarantineDraft(entry.carryOverMigrationQuarantine, this.#now())]
        : frozenDrafts(prefix, this.#now);
      const contentStartOrdinal = prefixRows.length + 1;
      const session = sessionDraft(entry, this.#now());
      const view = this.options.ledger.initializeChat(
        chatId,
        [...prefixRows, ...(session ? [session] : []), ...importedDrafts(legacyRows, this.#now)],
        contentStartOrdinal,
      );
      this.#repairSessionCache(chatId);
      return view;
    });
  }

  #repairSessionCache(chatId: string): void {
    const entry = this.options.registry.getChat(chatId);
    if (!entry) return;
    const session = this.options.ledger.currentSession(chatId)?.detail ?? null;
    const patch = {
      agentSessionId: session?.agentSessionId ?? null,
      nativeSession: session?.nativeSession ?? null,
      nativeSeedReceipt: session?.nativeSeedReceipt ?? null,
    };
    if (
      entry.agentSessionId === patch.agentSessionId
      && isDeepStrictEqual(entry.nativeSession ?? null, patch.nativeSession)
      && isDeepStrictEqual(entry.nativeSeedReceipt ?? null, patch.nativeSeedReceipt)
    ) return;
    this.options.registry.updateChat(chatId, patch);
  }

  async #loadPrefix(
    chatId: string,
    entry: AgentChatEntry,
    signal: AbortSignal,
  ): Promise<readonly ChatMessage[]> {
    try {
      return await this.options.loadFrozenPrefix(chatId, entry, signal);
    } catch (error) {
      this.#throwSourceFailure(chatId, entry.agentId, 'frozen-prefix', error, signal);
    }
  }

  async #loadLegacy(
    chatId: string,
    entry: AgentChatEntry,
    integration: AgentIntegration,
    signal: AbortSignal,
  ): Promise<readonly ImportedRow[]> {
    if (!integration.legacyHistoryImport) return [];
    try {
      const rows: ImportedRow[] = [];
      const chat = toAgentChatReference(
        integration,
        chatId,
        entry,
        this.options.getCarryOverRevision(entry),
      );
      for await (const batch of integration.legacyHistoryImport.load({ chat, signal })) {
        signal.throwIfAborted();
        for (const row of batch) {
          rows.push({ message: row.message, providerMeta: row.providerMeta ?? null });
        }
      }
      return sanitizeCurrent(rows, entry);
    } catch (error) {
      this.#throwSourceFailure(chatId, entry.agentId, 'legacy-history-import', error, signal);
    }
  }

  #throwSourceFailure(
    chatId: string,
    provider: string,
    phase: 'frozen-prefix' | 'legacy-history-import',
    error: unknown,
    signal: AbortSignal,
  ): never {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    this.options.logger?.warn('Transcript adoption source failed.', {
      chatId,
      provider,
      phase,
      reason: sourceFailureReason(error),
    });
    throw new AgentIntegrationError(
      'TRANSCRIPT_UNAVAILABLE',
      'Transcript adoption source failed',
      true,
      { provider, phase },
      { cause: error },
    );
  }
}

function quarantineDraft(
  quarantine: NonNullable<AgentChatEntry['carryOverMigrationQuarantine']>,
  at: string,
): LedgerRowDraft {
  return {
    kind: 'notice',
    at,
    message: `Some earlier chat history could not be migrated. Quarantine reference: ${quarantine.artifactId}.`,
    detail: {
      type: 'carryover-migration-quarantine',
      artifactId: quarantine.artifactId,
      errorCode: quarantine.errorCode,
    },
    providerMeta: null,
  };
}

function sourceFailureReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return error instanceof Error ? error.name : typeof error;
}

function sessionDraft(entry: AgentChatEntry, at: string): LedgerRowDraft | null {
  if (!entry.agentSessionId) return null;
  return {
    kind: 'session',
    at,
    detail: {
      agentSessionId: entry.agentSessionId,
      nativeSession: entry.nativeSession ?? null,
      nativeSeedReceipt: entry.nativeSeedReceipt ?? null,
    },
    providerMeta: null,
  };
}

function sanitizeCurrent(
  rows: readonly ImportedRow[],
  entry: AgentChatEntry,
): readonly ImportedRow[] {
  const sanitized = sanitizeRecordedCarriedContext({
    messages: rows.map((row) => row.message),
    receipt: entry.nativeSeedReceipt ?? null,
    agentSessionId: entry.agentSessionId ?? null,
  });
  if (sanitized.kind === 'mismatch') {
    throw new TypeError('Native transcript seed receipt does not match the current session');
  }
  return rows.map((row, index) => ({ ...row, message: sanitized.messages[index] }));
}
