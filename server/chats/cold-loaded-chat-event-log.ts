import type { ChatMessage } from '../../common/chat-types.js';
import type { ChatEventLog, AppendedChatEvents, ChatEventPage, ChatEventReplay, RevisedChatEvent } from './chat-event-log.js';
import type { ChatNativeReloader } from './chat-native-reload.js';

export class ColdLoadedChatEventLog {
  constructor(
    private readonly log: ChatEventLog,
    private readonly nativeReloader: Pick<ChatNativeReloader, 'ensureColdLoaded'>,
  ) {}

  async ensureLoaded(chatId: string): Promise<void> {
    await this.nativeReloader.ensureColdLoaded(chatId);
  }

  async appendMessages(
    ...args: Parameters<ChatEventLog['appendMessages']>
  ): Promise<AppendedChatEvents> {
    await this.ensureLoaded(args[0]);
    return this.log.appendMessages(...args);
  }

  async readPage(
    ...args: Parameters<ChatEventLog['readPage']>
  ): Promise<ChatEventPage> {
    await this.ensureLoaded(args[0]);
    return this.log.readPage(...args);
  }

  async readReplay(
    ...args: Parameters<ChatEventLog['readReplay']>
  ): Promise<ChatEventReplay> {
    await this.ensureLoaded(args[0]);
    return this.log.readReplay(...args);
  }

  async reviseUserMessageDelivery(
    ...args: Parameters<ChatEventLog['reviseUserMessageDelivery']>
  ): Promise<RevisedChatEvent | null> {
    await this.ensureLoaded(args[0]);
    return this.log.reviseUserMessageDelivery(...args);
  }

  async getMessages(chatId: string): Promise<ChatMessage[]> {
    await this.ensureLoaded(chatId);
    return this.log.getMessages(chatId);
  }

  getLoadedMessages(chatId: string): ChatMessage[] | null {
    return this.log.getLoadedMessages(chatId);
  }
}
