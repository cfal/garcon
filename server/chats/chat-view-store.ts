import crypto from 'crypto';
import { sameProjectionState } from '@garcon/server-agent-common/transcript-projection/identity';
import type { ChatMessage } from '../../common/chat-types.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import {
  assertValidChatMessage,
  lowerBoundBySeq,
  revisionsMatch,
} from './chat-view-sequence.js';
import type {
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  LegacyChatViewMessage,
  ChatViewGenerationTransition as GenerationTransition,
  ChatViewLoader,
  MutableChatView as ChatView,
  ProjectionCommitViewApplication,
  ProjectionCommitViewInput,
} from './chat-view-contracts.js';
import { ChatRunningError } from './errors.js';

export { lowerBoundBySeq } from './chat-view-sequence.js';
export type {
  ChatHistoryPage,
  ChatTranscriptSnapshot,
  ChatViewLoader,
  ProjectionCommitViewApplication,
  ProjectionCommitViewInput,
} from './chat-view-contracts.js';

export interface LegacyChatViewPage {
  readonly generationId: string;
  readonly messages: LegacyChatViewMessage[];
  readonly lastSeq: number;
  readonly pageOldestSeq: number;
  readonly hasMore: boolean;
}

export type LegacyChatReplayResult =
  | {
      readonly mode: 'delta';
      readonly generationId: string;
      readonly messages: LegacyChatViewMessage[];
      readonly lastSeq: number;
    }
  | {
      readonly mode: 'snapshot-required';
      readonly generationId: string;
      readonly messages: [];
      readonly lastSeq: number;
    };

const logger = createLogger('chat-view');

export interface ChatViewStoreOptions {
  replayLimit?: number;
  cacheLimit?: number;
  messageLimit?: number;
  staleNonActiveMs?: number;
  recentViewRetentionCount?: number;
  now?: () => number;
}

interface MissingHistoryRequest {
  limit: number;
  offset: number;
}

const REPLAY_LIMIT = 2048;
const CACHE_LIMIT = 100;
const MESSAGE_LIMIT = 20_000;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const RECENT_VIEW_RETENTION_COUNT = 10;

