import crypto from 'crypto';
import { ErrorMessage, UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatReplayResult, ChatViewMessage, ChatViewPage } from '../../common/chat-view.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import {
  OrderedTranscriptDigest,
  orderedTranscriptDigest,
  transcriptRevision,
} from '../lib/transcript-revision.js';
import {
  exactMessageIdentityKeys,
  preserveRetainedUserIdentities,
  retainedMessageMatchesNative,
  userDeliveryPayloadsAreCompatible,
} from './chat-message-reconciliation.js';
import {
  type ChatViewGenerationTransition as GenerationTransition,
  type MutableChatView as ChatView,
  type NativeSnapshotReconciliation,
  persistenceMatches,
  reconcileNativeSnapshotView,
} from './chat-view-native-reconciliation.js';
import {
  assertValidChatMessage,
  lowerBoundBySeq,
  revisionsMatch,
} from './chat-view-sequence.js';
import type {
  AppendedChatViewMessages,
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  ChatViewLoader,
} from './chat-view-contracts.js';
import { ChatRunningError } from './errors.js';

export { lowerBoundBySeq } from './chat-view-sequence.js';
export type {
  AppendedChatViewMessages,
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  ChatViewLoader,
} from './chat-view-contracts.js';

const logger = createLogger('chat-view');

export interface ChatViewStoreOptions {
  replayLimit?: number;
  cacheLimit?: number;
  messageLimit?: number;
  staleNonActiveMs?: number;
  recentViewRetentionCount?: number;
  now?: () => number;
}

export type { NativeSnapshotReconciliation } from './chat-view-native-reconciliation.js';

type MissingHistoryRequest =
  | { kind: 'page'; limit: number; offset: number }
  | { kind: 'full' };

const REPLAY_LIMIT = 2048;
const CACHE_LIMIT = 100;
const MESSAGE_LIMIT = 20_000;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const RECENT_VIEW_RETENTION_COUNT = 10;

type PruneEvictionReason = 'stale' | 'view-capacity' | 'message-capacity';
export type ChatViewReplacementReason = Extract<
  import('./chat-view-native-reconciliation.js').ChatViewGenerationReason,
  'native-replacement' | 'manual-reload' | 'process-error'
>;

export class ChatViewStore {
  #views = new Map<string, ChatView>();
  #locks = new KeyedPromiseLock();
  #fences = new Map<string, number>();
  #inFlightChats = new Set<string>();
  #replayLimit: number;
  #cacheLimit: number;
  #messageLimit: number;
  #staleNonActiveMs: number;
  #recentViewRetentionCount: number;
  #lastAccessOrder = 0;
  #now: () => number;
  #isChatActive: (chatId: string) => boolean;

