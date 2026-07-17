import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatViewPage } from '../../common/chat-view.js';
import type { ChatViewStore } from './chat-view-store.js';
import { createLogger } from '../lib/log.js';
import { ChatRunningError } from './errors.js';

const logger = createLogger('chat-native-reload');

// Fallback notice when a process-error reload has no humanized failure reason.
export const PROCESS_DIED_MESSAGE = 'The process died.';

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
  #isChatExecutionActive: (chatId: string) => boolean;
  #inFlight = new Map<string, Promise<NativeReloadResult>>();

  constructor(
    views: ChatViewStore,
    source: NativeHistorySource,
    isChatExecutionActive: (chatId: string) => boolean,
  ) {
    this.#views = views;
    this.#source = source;
    this.#isChatExecutionActive = isChatExecutionActive;
  }

  loadNativeMessages(chatId: string): Promise<ChatMessage[]> {
    return this.#source.loadNativeMessages(chatId);
  }

  async reloadFromNative(
    chatId: string,
    mode: NativeReloadMode,
    processErrorReason?: string,
  ): Promise<NativeReloadResult> {
    if (mode !== 'process-error' && this.#isChatExecutionActive(chatId)) {
      throw new ChatRunningError(chatId);
    }
    const key = `${chatId}:${mode}`;
    const pending = this.#inFlight.get(key);
    if (pending) return pending;
    const run = this.#run(chatId, mode, processErrorReason);
    this.#inFlight.set(key, run);
    try {
      return await run;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #run(
    chatId: string,
    mode: NativeReloadMode,
    processErrorReason?: string,
  ): Promise<NativeReloadResult> {
    // Persist the humanized failure reason (e.g. "Codex rate limit exceeded")
    // so the chat surfaces the real cause instead of the blanket process-death
    // label; fall back only when no reason is available.
    const processErrorNotice = mode === 'process-error'
      ? processErrorReason?.trim() || PROCESS_DIED_MESSAGE
      : undefined;
    const assertReplacementAllowed = mode === 'process-error'
      ? undefined
      : () => {
        if (this.#isChatExecutionActive(chatId)) throw new ChatRunningError(chatId);
      };
    const page = await this.#views.replaceFromNative(
      chatId,
      () => this.#source.loadNativeMessages(chatId),
      { processErrorNotice, assertReplacementAllowed },
    );
    logger.info(`reload complete mode=${mode} chat=${chatId} messages=${page.lastSeq}`);
    return { ...page, mode };
  }
}
