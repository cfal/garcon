import type { ChatMessage } from '../../common/chat-types.js';
import type { AttentionNotification, AttentionSink } from './attention-events.js';
import { truncateNotificationText } from './attention-events.js';
import type { TelegramNotifier } from './telegram.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('notifications:attention-tracker');

interface SettingsStoreDep {
  getUiSettings(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

interface TelegramSettingsDep {
  getRecipientChatId(): string;
}

interface TelegramConfig {
  enabled: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function telegramConfigFromUi(ui: Record<string, unknown>): TelegramConfig {
  const notifications = (ui?.notifications ?? {}) as Record<string, unknown>;
  const telegram = (notifications?.telegram ?? {}) as Record<string, unknown>;
  return {
    enabled: telegram.enabled === true,
  };
}

export function userMessageContent(message: ChatMessage): string | null {
  return message.type === 'user-message' && 'content' in message && typeof message.content === 'string'
    ? message.content
    : null;
}

export class TelegramAttentionSink implements AttentionSink {
  #settings: SettingsStoreDep;
  #telegram: TelegramNotifier;
  #telegramSettings: TelegramSettingsDep;

  constructor({
    settings,
    telegram,
    telegramSettings,
  }: {
    settings: SettingsStoreDep;
    telegram: TelegramNotifier;
    telegramSettings: TelegramSettingsDep;
  }) {
    this.#settings = settings;
    this.#telegram = telegram;
    this.#telegramSettings = telegramSettings;
  }

  async notify(event: AttentionNotification): Promise<void> {
    if (!this.#telegram.isConfigured) return;
    try {
      const config = telegramConfigFromUi(await this.#settings.getUiSettings());
      const recipientChatId = this.#telegramSettings.getRecipientChatId();
      if (!config.enabled || !recipientChatId) return;
      const ok = await this.#telegram.send(recipientChatId, this.#formatMessage(event), 'HTML');
      if (!ok) {
        logger.warn(`attention: telegram delivery failed for chat ${event.chatId}`);
      }
    } catch (err: unknown) {
      logger.warn('attention: settings read error:', (err as Error).message);
    }
  }

  // Builds an HTML-formatted notification message.
  //
  // With generated title:        Without title:
  //   Title (bold)                 User message (bold)
  //   > user message (quote)      response or status
  //   response or status          agent - path
  //   agent - path
  #formatMessage(event: AttentionNotification): string {
    const lines: string[] = [];
    const hasTitle = event.meta.hasGeneratedTitle;
    const userMsg = event.userMessage;
    const assistantMsg = event.assistantMessage;
    const status = event.status;
    if (hasTitle) {
      lines.push(`<b>${escapeHtml(event.meta.title)}</b>`);
      if (userMsg) {
        lines.push(`<blockquote>${escapeHtml(truncateNotificationText(userMsg, 200))}</blockquote>`);
      }
    } else if (userMsg) {
      lines.push(`<b>${escapeHtml(truncateNotificationText(userMsg, 120))}</b>`);
    } else {
      lines.push(`<b>${escapeHtml(event.meta.title)}</b>`);
    }
    if (status) {
      lines.push(escapeHtml(status));
    } else if (assistantMsg) {
      lines.push(escapeHtml(truncateNotificationText(assistantMsg, 400)));
    }
    const pathShort = event.meta.projectPath.replace(/^\/home\/[^/]+\//, '~/');
    lines.push(`<code>${escapeHtml(event.meta.agentId)} - ${escapeHtml(pathShort)}</code>`);
    return lines.join('\n');
  }
}