  constructor(
    isChatActive: (chatId: string) => boolean,
    options: ChatViewStoreOptions = {},
  ) {
    this.#isChatActive = isChatActive;
    this.#replayLimit = options.replayLimit ?? REPLAY_LIMIT;
    this.#cacheLimit = options.cacheLimit ?? CACHE_LIMIT;
    this.#messageLimit = Math.max(1, Math.floor(options.messageLimit ?? MESSAGE_LIMIT));
    this.#staleNonActiveMs = options.staleNonActiveMs ?? STALE_NON_ACTIVE_MS;
    this.#recentViewRetentionCount = Math.max(
      0,
      Math.floor(options.recentViewRetentionCount ?? RECENT_VIEW_RETENTION_COUNT),
    );
    this.#now = options.now ?? (() => Date.now());
  }

  captureFence(chatId: string): number {
    return this.#fences.get(chatId) ?? 0;
  }

  invalidateFence(chatId: string): number {
    const next = this.captureFence(chatId) + 1;
    this.#fences.set(chatId, next);
    const view = this.#views.get(chatId);
    if (view) view.streamFence = next;
    return next;
  }

  getCursor(chatId: string): { generationId: string; lastSeq: number } | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    this.#touch(view);
    return { generationId: view.generationId, lastSeq: view.lastSeq };
  }

  getLoadedMessages(chatId: string): ChatMessage[] | null {
    const view = this.#views.get(chatId);
    if (!view?.complete) return null;
    this.#touch(view);
    return view.messages.map((entry) => entry.message);
  }

  // Highest seq the current generation reads back from the provider-native transcript. Live
  // messages appended during a turn sit above it and have no native counterpart yet, so callers
  // that translate a client seq into a native transcript position must not cross this boundary.
  getNativeHistoryLastSeq(chatId: string): number | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    this.#touch(view);
    return view.historyLastSeq;
  }

  getRetainedHistoryMessages(chatId: string): ChatMessage[] | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    this.#touch(view);
    return view.messages
      .filter((entry) => entry.seq <= view.historyLastSeq)
      .map((entry) => entry.message);
  }

  async getOrCreateMessages(
    chatId: string,
    loadSnapshot: () => Promise<ChatTranscriptSnapshot>,
  ): Promise<ChatMessage[]> {
    return this.#withChat(chatId, async () => {
      const loaded = await this.#loadFullView(chatId, loadSnapshot);
      return loaded.messages;
    });
  }

  async reconcileNativeSnapshot(
    chatId: string,
    input: NativeSnapshotReconciliation,
  ): Promise<void> {
    await this.#withChat(chatId, async () => {
      if (this.#isChatActive(chatId)) throw new ChatRunningError(chatId);
      this.#reconcileNativeView(chatId, input);
    });
  }

  async reconcileFullSnapshot(
    chatId: string,
    input: ChatTranscriptSnapshot,
  ): Promise<void> {
    await this.#withChat(chatId, async () => {
      if (this.#isChatActive(chatId)) throw new ChatRunningError(chatId);
      this.#reconcileFullView(chatId, input);
    });
  }

  async getOrCreatePage(
    chatId: string,
    loader: ChatViewLoader,
    limit: number,
    beforeSeq?: number,
  ): Promise<ChatViewPage> {
    return this.#withChat(chatId, async () => {
      let view = this.#views.get(chatId);
      if (!view) {
        const initialPage = await loader.loadPage?.(limit, 0);
        if (initialPage) {
          view = this.#createGenerationFromPage(chatId, initialPage);
          this.#views.set(chatId, view);
          if (initialPage.messages.length > view.messages.length) {
            return this.#pageFromHistoryPage(view, initialPage);
          }
        } else {
          const snapshot = await loader.loadAll();
          const reconciled = this.#reconcileFullView(chatId, snapshot);
          view = reconciled.view;
          if (snapshot.messages.length > view.messages.length) {
            return this.#pageFromFullMessages(view, snapshot.messages, limit, beforeSeq);
          }
        }
      }

      if (!view.loadedFromFullHistory && view.historyLastSeq === 0) {
        const snapshot = await loader.loadAll();
        const reconciled = this.#reconcileFullView(chatId, snapshot);
        view = reconciled.view;
        if (reconciled.messages.length > view.messages.length) {
          return this.#pageFromFullMessages(
            view,
            reconciled.messages,
            limit,
            beforeSeq,
          );
        }
      }

      const missingHistory = this.#missingHistoryRequest(view, limit, beforeSeq);
      if (missingHistory) {
        this.#touch(view);
        if (missingHistory.kind === 'full') {
          const snapshot = await loader.loadAll();
          const reconciled = this.#reconcileFullView(chatId, snapshot);
          return this.#pageFromFullMessages(
            reconciled.view,
            reconciled.messages,
            limit,
            beforeSeq,
          );
        }
        const olderPage = await loader.loadPage?.(
          missingHistory.limit,
          missingHistory.offset,
        );
        if (
          olderPage
          && olderPage.total === view.historyLastSeq
          && revisionsMatch(view.compositeRevision, olderPage.compositeRevision)
        ) {
          const pageEndSeq = olderPage.total - olderPage.offset;
          const oldestRetainedSeq = view.messages[0]?.seq ?? view.historyLastSeq + 1;
          if (pageEndSeq < oldestRetainedSeq - 1) {
            return this.#pageFromHistoryPage(view, olderPage);
          }
          if (view.messages.length + olderPage.messages.length > this.#messageLimit) {
            return this.#pageFromHistoryAndRetained(view, olderPage, limit, beforeSeq);
          }
          this.#mergeHistoryPage(view, olderPage);
        } else {
          const snapshot = await loader.loadAll();
          const reconciled = this.#reconcileFullView(chatId, snapshot);
          return this.#pageFromFullMessages(
            reconciled.view,
            reconciled.messages,
            limit,
            beforeSeq,
          );
        }
      }

      this.#touch(view);
      return this.#readPageFromView(view, limit, beforeSeq);
    });
  }

  async replaceFromNative(
    chatId: string,
    loadSnapshot: () => Promise<ChatTranscriptSnapshot>,
    options: {
      processErrorNotice?: string;
      assertReplacementAllowed?: () => void;
      replacementReason?: ChatViewReplacementReason;
    } = {},
  ): Promise<ChatViewPage> {
    return this.#withChat(chatId, async () => {
      const snapshot = await loadSnapshot();
      options.assertReplacementAllowed?.();
      this.invalidateFence(chatId);
      const view = this.#createGeneration(chatId, snapshot.messages, {
        reason: options.replacementReason ?? 'native-replacement',
        previousGenerationId: this.#views.get(chatId)?.generationId,
        persistence: snapshot,
      });
      const trailingNative = snapshot.messages.at(-1);
      const nativeHasNotice = trailingNative?.type === 'error' && trailingNative.content === options.processErrorNotice;
      if (options.processErrorNotice && !nativeHasNotice) {
        this.#appendToView(view, [new ErrorMessage(new Date().toISOString(), options.processErrorNotice)]);
      }
      this.#views.set(chatId, view);
      return this.#readPageFromView(view, Number.MAX_SAFE_INTEGER);
    });
  }

  async appendAfterEnsuringGeneration(
    chatId: string,
    loader: ChatViewLoader,
    messages: ChatMessage[],
    options: { fence?: number } = {},
  ): Promise<AppendedChatViewMessages> {
    return this.#withChat(chatId, async () => {
      const view = await this.#getOrCreateAppendView(chatId, loader);
      if (options.fence !== undefined && options.fence !== view.streamFence) {
        return { generationId: view.generationId, messages: [], lastSeq: view.lastSeq, skipped: true };
      }
      const appended = this.#appendLiveToView(view, messages);
      return { generationId: view.generationId, messages: appended, lastSeq: view.lastSeq };
    });
  }

  async appendToCurrentOrEmpty(
    chatId: string,
    messages: ChatMessage[],
  ): Promise<AppendedChatViewMessages> {
    return this.#withChat(chatId, async () => {
      let view = this.#views.get(chatId);
      if (!view) {
        view = this.#createGeneration(chatId, [], { reason: 'initial-live-append' });
        this.#views.set(chatId, view);
      }
      const appended = this.#appendLiveToView(view, messages);
      return { generationId: view.generationId, messages: appended, lastSeq: view.lastSeq };
    });
  }

  async appendToCurrentOrProvisional(
    chatId: string,
    messages: ChatMessage[],
  ): Promise<AppendedChatViewMessages> {
    return this.#withChat(chatId, async () => {
      let view = this.#views.get(chatId);
      if (!view) {
        view = this.#createGeneration(chatId, [], { reason: 'initial-provisional-append' });
        view.complete = false;
        view.loadedFromFullHistory = false;
        view.compositeRevision = undefined;
        view.carryOverRevision = undefined;
        view.agentOwnershipEpoch = undefined;
        view.archivedLogicalCount = 0;
        view.nativePrefixDigest = null;
        this.#views.set(chatId, view);
      }
      const appended = this.#appendLiveToView(view, messages);
      return { generationId: view.generationId, messages: appended, lastSeq: view.lastSeq };
    });
  }

  readPage(chatId: string, limit: number, beforeSeq?: number): ChatViewPage | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    return this.#readPageFromView(view, limit, beforeSeq);
  }

  readReplay(chatId: string, generationId: string, afterSeq: number): ChatReplayResult | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    this.#touch(view);
    if (
      view.generationId !== generationId ||
      afterSeq > view.lastSeq ||
      afterSeq < view.retainedStartSeq - 1 ||
      view.lastSeq - afterSeq > this.#replayLimit
    ) {
      return {
        mode: 'snapshot-required',
        generationId: view.generationId,
        messages: [],
        lastSeq: view.lastSeq,
      };
    }
    const start = lowerBoundBySeq(view.messages, afterSeq + 1);
    return {
      mode: 'delta',
      generationId: view.generationId,
      messages: view.messages.slice(start),
      lastSeq: view.lastSeq,
    };
  }

  invalidate(chatId: string): void {
    this.#views.delete(chatId);
  }

  deleteChatView(chatId: string): void {
    this.invalidate(chatId);
    this.#fences.delete(chatId);
  }

  evict(chatId: string): void {
    this.invalidate(chatId);
  }

  prune(): void {
    const now = this.#now();
    const views = [...this.#views.values()].sort(
      (left, right) => left.lastAccessOrder - right.lastAccessOrder,
    );
    const retainedRecentViews = this.#recentViewRetentionCount === 0
      ? []
      : views.slice(-this.#recentViewRetentionCount);
    const retainedRecentChatIds = new Set(
      retainedRecentViews.map((view) => view.chatId),
    );
    for (const view of views) {
      if (
        retainedRecentChatIds.has(view.chatId)
        || this.#isChatActive(view.chatId)
        || this.#inFlightChats.has(view.chatId)
      ) continue;
      const isStale = now - view.lastAccessAt > this.#staleNonActiveMs;
      if (isStale) this.#evictForPrune(view, 'stale', now);
    }

    let cachedMessages = this.#cachedMessageCount();
    for (const view of views) {
      if (
        this.#views.size <= this.#cacheLimit
        && cachedMessages <= this.#messageLimit
      ) {
        break;
      }
      if (
        !this.#views.has(view.chatId)
        || retainedRecentChatIds.has(view.chatId)
        || this.#isChatActive(view.chatId)
        || this.#inFlightChats.has(view.chatId)
      ) continue;
      const reason = this.#views.size > this.#cacheLimit
        ? 'view-capacity'
        : 'message-capacity';
      if (this.#evictForPrune(view, reason, now)) {
        cachedMessages -= view.messages.length;
      }
    }

    // Active views keep their generation but not an exemption from the global
    // message budget. In-flight views remain pinned until their request finishes;
    // the operation's final prune, or the periodic prune, trims them afterward.
    for (const view of views) {
      if (cachedMessages <= this.#messageLimit) break;
      if (!this.#views.has(view.chatId) || this.#inFlightChats.has(view.chatId)) continue;
      const trimCount = Math.min(
        cachedMessages - this.#messageLimit,
        view.messages.length,
      );
      this.#trimOldestMessages(view, trimCount);
      cachedMessages -= trimCount;
      if (trimCount > 0) {
        logger.debug(`view trimmed chat=${view.chatId} generationId=${view.generationId} reason=message-capacity removed=${trimCount} retained=${view.messages.length}`);
      }
    }
  }

  async #withChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(`chat:${chatId}`, async () => {
      this.#inFlightChats.add(chatId);
      const view = this.#views.get(chatId);
      if (view) this.#touch(view);
      try {
        return await fn();
      } finally {
        this.#inFlightChats.delete(chatId);
        this.prune();
      }
    });
  }

  async #getOrCreateAppendView(
    chatId: string,
    loader: ChatViewLoader,
  ): Promise<ChatView> {
    let view = this.#views.get(chatId);
    if (!view) {
      const page = await loader.loadPage?.(
        Math.min(this.#messageLimit, this.#replayLimit),
        0,
      );
      if (page) {
        view = this.#createGenerationFromPage(chatId, page);
        this.#views.set(chatId, view);
        return view;
      }
      return (await this.#loadFullView(chatId, () => loader.loadAll())).view;
    }
    if (view.loadedFromFullHistory) {
      this.#touch(view);
      return view;
    }

    const page = await loader.loadPage?.(
      Math.min(this.#messageLimit, Math.max(this.#replayLimit, view.messages.length)),
      0,
    );
    if (!page) return (await this.#loadFullView(chatId, () => loader.loadAll())).view;
    if (
      page.total === view.historyLastSeq
      && revisionsMatch(view.compositeRevision, page.compositeRevision)
    ) {
      this.#touch(view);
      return view;
    }
    return this.#reconcilePageForAppend(chatId, view, page);
  }

  #reconcilePageForAppend(
    chatId: string,
    previous: ChatView,
    page: ChatHistoryPage,
  ): ChatView {
    const reconciledPage = {
      ...page,
      messages: preserveRetainedUserIdentities(previous.messages, page.messages),
    };
    const view = this.#createGenerationFromPage(chatId, reconciledPage);
    const persistedIdentities = new Set(
      reconciledPage.messages.flatMap(exactMessageIdentityKeys),
    );
    const unpersistedLive = previous.messages
      .filter((entry) => entry.seq > previous.historyLastSeq && entry.seq > page.total)
      .filter((entry) => {
        const identities = exactMessageIdentityKeys(entry.message);
        return !identities.some((identity) => persistedIdentities.has(identity));
      })
      .map((entry) => entry.message);
    if (unpersistedLive.length > 0) {
      this.#appendLiveToView(view, unpersistedLive, 'native-wins');
    }
    this.#views.set(chatId, view);
    return view;
  }

  async #loadFullView(
    chatId: string,
    loadSnapshot: () => Promise<ChatTranscriptSnapshot>,
  ): Promise<{ view: ChatView; messages: ChatMessage[] }> {
    let view = this.#views.get(chatId);
    if (view?.complete) {
      this.#touch(view);
      return { view, messages: view.messages.map((entry) => entry.message) };
    }
    return this.#reconcileFullView(chatId, await loadSnapshot());
  }

  #reconcileFullView(
    chatId: string,
    snapshot: ChatTranscriptSnapshot,
  ): { view: ChatView; messages: ChatMessage[] } {
    const previous = this.#views.get(chatId);
    const reconciledMessages = previous
      ? preserveRetainedUserIdentities(previous.messages, snapshot.messages)
      : snapshot.messages;
    const reconciledNativeMessages = reconciledMessages.slice(snapshot.archivedLogicalCount);
    const retainedLiveEntries = previous?.messages.filter(
      (entry) => entry.seq > previous.historyLastSeq,
    ) ?? [];
    const previousNativeCount = previous
      ? Math.max(0, previous.historyLastSeq - snapshot.archivedLogicalCount)
      : 0;
    const priorNativePrefixMatches = Boolean(
      previous
      && persistenceMatches(previous, snapshot)
      && previous.nativePrefixDigest !== null
      && snapshot.nativeMessages.length >= previousNativeCount
      && transcriptRevision(snapshot.nativeMessages.slice(0, previousNativeCount))
        === previous.nativePrefixDigest,
    );
    const retainedLiveStartSeq = previous
      ? Math.max(previous.historyLastSeq + 1, previous.retainedStartSeq)
      : 1;
    const retainedLiveIsContiguous = previous
      ? retainedLiveEntries.every(
        (entry, index) => entry.seq === retainedLiveStartSeq + index,
      )
      : false;
    const nativeGrowthClosesTrimmedGap = previous
      ? reconciledMessages.length >= Math.min(retainedLiveStartSeq - 1, previous.lastSeq)
      : false;
    const evictedLiveRangeClosed = previous?.evictedLiveEndSeq === undefined
      || reconciledMessages.length >= previous.evictedLiveEndSeq;
    const evictedLiveMatches = previous?.evictedLiveStartSeq === undefined
      || previous.evictedLiveEndSeq === undefined
      || evictedLiveRangeClosed && orderedTranscriptDigest(
        reconciledMessages
          .slice(previous.evictedLiveStartSeq - 1, previous.evictedLiveEndSeq)
          .map((message, index) => ({
            seq: previous.evictedLiveStartSeq! + index,
            message,
          })),
      ) === previous.evictedLiveDigest.finish();
    const retainedNativeOverlapMatches = previous
      ? retainedLiveEntries
        .filter((entry) => entry.seq <= reconciledMessages.length)
        .every((entry) => retainedMessageMatchesNative(
          entry.message,
          reconciledMessages[entry.seq - 1],
        ))
      : false;
    const preservesGeneration = Boolean(
      previous
      && priorNativePrefixMatches
      && retainedLiveIsContiguous
      && nativeGrowthClosesTrimmedGap
      && evictedLiveRangeClosed
      && evictedLiveMatches
      && retainedNativeOverlapMatches,
    );

    const view = this.#createGeneration(chatId, reconciledMessages, {
      reason: !previous
        ? 'native-history-load'
        : preservesGeneration
          ? 'native-history-reconciled'
          : 'native-history-mismatch',
      previousGenerationId: previous?.generationId,
      generationId: preservesGeneration ? previous?.generationId : undefined,
      persistence: snapshot,
    });
    const nativeIdentities = new Set(
      reconciledMessages.flatMap(exactMessageIdentityKeys),
    );
    const unpersistedLiveMessages = previous
        ? retainedLiveEntries
        .filter((entry) => {
          const identities = exactMessageIdentityKeys(entry.message);
          return entry.seq > reconciledMessages.length
            && !identities.some((identity) => nativeIdentities.has(identity));
        })
        .map((entry) => entry.message)
      : [];
    let fullMessages = reconciledMessages;
    if (unpersistedLiveMessages.length > 0) {
      const appended = this.#appendLiveToView(view, unpersistedLiveMessages, 'native-wins');
      fullMessages = [...reconciledMessages, ...appended.map((entry) => entry.message)];
    }
    this.#views.set(chatId, view);
    return { view, messages: fullMessages };
  }

  #reconcileNativeView(chatId: string, input: NativeSnapshotReconciliation): void {
    const previous = this.#views.get(chatId);
    const now = this.#now();
    const reconciled = reconcileNativeSnapshotView({
      chatId,
      snapshot: input,
      previous,
      messageLimit: this.#messageLimit,
      now,
      streamFence: this.captureFence(chatId),
      lastAccessOrder: ++this.#lastAccessOrder,
    });
    if (reconciled.unpersistedLiveMessages.length > 0) {
      this.#appendLiveToView(
        reconciled.view,
        reconciled.unpersistedLiveMessages,
        'native-wins',
      );
    }
    this.#logGenerationTransition(reconciled.view, reconciled.transition);
    this.#views.set(chatId, reconciled.view);
  }

  #createGeneration(
    chatId: string,
    messages: ChatMessage[],
    transition: GenerationTransition,
  ): ChatView {
    const now = this.#now();
    const isoNow = new Date(now).toISOString();
    const view: ChatView = {
      chatId,
      generationId: transition.generationId ?? crypto.randomUUID(),
      createdAt: isoNow,
      historyReadAt: isoNow,
      messages: [],
      lastSeq: 0,
      historyLastSeq: messages.length,
      complete: true,
      loadedFromFullHistory: true,
      retainedStartSeq: 1,
      compositeRevision: transition.persistence?.compositeRevision,
      carryOverRevision: transition.persistence?.carryOverRevision,
      agentOwnershipEpoch: transition.persistence?.agentOwnershipEpoch,
      archivedLogicalCount: transition.persistence?.archivedLogicalCount ?? 0,
      nativePrefixDigest: transition.persistence?.nativePrefixDigest ?? null,
      evictedLiveDigest: new OrderedTranscriptDigest(),
      streamFence: this.captureFence(chatId),
      lastAccessAt: now,
      lastAccessOrder: ++this.#lastAccessOrder,
    };
    this.#appendToView(view, messages);
    this.#logGenerationTransition(view, transition);
    return view;
  }

  #createGenerationFromPage(chatId: string, page: ChatHistoryPage): ChatView {
    const now = this.#now();
    const isoNow = new Date(now).toISOString();
    const view: ChatView = {
      chatId,
      generationId: crypto.randomUUID(),
      createdAt: isoNow,
      historyReadAt: isoNow,
      messages: [],
      lastSeq: page.total,
      historyLastSeq: page.total,
      complete: !page.hasMore && page.offset === 0,
      loadedFromFullHistory: !page.hasMore && page.offset === 0,
      retainedStartSeq: page.total + 1,
      compositeRevision: page.compositeRevision,
      carryOverRevision: page.carryOverRevision,
      agentOwnershipEpoch: page.agentOwnershipEpoch,
      archivedLogicalCount: page.archivedLogicalCount,
      nativePrefixDigest: null,
      evictedLiveDigest: new OrderedTranscriptDigest(),
      streamFence: this.captureFence(chatId),
      lastAccessAt: now,
      lastAccessOrder: ++this.#lastAccessOrder,
    };
    this.#mergeHistoryPage(view, page);
    this.#logGenerationTransition(view, { reason: 'native-history-page' });
    return view;
  }

  #appendToView(view: ChatView, messages: ChatMessage[]): ChatViewMessage[] {
    if (messages.length === 0) return [];
    const appended = messages.map((message) => {
      assertValidChatMessage(message);
      return {
        seq: ++view.lastSeq,
        message,
      };
    });
    view.messages.push(...appended);
    this.#enforceViewMessageLimit(view);
    this.#touch(view);
    return appended;
  }

  #appendLiveToView(
    view: ChatView,
    messages: ChatMessage[],
    conflictPolicy: 'reject' | 'native-wins' = 'reject',
  ): ChatViewMessage[] {
    const existingByRequestId = new Map<string, UserMessage>();
    for (const entry of view.messages) {
      if (entry.message instanceof UserMessage && entry.message.metadata?.clientRequestId) {
        existingByRequestId.set(entry.message.metadata.clientRequestId, entry.message);
      }
    }

    const unique: ChatMessage[] = [];
    for (const message of messages) {
      if (!(message instanceof UserMessage) || !message.metadata?.clientRequestId) {
        unique.push(message);
        continue;
      }
      const requestId = message.metadata.clientRequestId;
      const existing = existingByRequestId.get(requestId);
      if (existing) {
        if (!userDeliveryPayloadsAreCompatible(existing, message)) {
          if (conflictPolicy === 'native-wins') {
            logger.warn(`dropped conflicting retained user message during native reconciliation requestId=${requestId}`);
            continue;
          }
          throw new Error(`Conflicting user message identity: ${requestId}`);
        }
        continue;
      }
      existingByRequestId.set(requestId, message);
      unique.push(message);
    }
    return this.#appendToView(view, unique);
  }

  #mergeHistoryPage(view: ChatView, page: ChatHistoryPage): void {
    const pageMessages = this.#messagesFromHistoryPage(page);
    if (pageMessages.length === 0) return;

    const oldestRetainedSeq = view.messages[0]?.seq;
    const newestRetainedSeq = view.messages.at(-1)?.seq;
    if (oldestRetainedSeq === undefined) {
      view.messages = pageMessages;
    } else if (pageMessages.at(-1)?.seq === oldestRetainedSeq - 1) {
      view.messages = [...pageMessages, ...view.messages];
    } else if (pageMessages[0]?.seq === (newestRetainedSeq ?? 0) + 1) {
      view.messages.push(...pageMessages);
    } else {
      const bySeq = new Map(view.messages.map((entry) => [entry.seq, entry]));
      for (const entry of pageMessages) bySeq.set(entry.seq, entry);
      view.messages = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    }

    view.historyLastSeq = page.total;
    view.lastSeq = Math.max(view.lastSeq, page.total);
    this.#enforceViewMessageLimit(view);
    this.#touch(view);
  }

  #messagesFromHistoryPage(page: ChatHistoryPage): ChatViewMessage[] {
    if (
      !Number.isSafeInteger(page.total)
      || page.total < 0
      || !Number.isSafeInteger(page.offset)
      || page.offset < 0
      || page.messages.length > page.total
    ) {
      throw new Error('Invalid paged transcript metadata');
    }

    const endSeq = page.total - page.offset;
    const startSeq = endSeq - page.messages.length + 1;
    if (page.messages.length > 0 && (startSeq < 1 || endSeq > page.total)) {
      throw new Error('Invalid paged transcript range');
    }
    return page.messages.map((message, index) => {
      assertValidChatMessage(message);
      return { seq: startSeq + index, message };
    });
  }

  #pageFromHistoryPage(view: ChatView, page: ChatHistoryPage): ChatViewPage {
    const messages = this.#messagesFromHistoryPage(page);
    return {
      generationId: view.generationId,
      messages,
      lastSeq: view.lastSeq,
      pageOldestSeq: messages[0]?.seq ?? 0,
      hasMore: page.hasMore,
    };
  }

  #pageFromHistoryAndRetained(
    view: ChatView,
    page: ChatHistoryPage,
    limit: number,
    beforeSeq?: number,
  ): ChatViewPage {
    const pageMessages = this.#messagesFromHistoryPage(page);
    const combined = pageMessages.at(-1)?.seq === (view.messages[0]?.seq ?? 1) - 1
      ? [...pageMessages, ...view.messages]
      : pageMessages;
    return this.#readPageFromMessages(view, combined, limit, beforeSeq);
  }

  #pageFromFullMessages(
    view: ChatView,
    messages: ChatMessage[],
    limit: number,
    beforeSeq?: number,
  ): ChatViewPage {
    return this.#readPageFromMessages(
      view,
      messages.map((message, index) => ({ seq: index + 1, message })),
      limit,
      beforeSeq,
    );
  }

  #hasCompleteHistory(view: ChatView): boolean {
    if (!view.loadedFromFullHistory || view.messages.length !== view.lastSeq) return false;
    for (let index = 0; index < view.lastSeq; index += 1) {
      if (view.messages[index]?.seq !== index + 1) return false;
    }
    return true;
  }

  #enforceViewMessageLimit(view: ChatView): void {
    const excess = view.messages.length - this.#messageLimit;
    if (excess > 0) this.#trimOldestMessages(view, excess);
    else this.#refreshRetainedState(view);
  }

  #trimOldestMessages(view: ChatView, count: number): void {
    if (count > 0) {
      const removed = view.messages.splice(0, count);
      for (const entry of removed) {
        if (entry.seq <= view.historyLastSeq) continue;
        view.evictedLiveStartSeq ??= entry.seq;
        view.evictedLiveEndSeq = entry.seq;
        view.evictedLiveDigest.add(entry.message, entry.seq);
      }
    }
    this.#refreshRetainedState(view);
  }

  #refreshRetainedState(view: ChatView): void {
    view.retainedStartSeq = view.messages[0]?.seq ?? view.lastSeq + 1;
    view.complete = this.#hasCompleteHistory(view);
  }

  #missingHistoryRequest(
    view: ChatView,
    limit: number,
    beforeSeq?: number,
  ): MissingHistoryRequest | null {
    if (view.complete) return null;
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return null;

    const requestedEndSeq = beforeSeq && beforeSeq > 0
      ? Math.min(beforeSeq - 1, view.lastSeq)
      : view.lastSeq;
    const requestedStartSeq = Math.max(1, requestedEndSeq - boundedLimit + 1);
    if (
      view.evictedLiveStartSeq !== undefined
      && view.evictedLiveEndSeq !== undefined
      && requestedStartSeq <= view.evictedLiveEndSeq
      && requestedEndSeq >= view.evictedLiveStartSeq
    ) {
      return { kind: 'full' };
    }
    const oldestRetainedSeq = view.retainedStartSeq;
    if (requestedStartSeq >= oldestRetainedSeq || requestedStartSeq > view.historyLastSeq) {
      return null;
    }

    const missingEndSeq = Math.min(
      requestedEndSeq,
      oldestRetainedSeq - 1,
      view.historyLastSeq,
    );
    if (missingEndSeq < requestedStartSeq) return null;
    return {
      kind: 'page',
      limit: missingEndSeq - requestedStartSeq + 1,
      offset: view.historyLastSeq - missingEndSeq,
    };
  }

  #readPageFromView(view: ChatView, limit: number, beforeSeq?: number): ChatViewPage {
    this.#touch(view);
    return this.#readPageFromMessages(view, view.messages, limit, beforeSeq);
  }

  #readPageFromMessages(
    view: ChatView,
    messages: ChatViewMessage[],
    limit: number,
    beforeSeq?: number,
  ): ChatViewPage {
    const boundedLimit = Math.max(0, Math.floor(limit));
    const end = beforeSeq && beforeSeq > 0
      ? lowerBoundBySeq(messages, beforeSeq)
      : messages.length;
    const start = Math.max(0, end - boundedLimit);
    const page = messages.slice(start, end);
    return {
      generationId: view.generationId,
      messages: page,
      lastSeq: view.lastSeq,
      pageOldestSeq: page[0]?.seq ?? 0,
      hasMore: (page[0]?.seq ?? 1) > 1,
    };
  }

  #cachedMessageCount(): number {
    let count = 0;
    for (const view of this.#views.values()) count += view.messages.length;
    return count;
  }

  #touch(view: ChatView): void {
    view.lastAccessAt = this.#now();
    view.lastAccessOrder = ++this.#lastAccessOrder;
  }

  #evictForPrune(view: ChatView, reason: PruneEvictionReason, now: number): boolean {
    if (!this.#views.delete(view.chatId)) return false;
    const ageMs = Math.max(0, now - view.lastAccessAt);
    logger.info(`view evicted chat=${view.chatId} generationId=${view.generationId} reason=${reason} ageMs=${ageMs} messages=${view.messages.length}`);
    return true;
  }

  #logGenerationTransition(view: ChatView, transition: GenerationTransition): void {
    const action = transition.previousGenerationId === undefined
      ? 'created'
      : transition.previousGenerationId === view.generationId
        ? 'preserved'
        : 'replaced';
    const previousGeneration = transition.previousGenerationId === undefined
      ? ''
      : ` previousGenerationId=${transition.previousGenerationId}`;
    logger.info(`generation ${action} chat=${view.chatId} generationId=${view.generationId} reason=${transition.reason}${previousGeneration} messages=${view.messages.length} lastSeq=${view.lastSeq}`);
  }
}
