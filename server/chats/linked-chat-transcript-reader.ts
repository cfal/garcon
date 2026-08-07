import type { ChatMessage } from '../../common/chat-types.js';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import { DomainError } from '../lib/domain-error.js';
import { transcriptRevision } from '../lib/transcript-revision.js';
import type { CarryOverTranscriptStore } from './carryover-transcript-store.js';
import type { NativeTranscriptWindow } from './chat-message-reader.js';
import type {
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  NativeSnapshotReconciliation,
} from './chat-view-store.js';
import { serializeCompositeTranscriptRevision } from './composite-transcript-revision.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';

export class LinkedChatTranscriptReader {
  constructor(private readonly deps: {
    readonly registry: IChatRegistry;
    readonly agents: {
      loadTranscriptSnapshot(
        session: ChatRegistryEntry | null,
        chatId?: string,
        signal?: AbortSignal,
      ): Promise<{ readonly messages: readonly ChatMessage[]; readonly revision: string }>;
      loadMessagePage(
        session: ChatRegistryEntry | null,
        limit: number,
        offset: number,
        chatId?: string,
        signal?: AbortSignal,
      ): Promise<{
        readonly messages: readonly ChatMessage[];
        readonly total: number;
        readonly hasMore: boolean;
        readonly offset: number;
        readonly limit: number;
        readonly revision: string;
      } | null>;
    };
    readonly carryOver: CarryOverTranscriptStore;
  }) {}

  async loadCurrentNativeMessages(chatId: string): Promise<ChatMessage[]> {
    const entry = this.#captureEntry(chatId);
    if (!entry) return [];
    const native = await this.#loadCurrentNativeSnapshot(entry, chatId);
    this.#assertEntryUnchanged(chatId, entry);
    return native.messages;
  }

  async loadCurrentNativeSnapshot(chatId: string) {
    const entry = this.#captureEntry(chatId);
    if (!entry) return { messages: [] as ChatMessage[], revision: transcriptRevision([]) };
    const native = await this.#loadCurrentNativeSnapshot(entry, chatId);
    this.#assertEntryUnchanged(chatId, entry);
    return native;
  }

