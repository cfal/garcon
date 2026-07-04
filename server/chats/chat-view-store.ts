import crypto from 'crypto';
import { ErrorMessage, type ChatMessage } from '../../common/chat-types.js';
import type { ChatReplayResult, ChatViewMessage, ChatViewPage } from '../../common/chat-view.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('chat-view');

export interface ChatViewStoreOptions {
  replayLimit?: number;
  cacheLimit?: number;
  staleNonActiveMs?: number;
  now?: () => number;
}

export interface AppendedChatViewMessages {
  generationId: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  skipped?: boolean;
}

interface ChatView {
  chatId: string;
  generationId: string;
  createdAt: string;
  historyReadAt: string;
  messages: ChatViewMessage[];
  lastSeq: number;
  streamFence: number;
  lastAccessAt: number;
}

const REPLAY_LIMIT = 2048;
const CACHE_LIMIT = 100;
const STALE_NON_ACTIVE_MS = 10 * 60 * 1000;
const PROCESS_DIED_MESSAGE = 'The process died.';

export class ChatViewStore {
  #views = new Map<string, ChatView>();
  #locks = new KeyedPromiseLock();
  #fences = new Map<string, number>();
  #replayLimit: number;
  #cacheLimit: number;
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
    if (!view) return null;
    view.lastAccessAt = this.#now();
    return view.messages.map((entry) => entry.message);
  }

  async getOrCreateMessages(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
  ): Promise<ChatMessage[]> {
    return this.#withChat(chatId, async () => {
      const view = await this.#getOrCreateView(chatId, loadNativeMessages);
      return view.messages.map((entry) => entry.message);
    });
  }

  async getOrCreatePage(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
    limit: number,
    beforeSeq?: number,
  ): Promise<ChatViewPage> {
    return this.#withChat(chatId, async () => {
      const view = await this.#getOrCreateView(chatId, loadNativeMessages);
      return this.#readPageFromView(view, limit, beforeSeq);
    });
  }

  async replaceFromNative(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
    options: { appendProcessDiedNotice?: boolean } = {},
  ): Promise<ChatViewPage> {
    return this.#withChat(chatId, async () => {
      const nativeMessages = await loadNativeMessages();
      const view = this.#createGeneration(chatId, nativeMessages);
      if (options.appendProcessDiedNotice) {
        this.#appendToView(view, [new ErrorMessage(new Date().toISOString(), PROCESS_DIED_MESSAGE)]);
      }
      this.#views.set(chatId, view);
      this.#pruneIfNeeded();
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
      const view = await this.#getOrCreateView(chatId, loadNativeMessages);
      if (options.fence !== undefined && options.fence !== view.streamFence) {
        return { generationId: view.generationId, messages: [], lastSeq: view.lastSeq, skipped: true };
      }
      const appended = this.#appendToView(view, messages);
      this.#pruneIfNeeded();
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
      this.#pruneIfNeeded();
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
      if (this.#isChatActive(view.chatId)) continue;
      const isStale = now - view.lastAccessAt > this.#staleNonActiveMs;
      const isOverLimit = this.#views.size > this.#cacheLimit;
      if (isStale || isOverLimit) this.#views.delete(view.chatId);
    }
  }

  async #withChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    return this.#locks.runExclusive(`chat:${chatId}`, fn);
  }

  async #getOrCreateView(
    chatId: string,
    loadNativeMessages: () => Promise<ChatMessage[]>,
  ): Promise<ChatView> {
    let view = this.#views.get(chatId);
    if (view) {
      view.lastAccessAt = this.#now();
      return view;
    }
    const nativeMessages = await loadNativeMessages();
    view = this.#createGeneration(chatId, nativeMessages);
    this.#views.set(chatId, view);
    this.#pruneIfNeeded();
    return view;
  }

  #createGeneration(chatId: string, messages: ChatMessage[]): ChatView {
    const now = this.#now();
    const isoNow = new Date(now).toISOString();
    const view: ChatView = {
      chatId,
      generationId: crypto.randomUUID(),
      createdAt: isoNow,
      historyReadAt: isoNow,
      messages: [],
      lastSeq: 0,
      streamFence: this.captureFence(chatId),
      lastAccessAt: now,
    };
    this.#appendToView(view, messages);
    logger.info(`generation created chat=${chatId} messages=${messages.length} lastSeq=${view.lastSeq}`);
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
    view.lastAccessAt = this.#now();
    return appended;
  }

  #readPageFromView(view: ChatView, limit: number, beforeSeq?: number): ChatViewPage {
    view.lastAccessAt = this.#now();
    const boundedLimit = Math.max(0, Math.floor(limit));
    const end = beforeSeq && beforeSeq > 0
      ? lowerBoundBySeq(view.messages, beforeSeq)
      : view.messages.length;
    const start = Math.max(0, end - boundedLimit);
    const page = view.messages.slice(start, end);
    return {
      generationId: view.generationId,
      messages: page,
      lastSeq: view.lastSeq,
      pageOldestSeq: page[0]?.seq ?? 0,
      hasMore: start > 0,
    };
  }

  #pruneIfNeeded(): void {
    if (this.#views.size > this.#cacheLimit) this.prune();
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