type PruneEvictionReason = 'stale' | 'view-capacity' | 'message-capacity';

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

  // Highest seq the current generation covers with authoritative ledger rows.
  // Under exact commit application this equals the view's last seq.
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

  async getOrCreatePage(
    chatId: string,
    loader: ChatViewLoader,
    limit: number,
    beforeSeq?: number,
  ): Promise<LegacyChatViewPage> {
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
            return this.#pageFromFullMessages(view, [...snapshot.messages], limit, beforeSeq);
          }
        }
      }

      const missingHistory = this.#missingHistoryRequest(view, limit, beforeSeq);
      if (missingHistory) {
        this.#touch(view);
        const olderPage = await loader.loadPage?.(
          missingHistory.limit,
          missingHistory.offset,
        );
        if (olderPage && this.#olderPageMatchesView(view, olderPage)) {
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

  async replaceFromProjection(chatId: string, snapshot: ChatTranscriptSnapshot): Promise<LegacyChatViewPage> {
    return this.#withChat(chatId, async () => {
      const previous = this.#views.get(chatId);
      this.invalidateFence(chatId);
      const view = this.#createGeneration(chatId, [...snapshot.messages], {
        reason: 'projection-reset', previousGenerationId: previous?.generationId, persistence: snapshot,
      });
      this.#views.set(chatId, view);
      return this.#readPageFromView(view, Number.MAX_SAFE_INTEGER);
    });
  }

  // Rebuilds a chat's view from the authoritative projection under a fresh
  // generation. Execution ownership refuses the reload because the running
  // turn's exact commits already keep the view current; ownership is rechecked
  // after each held read so a turn that starts mid-load wins.
  async reloadFromProjection(chatId: string, loader: ChatViewLoader): Promise<LegacyChatViewPage> {
    return this.#withChat(chatId, async () => {
      const assertIdle = () => {
        if (this.#isChatActive(chatId)) throw new ChatRunningError(chatId);
      };
      assertIdle();
      const guarded: ChatViewLoader = {
        loadAll: async () => {
          const snapshot = await loader.loadAll();
          assertIdle();
          return snapshot;
        },
        ...(loader.loadPage ? {
          loadPage: async (limit: number, offset: number) => {
            const page = await loader.loadPage!(limit, offset);
            assertIdle();
            return page;
          },
        } : {}),
      };
      const view = await this.#relistFromProjection(chatId, guarded);
      return this.#readPageFromView(view, Number.MAX_SAFE_INTEGER);
    });
  }

  // Applies one integration commit event against the exact predecessor state the
  // view already holds. Identity is the projection state alone: content and
  // delivery identity never participate. A view on any other state relists from
  // the authoritative projection under a fresh generation.
  async applyProjectionCommit(
    chatId: string,
    commit: ProjectionCommitViewInput,
    loader: ChatViewLoader,
  ): Promise<ProjectionCommitViewApplication> {
    return this.#withChat(chatId, async () => {
      const view = this.#views.get(chatId);
      if (view?.projectionState) {
        if (sameProjectionState(view.projectionState, commit.checkpointProjection)) {
          this.#touch(view);
          return {
            kind: 'already-applied',
            generationId: view.generationId,
            lastSeq: view.lastSeq,
          };
        }
        const expectedTotal = commit.previousProjection.total + commit.appendedMessages.length;
        if (
          sameProjectionState(view.projectionState, commit.previousProjection)
          && commit.checkpointProjection.total === expectedTotal
          && view.archivedLogicalCount === commit.carryOverMessageCount
          && view.lastSeq === commit.carryOverMessageCount + commit.previousProjection.total
        ) {
          const appended = this.#appendToView(view, [...commit.appendedMessages]);
          view.historyLastSeq = view.lastSeq;
          view.projectionState = commit.checkpointProjection;
          return {
            kind: 'applied',
            generationId: view.generationId,
            messages: appended,
            lastSeq: view.lastSeq,
          };
        }
      }
      const previousGenerationId = view?.generationId ?? null;
      const relisted = await this.#relistFromProjection(chatId, loader);
      return {
        kind: 'relisted',
        previousGenerationId,
        generationId: relisted.generationId,
        lastSeq: relisted.lastSeq,
      };
    });
  }

  readPage(chatId: string, limit: number, beforeSeq?: number): LegacyChatViewPage | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    return this.#readPageFromView(view, limit, beforeSeq);
  }

  readReplay(chatId: string, generationId: string, afterSeq: number): LegacyChatReplayResult | null {
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

  // Rebuilds the view from the authoritative projection under a new generation.
  // The fence invalidation marks the old generation superseded before the
  // relisted state installs.
  async #relistFromProjection(chatId: string, loader: ChatViewLoader): Promise<ChatView> {
    const previous = this.#views.get(chatId);
    this.invalidateFence(chatId);
    const page = await loader.loadPage?.(
      Math.min(this.#messageLimit, this.#replayLimit),
      0,
    );
    if (page) {
      const view = this.#createGenerationFromPage(chatId, page);
      this.#views.set(chatId, view);
      return view;
    }
    const snapshot = await loader.loadAll();
    const view = this.#createGeneration(chatId, [...snapshot.messages], {
      reason: 'projection-relist',
      previousGenerationId: previous?.generationId,
      persistence: snapshot,
    });
    this.#views.set(chatId, view);
    return view;
  }

  // Rebuilds the full view from a composite snapshot. Within one projection
  // lineage, append-only growth preserves the generation by state comparison
  // alone. Without a ledger lineage on both sides, only a byte-identical
  // composite revision proves the reload addresses the same rows. Any other
  // relationship starts a new generation; per-row content is never compared.
  #reconcileFullView(
    chatId: string,
    snapshot: ChatTranscriptSnapshot,
  ): { view: ChatView; messages: ChatMessage[] } {
    const previous = this.#views.get(chatId);
    const sameLineage = previous?.projectionState && snapshot.projectionState
      ? previous.projectionState.epoch === snapshot.projectionState.epoch
        && previous.projectionState.contentEpoch === snapshot.projectionState.contentEpoch
        && snapshot.projectionState.total >= previous.projectionState.total
      : Boolean(
        previous
        && !previous.projectionState
        && !snapshot.projectionState
        && previous.compositeRevision !== undefined
        && revisionsMatch(previous.compositeRevision, snapshot.compositeRevision),
      );
    const preservesGeneration = Boolean(
      previous
      && sameLineage
      && previous.carryOverRevision === snapshot.carryOverRevision
      && previous.agentOwnershipEpoch === snapshot.agentOwnershipEpoch
      && previous.archivedLogicalCount === snapshot.archivedLogicalCount
      && snapshot.messages.length >= previous.lastSeq,
    );
    const messages = [...snapshot.messages];
    const view = this.#createGeneration(chatId, messages, {
      reason: !previous
        ? 'projection-load'
        : preservesGeneration
          ? 'projection-extended'
          : 'projection-replaced',
      previousGenerationId: previous?.generationId,
      generationId: preservesGeneration ? previous?.generationId : undefined,
      persistence: snapshot,
    });
    this.#views.set(chatId, view);
    return { view, messages };
  }

  #createGeneration(
    chatId: string,
    messages: ChatMessage[],
    transition: GenerationTransition,
  ): ChatView {
    const now = this.#now();
    const view: ChatView = {
      chatId,
      generationId: transition.generationId ?? crypto.randomUUID(),
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
      projectionState: transition.persistence?.projectionState ?? null,
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
    const view: ChatView = {
      chatId,
      generationId: crypto.randomUUID(),
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
      projectionState: page.projectionState,
      streamFence: this.captureFence(chatId),
      lastAccessAt: now,
      lastAccessOrder: ++this.#lastAccessOrder,
    };
    this.#mergeHistoryPage(view, page);
    this.#logGenerationTransition(view, { reason: 'projection-page' });
    return view;
  }

  #appendToView(view: ChatView, messages: ChatMessage[]): LegacyChatViewMessage[] {
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

  #messagesFromHistoryPage(page: ChatHistoryPage): LegacyChatViewMessage[] {
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

  #pageFromHistoryPage(view: ChatView, page: ChatHistoryPage): LegacyChatViewPage {
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
  ): LegacyChatViewPage {
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
  ): LegacyChatViewPage {
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
    if (count > 0) view.messages.splice(0, count);
    this.#refreshRetainedState(view);
  }

  #refreshRetainedState(view: ChatView): void {
    view.retainedStartSeq = view.messages[0]?.seq ?? view.lastSeq + 1;
    view.complete = this.#hasCompleteHistory(view);
  }

  // A continuation page is coherent when it addresses the same projection
  // lineage and composite window as the loaded view. Within one stream epoch
  // and content epoch the durable prefix is append-only, so equal totals
  // address identical ordinals without content comparison. Views without
  // projection state fall back to the composite content revision.
  #olderPageMatchesView(view: ChatView, page: ChatHistoryPage): boolean {
    if (page.total !== view.historyLastSeq) return false;
    if (view.projectionState && page.projectionState) {
      return view.projectionState.epoch === page.projectionState.epoch
        && view.projectionState.contentEpoch === page.projectionState.contentEpoch
        && view.carryOverRevision === page.carryOverRevision
        && view.archivedLogicalCount === page.archivedLogicalCount;
    }
    return revisionsMatch(view.compositeRevision, page.compositeRevision);
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
      limit: missingEndSeq - requestedStartSeq + 1,
      offset: view.historyLastSeq - missingEndSeq,
    };
  }

  #readPageFromView(view: ChatView, limit: number, beforeSeq?: number): LegacyChatViewPage {
    this.#touch(view);
    return this.#readPageFromMessages(view, view.messages, limit, beforeSeq);
  }

  #readPageFromMessages(
    view: ChatView,
    messages: LegacyChatViewMessage[],
    limit: number,
    beforeSeq?: number,
  ): LegacyChatViewPage {
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