  async loadNativeWindow(input: {
    readonly chatId: string;
    readonly limit: number;
    readonly offsetFromNewest?: number;
    readonly signal: AbortSignal;
  }): Promise<NativeTranscriptWindow> {
    const entry = this.#captureEntry(input.chatId);
    const limit = Math.max(0, Math.trunc(input.limit));
    const offset = Math.max(0, Math.trunc(input.offsetFromNewest ?? 0));
    input.signal.throwIfAborted();
    if (!entry) {
      return {
        messages: [],
        totalNativeMessages: 0,
        offsetFromNewest: offset,
        nativeRevision: transcriptRevision([]),
      };
    }
    const page = await this.deps.agents.loadMessagePage(
      entry,
      Math.max(1, limit),
      offset,
      input.chatId,
      input.signal,
    );
    if (page) {
      assertNativePage(page);
      const pageEnd = Math.max(0, page.total - page.offset);
      const reachesNativeStart = pageEnd - page.messages.length === 0;
      const messages = limit === 0
        ? []
        : reachesNativeStart
        ? this.#sanitizeNativeMessages(entry, page.messages)
        : [...page.messages];
      this.#assertEntryUnchanged(input.chatId, entry);
      return {
        messages,
        totalNativeMessages: page.total,
        offsetFromNewest: page.offset,
        nativeRevision: page.revision,
      };
    }
    const native = await this.#loadCurrentNativeSnapshot(
      entry,
      input.chatId,
      input.signal,
    );
    this.#assertEntryUnchanged(input.chatId, entry);
    const end = Math.max(0, native.messages.length - offset);
    const start = Math.max(0, end - limit);
    return {
      messages: native.messages.slice(start, end),
      totalNativeMessages: native.messages.length,
      offsetFromNewest: offset,
      nativeRevision: native.revision,
    };
  }

  async loadNativeReconciliation(chatId: string): Promise<NativeSnapshotReconciliation> {
    const entry = this.#requireReadableEntry(chatId);
    if (!entry) {
      const snapshot = emptySnapshot();
      return {
        messages: [],
        compositeRevision: snapshot.compositeRevision,
        carryOverRevision: snapshot.carryOverRevision,
        agentOwnershipEpoch: snapshot.agentOwnershipEpoch,
        archivedLogicalCount: 0,
        nativePrefixDigest: snapshot.nativePrefixDigest,
      };
    }
    const [archivedLogicalCount, native] = await Promise.all([
      this.deps.carryOver.logicalMessageCount(entry.carryOverHeadId),
      this.#loadCurrentNativeSnapshot(entry, chatId),
    ]);
    this.#assertEntryUnchanged(chatId, entry);
    const carryOverRevision = this.deps.carryOver.revision(entry.carryOverHeadId);
    return {
      messages: native.messages,
      compositeRevision: serializeCompositeTranscriptRevision({
        carryOver: carryOverRevision,
        native: native.revision,
        agentOwnershipEpoch: entry.agentOwnershipEpoch,
      }),
      carryOverRevision,
      agentOwnershipEpoch: entry.agentOwnershipEpoch,
      archivedLogicalCount,
      nativePrefixDigest: transcriptRevision(native.messages),
    };
  }

  async #loadCurrentNativeSnapshot(
    entry: ChatRegistryEntry,
    chatId: string,
    signal: AbortSignal = new AbortController().signal,
  ) {
    const native = await this.deps.agents.loadTranscriptSnapshot(entry, chatId, signal);
    return {
      messages: this.#sanitizeNativeMessages(entry, native.messages),
      revision: native.revision,
    };
  }

  #sanitizeNativeMessages(
    entry: ChatRegistryEntry,
    messages: readonly ChatMessage[],
  ): ChatMessage[] {
    const sanitized = sanitizeRecordedCarriedContext({
      messages,
      receipt: entry.nativeSeedReceipt,
      agentSessionId: entry.agentSessionId,
    });
    if (sanitized.kind === 'mismatch') {
      throw new DomainError(
        'CONTEXT_ENVELOPE_MISMATCH',
        'The recorded carried-context envelope does not match this native session.',
        422,
        false,
      );
    }
    return [...sanitized.messages];
  }

  async loadAll(chatId: string): Promise<ChatTranscriptSnapshot> {
    const entry = this.#requireReadableEntry(chatId);
    if (!entry) return emptySnapshot();
    const [archived, native] = await Promise.all([
      this.deps.carryOver.loadAll(entry.carryOverHeadId, {
        agentId: entry.agentId,
        model: entry.model,
      }),
      this.#loadCurrentNativeSnapshot(entry, chatId),
    ]);
    this.#assertEntryUnchanged(chatId, entry);
    return this.#snapshot(entry, archived, native.messages, native.revision);
  }

  async loadPage(chatId: string, limit: number, offset: number): Promise<ChatHistoryPage | null> {
    const entry = this.#requireReadableEntry(chatId);
    if (!entry) return null;
    const boundedLimit = Math.max(0, Math.trunc(limit));
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const [archivedCount, native] = await Promise.all([
      this.deps.carryOver.logicalMessageCount(entry.carryOverHeadId),
      this.loadNativeWindow({
        chatId,
        limit: boundedLimit,
        offsetFromNewest: boundedOffset,
        signal: new AbortController().signal,
      }),
    ]);
    this.#assertEntryUnchanged(chatId, entry);
    const total = archivedCount + native.totalNativeMessages;
    const end = Math.max(0, total - boundedOffset);
    const start = Math.max(0, end - boundedLimit);
    const messages: ChatMessage[] = [];
    const archivedEnd = Math.min(end, archivedCount);
    if (start < archivedEnd) {
      const page = await this.deps.carryOver.loadPage({
        headId: entry.carryOverHeadId,
        current: { agentId: entry.agentId, model: entry.model },
        offset: start,
        limit: archivedEnd - start,
      });
      messages.push(...page.messages);
    }
    messages.push(...native.messages);
    this.#assertEntryUnchanged(chatId, entry);
    const carryOverRevision = this.deps.carryOver.revision(entry.carryOverHeadId);
    return {
      messages,
      total,
      hasMore: start > 0,
      offset: boundedOffset,
      limit: boundedLimit,
      compositeRevision: serializeCompositeTranscriptRevision({
        carryOver: carryOverRevision,
        native: native.nativeRevision,
        agentOwnershipEpoch: entry.agentOwnershipEpoch,
      }),
      carryOverRevision,
      agentOwnershipEpoch: entry.agentOwnershipEpoch,
      archivedLogicalCount: archivedCount,
    };
  }

  async archivedMessageCount(chatId: string): Promise<number> {
    const entry = this.#requireReadableEntry(chatId);
    return entry
      ? this.deps.carryOver.logicalMessageCount(entry.carryOverHeadId)
      : 0;
  }

  #requireReadableEntry(chatId: string) {
    const entry = this.#captureEntry(chatId);
    if (entry?.carryOverMigrationQuarantine) {
      throw new DomainError(
        'CARRYOVER_HISTORY_UNAVAILABLE',
        'Archived history for this chat is unavailable.',
        422,
        false,
      );
    }
    return entry;
  }

  #captureEntry(chatId: string): ChatRegistryEntry | null {
    const entry = this.deps.registry.getChat(chatId);
    return entry ? { ...entry } : null;
  }

  #snapshot(
    entry: ChatRegistryEntry,
    archived: readonly ChatMessage[],
    native: ChatMessage[],
    nativeRevision: string,
  ): ChatTranscriptSnapshot {
    const carryOverRevision = this.deps.carryOver.revision(entry.carryOverHeadId);
    return {
      messages: [...archived, ...native],
      nativeMessages: native,
      compositeRevision: serializeCompositeTranscriptRevision({
        carryOver: carryOverRevision,
        native: nativeRevision,
        agentOwnershipEpoch: entry.agentOwnershipEpoch,
      }),
      carryOverRevision,
      agentOwnershipEpoch: entry.agentOwnershipEpoch,
      archivedLogicalCount: archived.length,
      nativePrefixDigest: transcriptRevision(native),
    };
  }

  #assertEntryUnchanged(chatId: string, expected: ChatRegistryEntry): void {
    const current = this.deps.registry.getChat(chatId);
    if (!current
        || current.agentOwnershipEpoch !== expected.agentOwnershipEpoch
        || current.agentSessionId !== expected.agentSessionId
        || current.carryOverHeadId !== expected.carryOverHeadId) {
      throw new DomainError(
        'SOURCE_REVISION_CHANGED',
        'Chat ownership changed while its transcript was loading.',
        409,
        true,
      );
    }
  }
}

function assertNativePage(page: {
  readonly messages: readonly ChatMessage[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly revision: string;
}): void {
  const end = Math.max(0, page.total - page.offset);
  if (!Number.isSafeInteger(page.total) || page.total < 0
      || !Number.isSafeInteger(page.offset) || page.offset < 0
      || !Number.isSafeInteger(page.limit) || page.limit < 0
      || page.messages.length > page.limit
      || page.messages.length > Math.max(0, end)
      || typeof page.revision !== 'string') {
    throw new DomainError(
      'TRANSCRIPT_UNAVAILABLE',
      'The native transcript page metadata is invalid.',
      422,
      true,
    );
  }
}

function emptySnapshot(): ChatTranscriptSnapshot {
  const nativeRevision = transcriptRevision([]);
  return {
    messages: [],
    nativeMessages: [],
    compositeRevision: serializeCompositeTranscriptRevision({
      carryOver: 'carry-v1:0',
      native: nativeRevision,
      agentOwnershipEpoch: 'missing',
    }),
    carryOverRevision: 'carry-v1:0',
    agentOwnershipEpoch: 'missing',
    archivedLogicalCount: 0,
    nativePrefixDigest: nativeRevision,
  };
}
