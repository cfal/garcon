import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewPage } from '../../common/chat-view.js';
import type { ChatViewStore } from './chat-view-store.js';

interface NativeHistorySource {
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
}

export type NativeReloadMode = 'manual-reload' | 'process-error';

export interface NativeReloadResult extends ChatViewPage {
  mode: NativeReloadMode;
}

export class ChatNativeReloader {
  #views: ChatViewStore;
  #source: NativeHistorySource;
  #isChatRunning: (chatId: string) => boolean;
  #inFlight = new Map<string, Promise<NativeReloadResult>>();

  constructor(
    views: ChatViewStore,
    source: NativeHistorySource,
    isChatRunning: (chatId: string) => boolean,
  ) {
    this.#views = views;
    this.#source = source;
    this.#isChatRunning = isChatRunning;
  }

  loadNativeMessages(chatId: string): Promise<ChatMessage[]> {
    return this.#source.loadNativeMessages(chatId);
  }

  async reloadFromNative(chatId: string, mode: NativeReloadMode): Promise<NativeReloadResult> {
    if (mode !== 'process-error' && this.#isChatRunning(chatId)) {
      throw new Error('Cannot reload a running chat');
    }
    const pending = this.#inFlight.get(chatId);
    if (pending) return pending;
    const run = this.#run(chatId, mode);
    this.#inFlight.set(chatId, run);
    try {
      return await run;
    } finally {
      this.#inFlight.delete(chatId);
    }
  }

  async #run(chatId: string, mode: NativeReloadMode): Promise<NativeReloadResult> {
    const page = await this.#views.replaceFromNative(
      chatId,
      () => this.#source.loadNativeMessages(chatId),
      { appendProcessDiedNotice: mode === 'process-error' },
    );
    console.info(`native reload: ${mode} messages=${page.lastSeq}`);
    return { ...page, mode };
  }
}
