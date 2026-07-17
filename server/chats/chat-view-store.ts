import crypto from 'crypto';
import { ErrorMessage, UserMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatReplayResult, ChatViewMessage, ChatViewPage } from '../../common/chat-view.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';
import {
  OrderedTranscriptDigest,
  orderedTranscriptDigest,
  transcriptRevision,
  transcriptRevisions,
} from '../lib/transcript-revision.js';

const logger = createLogger('chat-view');

export interface ChatViewStoreOptions {
  replayLimit?: number;
  cacheLimit?: number;
  messageLimit?: number;
  staleNonActiveMs?: number;
  now?: () => number;
}

export interface ChatHistoryPage {
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
  revision?: string;
}

export interface ChatViewLoader {
  loadAll(): Promise<ChatMessage[]>;
  loadPage?(limit: number, offset: number): Promise<ChatHistoryPage | null>;
}

export interface AppendedChatViewMessages {
  generationId: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  skipped?: boolean;
}

type MissingHistoryRequest =
  | { kind: 'page'; limit: number; offset: number }
  | { kind: 'full' };

interface ChatView {
  chatId: string;
  generationId: string;
  createdAt: string;
  historyReadAt: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  historyLastSeq: number;
  complete: boolean;
  loadedFromFullHistory: boolean;
  retainedStartSeq: number;
  nativeRevision?: string;
  evictedLiveStartSeq?: number;
  evictedLiveEndSeq?: number;
  evictedLiveDigest: OrderedTranscriptDigest;
  streamFence: number;
  lastAccessAt: number;
}

const REPLAY_LIMIT = 2048;
const CACHE_LIMIT = 100;
const MESSAGE_LIMIT = 20_000;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;

