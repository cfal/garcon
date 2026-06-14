import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatMessageEvent } from '../../common/chat-events.js';
import type { ChatEventLog } from './chat-event-log.js';

interface NativeHistorySource {
  loadNativeMessages(chatId: string): Promise<ChatMessage[]>;
}

export type NativeReloadMode = 'cold-load' | 'manual-reload' | 'process-error';

export interface NativeReloadResult {
  logId: string;
  events: ChatMessageEvent[];
  lastAppendSeq: number;
  mode: NativeReloadMode;
  localNotice?: string;
}

export class ChatNativeReloader {
  #log: ChatEventLog;
  #source: NativeHistorySource;
  #isChatRunning: (chatId: string) => boolean;
  #inFlight = new Map<string, Promise<NativeReloadResult>>();

  constructor(
    log: ChatEventLog,
    source: NativeHistorySource,
    isChatRunning: (chatId: string) => boolean,
  ) {
    this.#log = log;
    this.#source = source;
    this.#isChatRunning = isChatRunning;
  }

  async ensureColdLoaded(chatId: string): Promise<void> {
    if (await this.#log.hasPersistedLog(chatId)) return;
    await this.reloadFromNative(chatId, 'cold-load');
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
    const nativeMessages = await this.#source.loadNativeMessages(chatId);
    const localNotice = mode === 'process-error' ? 'The process died.' : undefined;
    const replacement = await this.#log.replaceGenerationFromNative(chatId, nativeMessages, {
      localNotice,
    });
    console.info(`native reload: ${mode} ${nativeMessages.length}`);
    return { ...replacement, mode };
  }
}
