import { isDeepStrictEqual } from 'node:util';
import {
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  UserMessage,
  type ChatMessage,
} from '../../common/chat-types.js';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { JsonObject } from '../../common/json.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import type { IntegrationRegistry } from '../agents/integration-registry.js';
import type { LedgerRowDraft, TranscriptView } from './contracts.js';
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
    const current = this.options.ledger.currentView(chatId);
    if (current) {
      this.#repairSessionCache(chatId);
      return current;
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
      let prefix: readonly ChatMessage[] = [];
      try {
        prefix = await this.options.loadFrozenPrefix(chatId, entry, signal);
      } catch {
        // Legacy projection failures fall through to the provider-native import,
        // then to an empty ledger when neither source is readable.
      }
      signal.throwIfAborted();
      const current = await this.#loadCurrent(chatId, entry, integration, signal);
      signal.throwIfAborted();
      const latest = this.options.registry.getChat(chatId);
      if (!latest || latest.agentOwnershipEpoch !== entry.agentOwnershipEpoch) {
        throw new TypeError(`Chat ownership changed while adopting ${chatId}`);
      }

      const prefixRows = frozenRows(prefix, this.#now);
      const contentStartOrdinal = prefixRows.length + 1;
      const session = sessionDraft(entry, this.#now());
      const view = this.options.ledger.initializeChat(
        chatId,
        [...prefixRows, ...(session ? [session] : []), ...adoptedRows(current, this.#now)],
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

  async #loadCurrent(
    chatId: string,
    entry: AgentChatEntry,
    integration: AgentIntegration,
    signal: AbortSignal,
  ): Promise<readonly AdoptionRow[]> {
    if (!integration.nativeHistoryImport) return [];
    try {
      const rows: AdoptionRow[] = [];
      const chat = toAgentChatReference(
        integration,
        chatId,
        entry,
        this.options.getCarryOverRevision(entry),
      );
      for await (const batch of integration.nativeHistoryImport.load({ chat, signal })) {
        for (const row of batch) {
          rows.push({ message: row.message, providerMeta: row.providerMeta ?? null });
        }
      }
      return sanitizeCurrent(rows, entry);
    } catch {
      return [];
    }
  }
}

export function frozenRows(
  messages: readonly ChatMessage[],
  now: () => string = () => new Date().toISOString(),
): readonly LedgerRowDraft[] {
  return adoptedRows(
    messages.map((message) => ({ message, providerMeta: null })),
    now,
    true,
  );
}

interface AdoptionRow {
  readonly message: ChatMessage;
  readonly providerMeta: JsonObject | null;
}

function adoptedRows(
  rows: readonly AdoptionRow[],
  now: () => string,
  preserveClientMessageId = false,
): readonly LedgerRowDraft[] {
  return rows.flatMap(({ message, providerMeta }): LedgerRowDraft[] => {
    if (message instanceof PermissionRequestMessage
        || message instanceof PermissionResolvedMessage
        || message instanceof PermissionCancelledMessage) {
      return [];
    }
    const at = message.timestamp || now();
    if (message instanceof UserMessage) {
      return [{
        kind: 'user-input',
        at,
        detail: {
          clientMessageId: preserveClientMessageId
            ? message.metadata?.upstreamRequestId ?? null
            : null,
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
  });
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
  rows: readonly AdoptionRow[],
  entry: AgentChatEntry,
): readonly AdoptionRow[] {
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