export class ChatViewStore {
  #views = new Map<string, ChatView>();
  #locks = new KeyedPromiseLock();
  #fences = new Map<string, number>();
  #inFlightChats = new Set<string>();
  #replayLimit: number;
  #cacheLimit: number;
  #messageLimit: number;
  #staleNonActiveMs: number;
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
    view.lastAccessAt = this.#now();
    return { generationId: view.generationId, lastSeq: view.lastSeq };
  }

  getLoadedMessages(chatId: string): ChatMessage[] | null {
    const view = this.#views.get(chatId);
    if (!view?.complete) return null;
    view.lastAccessAt = this.#now();
    return view.messages.map((entry) => entry.message);
  }

  getRetainedHistoryMessages(chatId: string): ChatMessage[] | null {
    const view = this.#views.get(chatId);
    if (!view) return null;
    view.lastAccessAt = this.#now();
    return view.messages
      .filter((entry) => entry.seq <= view.historyLastSeq)
      .map((entry) => entry.message);
  }

  async getOrCreateMessages(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
  ): Promise<ChatMessage[]> {
    return this.#withChat(chatId, async () => {
      const loaded = await this.#loadFullView(chatId, loadNativeMessages);
      return loaded.messages;
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
          const fullMessages = await loader.loadAll();
          const reconciled = this.#reconcileFullView(chatId, fullMessages);
          view = reconciled.view;
          if (fullMessages.length > view.messages.length) {
            return this.#pageFromFullMessages(view, fullMessages, limit, beforeSeq);
          }
        }
      }

      const missingHistory = this.#missingHistoryRequest(view, limit, beforeSeq);
      if (missingHistory) {
        view.lastAccessAt = this.#now();
        if (missingHistory.kind === 'full') {
          const fullMessages = await loader.loadAll();
          const reconciled = this.#reconcileFullView(chatId, fullMessages);
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
          && revisionsMatch(view.nativeRevision, olderPage.revision)
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
          const fullMessages = await loader.loadAll();
          const reconciled = this.#reconcileFullView(chatId, fullMessages);
          return this.#pageFromFullMessages(
            reconciled.view,
            reconciled.messages,
            limit,
            beforeSeq,
          );
        }
      }

      view.lastAccessAt = this.#now();
      return this.#readPageFromView(view, limit, beforeSeq);
    });
  }

  async replaceFromNative(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
    options: { processErrorNotice?: string } = {},
  ): Promise<ChatViewPage> {
    return this.#withChat(chatId, async () => {
      const nativeMessages = await loadNativeMessages();
      const view = this.#createGeneration(chatId, nativeMessages);
      if (options.processErrorNotice) {
        this.#appendToView(view, [new ErrorMessage(new Date().toISOString(), options.processErrorNotice)]);
      }
      this.#views.set(chatId, view);
      return this.#readPageFromView(view, Number.MAX_SAFE_INTEGER);
    });
  }

  async appendAfterEnsuringGeneration(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
    messages: ChatMessage[],
    options: { fence?: number } = {},
  ): Promise<AppendedChatViewMessages> {
    return this.#withChat(chatId, async () => {
      const view = await this.#getOrCreateAppendView(chatId, loadNativeMessages);
      if (options.fence !== undefined && options.fence !== view.streamFence) {
        return { generationId: view.generationId, messages: [], lastSeq: view.lastSeq, skipped: true };
      }
      const appended = this.#appendToView(view, messages);
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
        view = this.#createGeneration(chatId, []);
        this.#views.set(chatId, view);
      }
      const appended = this.#appendToView(view, messages);
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
    view.lastAccessAt = this.#now();
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
    const views = [...this.#views.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    for (const view of views) {
      if (this.#isChatActive(view.chatId) || this.#inFlightChats.has(view.chatId)) continue;
      const isStale = now - view.lastAccessAt > this.#staleNonActiveMs;
      if (isStale) this.#views.delete(view.chatId);
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
        || this.#isChatActive(view.chatId)
        || this.#inFlightChats.has(view.chatId)
      ) continue;
      this.#views.delete(view.chatId);
      cachedMessages -= view.messages.length;
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
    }
  }

  async #withChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(`chat:${chatId}`, async () => {
      this.#inFlightChats.add(chatId);
      const view = this.#views.get(chatId);
      if (view) view.lastAccessAt = this.#now();
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
    loadNativeMessages: () => Promise<ChatMessage[]>,
  ): Promise<ChatView> {
    const view = this.#views.get(chatId);
    if (view?.loadedFromFullHistory) {
      view.lastAccessAt = this.#now();
      return view;
    }
    return (await this.#loadFullView(chatId, loadNativeMessages)).view;
  }

  async #loadFullView(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
  ): Promise<{ view: ChatView; messages: ChatMessage[] }> {
    let view = this.#views.get(chatId);
    if (view?.complete) {
      view.lastAccessAt = this.#now();
      return { view, messages: view.messages.map((entry) => entry.message) };
    }
    const nativeMessages = await loadNativeMessages();
    return this.#reconcileFullView(chatId, nativeMessages);
  }

  #reconcileFullView(
    chatId: string,
    nativeMessages: ChatMessage[],
  ): { view: ChatView; messages: ChatMessage[] } {
    const previous = this.#views.get(chatId);
    const reconciledNativeMessages = previous
      ? preserveRetainedUserIdentities(previous.messages, nativeMessages)
      : nativeMessages;
    const revisions = transcriptRevisions(
      nativeMessages,
      previous?.historyLastSeq ?? nativeMessages.length,
    );
    const retainedLiveEntries = previous?.messages.filter(
      (entry) => entry.seq > previous.historyLastSeq,
    ) ?? [];
    const priorNativePrefixMatches = previous
      && previous.nativeRevision !== undefined
      && reconciledNativeMessages.length >= previous.historyLastSeq
      && revisions.prefix === previous.nativeRevision;
    const retainedLiveStartSeq = previous
      ? Math.max(previous.historyLastSeq + 1, previous.retainedStartSeq)
      : 1;
    const retainedLiveIsContiguous = previous
      ? retainedLiveEntries.every(
        (entry, index) => entry.seq === retainedLiveStartSeq + index,
      )
      : false;
    const nativeGrowthClosesTrimmedGap = previous
      ? reconciledNativeMessages.length >= Math.min(retainedLiveStartSeq - 1, previous.lastSeq)
      : false;
    const evictedLiveRangeClosed = previous?.evictedLiveEndSeq === undefined
      || reconciledNativeMessages.length >= previous.evictedLiveEndSeq;
    const evictedLiveMatches = previous?.evictedLiveStartSeq === undefined
      || previous.evictedLiveEndSeq === undefined
      || evictedLiveRangeClosed && orderedTranscriptDigest(
        reconciledNativeMessages
          .slice(previous.evictedLiveStartSeq - 1, previous.evictedLiveEndSeq)
          .map((message, index) => ({
            seq: previous.evictedLiveStartSeq! + index,
            message,
          })),
      ) === previous.evictedLiveDigest.finish();
    const retainedNativeOverlapMatches = previous
      ? retainedLiveEntries
        .filter((entry) => entry.seq <= reconciledNativeMessages.length)
        .every((entry) => retainedMessageMatchesNative(
          entry.message,
          reconciledNativeMessages[entry.seq - 1],
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

    const view = this.#createGeneration(
      chatId,
      reconciledNativeMessages,
      preservesGeneration ? previous?.generationId : undefined,
      revisions.full,
    );
    const unpersistedLiveMessages = previous
      ? retainedLiveEntries
        .filter((entry) => entry.seq > reconciledNativeMessages.length)
        .map((entry) => entry.message)
      : [];
    let fullMessages = reconciledNativeMessages;
    if (unpersistedLiveMessages.length > 0) {
      this.#appendToView(view, unpersistedLiveMessages);
      fullMessages = [...reconciledNativeMessages, ...unpersistedLiveMessages];
    }
    this.#views.set(chatId, view);
    return { view, messages: fullMessages };
  }

  #createGeneration(
    chatId: string,
    messages: ChatMessage[],
    generationId = crypto.randomUUID(),
    nativeRevision = transcriptRevision(messages),
  ): ChatView {
    const now = this.#now();
    const isoNow = new Date(now).toISOString();
    const view: ChatView = {
      chatId,
      generationId,
      createdAt: isoNow,
      historyReadAt: isoNow,
      messages: [],
      lastSeq: 0,
      historyLastSeq: messages.length,
      complete: true,
      loadedFromFullHistory: true,
      retainedStartSeq: 1,
      nativeRevision,
      evictedLiveDigest: new OrderedTranscriptDigest(),
      streamFence: this.captureFence(chatId),
      lastAccessAt: now,
    };
    this.#appendToView(view, messages);
    logger.info(`generation created chat=${chatId} generationId=${view.generationId} messages=${messages.length} lastSeq=${view.lastSeq}`);
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
      nativeRevision: page.revision,
      evictedLiveDigest: new OrderedTranscriptDigest(),
      streamFence: this.captureFence(chatId),
      lastAccessAt: now,
    };
    this.#mergeHistoryPage(view, page);
    logger.info(`generation created chat=${chatId} generationId=${view.generationId} messages=${page.messages.length} lastSeq=${view.lastSeq}`);
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
    view.lastAccessAt = this.#now();
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
    view.lastAccessAt = this.#now();
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
    view.lastAccessAt = this.#now();
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
}

