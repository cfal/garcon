import type { ChatMessage } from '../../common/chat-types.js';
import type { AgentProjectionState } from '@garcon/server-agent-interface';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import { DomainError } from '../lib/domain-error.js';
import { transcriptRevision } from '../lib/transcript-revision.js';
import type { CarryOverTranscriptStore } from './carryover-transcript-store.js';
import type { NativeTranscriptWindow } from './chat-message-reader.js';
import type {
  ChatHistoryPage,
  ChatTranscriptSnapshot,
} from './chat-view-store.js';
import { serializeCompositeTranscriptRevision } from './composite-transcript-revision.js';
import type { ChatRegistryEntry, IChatRegistry } from './store.js';

export class OrderedChatTranscriptReader {
  constructor(private readonly deps: {
    readonly registry: IChatRegistry;
    readonly agents: {
      loadTranscriptSnapshot(
        session: ChatRegistryEntry | null,
        chatId?: string,
        signal?: AbortSignal,
      ): Promise<{
        readonly messages: readonly ChatMessage[];
        readonly revision: string;
        readonly projectionState: AgentProjectionState | null;
      }>;
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
        readonly projectionState: AgentProjectionState;
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
    if (!entry) {
      return {
        messages: [] as ChatMessage[],
        revision: transcriptRevision([]),
        projectionState: null,
      };
    }
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
        kind: 'snapshot',
        messages: [],
        totalNativeMessages: 0,
        offsetFromNewest: 0,
        nativeRevision: transcriptRevision([]),
        projectionState: null,
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
        kind: 'page',
        messages,
        totalNativeMessages: page.total,
        offsetFromNewest: page.offset,
        nativeRevision: page.revision,
        projectionState: page.projectionState,
      };
    }
    const native = await this.#loadCurrentNativeSnapshot(
      entry,
      input.chatId,
      input.signal,
    );
    this.#assertEntryUnchanged(input.chatId, entry);
    return {
      kind: 'snapshot',
      messages: native.messages,
      totalNativeMessages: native.messages.length,
      offsetFromNewest: 0,
      nativeRevision: native.revision,
      projectionState: native.projectionState,
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
      projectionState: native.projectionState,
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
      this.deps.carryOver.loadAll(entry.carryOverSegments),
      this.#loadCurrentNativeSnapshot(entry, chatId),
    ]);
    this.#assertEntryUnchanged(chatId, entry);
    return this.#snapshot(
      entry,
      archived,
      native.messages,
      native.revision,
      native.projectionState,
    );
  }

  async composeProjectionSnapshot(
    chatId: string,
    currentMessages: readonly ChatMessage[],
    currentRevision: string,
    projectionState: AgentProjectionState,
  ): Promise<ChatTranscriptSnapshot> {
    const entry = this.#requireReadableEntry(chatId);
    if (!entry) return emptySnapshot();
    const archived = await this.deps.carryOver.loadAll(entry.carryOverSegments);
    this.#assertEntryUnchanged(chatId, entry);
    return this.#snapshot(
      entry,
      archived,
      [...currentMessages],
      currentRevision,
      projectionState,
    );
  }

  async loadPage(chatId: string, limit: number, offset: number): Promise<ChatHistoryPage | null> {
    const entry = this.#requireReadableEntry(chatId);
    if (!entry) return null;
    const boundedLimit = Math.max(0, Math.trunc(limit));
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const [archivedCount, native] = await Promise.all([
      this.deps.carryOver.logicalMessageCount(entry.carryOverSegments),
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
    const nativeMessages = native.kind === 'snapshot'
      ? sliceFromNewest(native.messages, boundedLimit, boundedOffset)
      : native.messages;
    const messages: ChatMessage[] = [];
    const archivedEnd = Math.min(end, archivedCount);
    if (start < archivedEnd) {
      const page = await this.deps.carryOver.loadPage({
        refs: entry.carryOverSegments,
        offset: start,
        limit: archivedEnd - start,
      });
      messages.push(...page.messages);
    }
    messages.push(...nativeMessages);
    this.#assertEntryUnchanged(chatId, entry);
    const carryOverRevision = this.deps.carryOver.revision(
      entry.carryOverSegments,
      entry.carryOverMigrationQuarantine,
    );
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
      projectionState: native.projectionState,
    };
  }

  async archivedMessageCount(chatId: string): Promise<number> {
    const entry = this.#requireReadableEntry(chatId);
    return entry
      ? this.deps.carryOver.logicalMessageCount(entry.carryOverSegments)
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
    projectionState: AgentProjectionState | null,
  ): ChatTranscriptSnapshot {
    const carryOverRevision = this.deps.carryOver.revision(
      entry.carryOverSegments,
      entry.carryOverMigrationQuarantine,
    );
    return {
      messages: [...archived, ...native],
      compositeRevision: serializeCompositeTranscriptRevision({
        carryOver: carryOverRevision,
        native: nativeRevision,
        agentOwnershipEpoch: entry.agentOwnershipEpoch,
      }),
      carryOverRevision,
      agentOwnershipEpoch: entry.agentOwnershipEpoch,
      archivedLogicalCount: archived.length,
      projectionState,
    };
  }

  #assertEntryUnchanged(chatId: string, expected: ChatRegistryEntry): void {
    const current = this.deps.registry.getChat(chatId);
    if (!current
        || current.agentOwnershipEpoch !== expected.agentOwnershipEpoch
        || current.agentSessionId !== expected.agentSessionId
        || this.deps.carryOver.revision(
          current.carryOverSegments,
          current.carryOverMigrationQuarantine,
        ) !== this.deps.carryOver.revision(
          expected.carryOverSegments,
          expected.carryOverMigrationQuarantine,
        )) {
      throw new DomainError(
        'SOURCE_REVISION_CHANGED',
        'Chat ownership changed while its transcript was loading.',
        409,
        true,
      );
    }
  }
}

function sliceFromNewest(
  messages: readonly ChatMessage[],
  limit: number,
  offsetFromNewest: number,
): readonly ChatMessage[] {
  const end = Math.max(0, messages.length - offsetFromNewest);
  const start = Math.max(0, end - limit);
  return messages.slice(start, end);
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
  return {
    messages: [],
    compositeRevision: serializeCompositeTranscriptRevision({
      carryOver: 'carry-v1:0',
      native: transcriptRevision([]),
      agentOwnershipEpoch: 'missing',
    }),
    carryOverRevision: 'carry-v1:0',
    agentOwnershipEpoch: 'missing',
    archivedLogicalCount: 0,
    projectionState: null,
  };
}
