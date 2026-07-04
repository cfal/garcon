import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewPage } from '../../common/chat-view.js';
import type { ChatViewStore } from './chat-view-store.js';
import { createLogger } from '../lib/log.js';
import { ChatRunningError } from './errors.js';

const logger = createLogger('chat-native-reload');

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
      throw new ChatRunningError(chatId);
    }
    const key = `${chatId}:${mode}`;
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const run = this.#run(chatId, mode);
    this.#inFlight.set(key, run);
    try {
      return await run;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #run(chatId: string, mode: NativeReloadMode): Promise<NativeReloadResult> {
    const page = await this.#views.replaceFromNative(
      chatId,
      () => this.#source.loadNativeMessages(chatId),
      { appendProcessDiedNotice: mode === 'process-error' },
    );
    logger.info(`reload complete mode=${mode} chat=${chatId} messages=${page.lastSeq}`);
    return { ...page, mode };
  }
}
