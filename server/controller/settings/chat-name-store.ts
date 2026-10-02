import { resolveChatTitle, type DerivedChatNameInput } from '../chats/chat-title.js';
import { CHAT_TITLE_MAX_BYTES, fitDerivedChatTitle, isChatTitleWithinLimit } from '@garcon/common/chat-title-contracts';
import type {
  ProjectSettings,
  SettingsStoreContext
} from './types.js';


export class ChatNameStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getChatName(chatId: string): string | null {
    const settings = this.#context.readSettings();
    if (!chatId) return null;
    if (!settings.chatNames) return null;
    return settings.chatNames[chatId] ?? null;
  }

  async #persistSessionName(
    settings: ProjectSettings,
    chatId: string,
    title: string,
  ): Promise<boolean> {
    if (!settings.chatNames) settings.chatNames = {};
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (!isChatTitleWithinLimit(trimmed)) {
      throw new Error(`Chat title must be at most ${CHAT_TITLE_MAX_BYTES} UTF-8 bytes`);
    }
    const existing = settings.chatNames[String(chatId)] ?? '';
    if (existing === trimmed) return false;
    if (!trimmed) {
      delete settings.chatNames[String(chatId)];
    } else {
      settings.chatNames[String(chatId)] = trimmed;
    }
    await this.#context.saveAndEmitSessionName(settings, chatId, trimmed || '');
    return true;
  }

  async setSessionName(
    chatId: string,
    title: string,
  ): Promise<{ title: string; changed: boolean }> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const normalizedTitle = title.trim();
      const changed = await this.#persistSessionName(settings, chatId, normalizedTitle);
      return { title: normalizedTitle, changed };
    });
  }

  async setSessionNameIfAbsent(chatId: string, title: string): Promise<boolean> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      if (settings.chatNames?.[String(chatId)]) return false;
      await this.#persistSessionName(settings, chatId, title);
      return true;
    });
  }

  async setDerivedSessionName(input: DerivedChatNameInput): Promise<string> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const titleFor = (chatId: string) => resolveChatTitle(
        settings.chatNames[chatId],
        input.metadata.getChatMetadata(chatId)?.firstMessage,
      );
      const sourceTitle = titleFor(input.sourceChatId);
      const occupiedTitles = new Set(input.registry.listChatIds()
        .filter((chatId) => chatId !== input.chatId)
        .map(titleFor));
      let suffix = 1;
      let title = fitDerivedChatTitle(sourceTitle, ` (${suffix})`);
      while (occupiedTitles.has(title)) {
        suffix += 1;
        title = fitDerivedChatTitle(sourceTitle, ` (${suffix})`);
      }
      await this.#persistSessionName(settings, input.chatId, title);
      return title;
    });
  }

  async removeSessionName(chatId: string): Promise<void> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      if (settings.chatNames) {
        delete settings.chatNames[String(chatId)];
        await this.#context.save(settings);
      }
    });
  }
}