export function lowerBoundBySeq(messages: ChatViewMessage[], seq: number): number {
  let lo = 0;
  let hi = messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (messages[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function assertValidChatMessage(message: ChatMessage): void {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    throw new Error('Invalid chat message');
  }
}

function wireMessagesEqual(left: ChatMessage, right: ChatMessage | undefined): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function preserveRetainedUserIdentities(
  retainedMessages: ChatViewMessage[],
  nativeMessages: ChatMessage[],
): ChatMessage[] {
  let reconciled = nativeMessages;
  for (const entry of retainedMessages) {
    const nativeIndex = entry.seq - 1;
    if (nativeIndex >= nativeMessages.length) break;
    const nativeMessage = nativeMessages[nativeIndex];
    const withIdentity = preserveLiveUserIdentity(entry.message, nativeMessage);
    if (withIdentity === nativeMessage) continue;
    if (reconciled === nativeMessages) reconciled = [...nativeMessages];
    reconciled[nativeIndex] = withIdentity;
  }
  return reconciled;
}

function preserveLiveUserIdentity(liveMessage: ChatMessage, nativeMessage: ChatMessage): ChatMessage {
  if (
    !(liveMessage instanceof UserMessage)
    || !(nativeMessage instanceof UserMessage)
    || !liveMessage.metadata?.clientRequestId
    || !userEchoesAreCompatible(liveMessage, nativeMessage)
  ) {
    return nativeMessage;
  }
  return new UserMessage(
    liveMessage.timestamp,
    liveMessage.content,
    liveMessage.images,
    { ...nativeMessage.metadata, ...liveMessage.metadata },
  );
}

function retainedMessageMatchesNative(
  retainedMessage: ChatMessage,
  nativeMessage: ChatMessage | undefined,
): boolean {
  return wireMessagesEqual(retainedMessage, nativeMessage)
    || retainedMessage instanceof UserMessage
      && nativeMessage instanceof UserMessage
      && Boolean(retainedMessage.metadata?.clientRequestId)
      && userEchoesAreCompatible(retainedMessage, nativeMessage);
}

function userEchoesAreCompatible(
  liveMessage: UserMessage,
  nativeMessage: UserMessage,
): boolean {
  return wireMessagesEqual(
    withoutMetadata(liveMessage, nativeMessage.timestamp),
    withoutMetadata(nativeMessage, nativeMessage.timestamp),
  ) && metadataIsCompatible(liveMessage.metadata, nativeMessage.metadata);
}

function withoutMetadata(message: UserMessage, timestamp: string): UserMessage {
  return new UserMessage(
    timestamp,
    message.content,
    message.images,
  );
}

function metadataIsCompatible(
  liveMetadata: UserMessage['metadata'],
  nativeMetadata: UserMessage['metadata'],
): boolean {
  const live = liveMetadata as Record<string, unknown> | undefined;
  for (const [key, nativeValue] of Object.entries(nativeMetadata ?? {})) {
    const liveValue = live?.[key];
    if (liveValue !== undefined && liveValue !== nativeValue) return false;
  }
  return true;
}

function revisionsMatch(previous: string | undefined, current: string | undefined): boolean {
  return previous === current;
}
