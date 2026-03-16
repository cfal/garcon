// Translates low-level provider and queue events into Telegram
// notifications when a chat requires user attention.
//
// Three notification triggers:
// 1. Permission request  - immediate, deduped by permissionRequestId
// 2. Chat idle           - turn finished and queue drained (completed/failed)
// 3. Session stopped     - user-initiated abort

import { PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage, AssistantMessage } from '../../common/chat-types.js';
import type { TelegramNotifier } from './telegram.js';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '\u2026';
}

// Minimal interfaces for injected dependencies. Avoids importing concrete
// classes and keeps the module unit-testable with plain mocks.

interface ProviderRegistryDep {
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

interface QueueManagerDep {
  onChatIdle(cb: (chatId: string) => void): void;
  onSessionStopped(cb: (chatId: string, success: boolean) => void): void;
}

interface SettingsStoreDep {
  getUiSettings(): Promise<Record<string, unknown>>;
  getChatName(chatId: string): string | null;
}

interface ChatRegistryDep {
  getChat(chatId: string): { provider: string; projectPath: string } | null;
}

interface HistoryCacheDep {
  getMessages(chatId: string): { type: string; content?: string }[] | null;
}

interface TurnResult {
  reason: 'completed' | 'failed';
  detail?: string;
}

interface TelegramConfig {
  enabled: boolean;
  chatId: string;
}

export class AttentionTracker {
  #providers: ProviderRegistryDep;
  #queue: QueueManagerDep;
  #settings: SettingsStoreDep;
  #registry: ChatRegistryDep;
  #history: HistoryCacheDep;
  #telegram: TelegramNotifier;

  // Tracks pending permission request IDs per chat to avoid duplicate
  // notifications and to suppress idle notifications when a permission
  // is already being surfaced.
  #pendingPermissions = new Map<string, Set<string>>();

  // Records the most recent turn outcome so the idle notification can
  // include the reason text.
  #lastTurnResult = new Map<string, TurnResult>();

  // Tracks the last assistant response per chat from onMessages.
  #lastAssistantMessage = new Map<string, string>();

  constructor(
    providers: ProviderRegistryDep,
    queue: QueueManagerDep,
    settings: SettingsStoreDep,
    registry: ChatRegistryDep,
    history: HistoryCacheDep,
    telegram: TelegramNotifier,
  ) {
    this.#providers = providers;
    this.#queue = queue;
    this.#settings = settings;
    this.#registry = registry;
    this.#history = history;
    this.#telegram = telegram;

    this.#wire();
  }

  #wire(): void {
    this.#providers.onMessages((chatId, messages) => this.#handleMessages(chatId, messages));
    this.#providers.onFinished((chatId, exitCode) => this.#handleFinished(chatId, exitCode));
    this.#providers.onFailed((chatId, errorMessage) => this.#handleFailed(chatId, errorMessage));
    this.#queue.onChatIdle((chatId) => this.#handleChatIdle(chatId));
    this.#queue.onSessionStopped((chatId) => this.#handleSessionStopped(chatId));
  }

  #handleMessages(chatId: string, messages: unknown[]): void {
    for (const msg of messages) {
      if (msg instanceof AssistantMessage) {
        this.#lastAssistantMessage.set(chatId, msg.content);
      } else if (msg instanceof PermissionRequestMessage) {
        this.#trackPermission(chatId, msg.permissionRequestId, msg.toolName);
      } else if (msg instanceof PermissionResolvedMessage) {
        this.#clearPermission(chatId, msg.permissionRequestId);
      } else if (msg instanceof PermissionCancelledMessage) {
        this.#clearPermission(chatId, msg.permissionRequestId);
      }
    }
  }

  // Reads the last user message from the history cache. This covers both
  // initial session messages (which bypass onMessages) and queued follow-ups.
  #getLastUserMessage(chatId: string): string | null {
    const messages = this.#history.getMessages(chatId);
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user-message' && messages[i].content) {
        return messages[i].content!;
      }
    }
    return null;
  }

  #trackPermission(chatId: string, permissionRequestId: string, toolName: string): void {
    let ids = this.#pendingPermissions.get(chatId);
    if (!ids) {
      ids = new Set();
      this.#pendingPermissions.set(chatId, ids);
    }
    if (ids.has(permissionRequestId)) return;
    ids.add(permissionRequestId);

    const meta = this.#chatMeta(chatId);
    const userMsg = this.#getLastUserMessage(chatId);
    this.#sendNotification(chatId, this.#formatMessage(
      meta, userMsg, null, `Needs permission: ${toolName}`,
    ));
  }

  #clearPermission(chatId: string, permissionRequestId: string): void {
    const ids = this.#pendingPermissions.get(chatId);
    if (!ids) return;
    ids.delete(permissionRequestId);
    if (ids.size === 0) this.#pendingPermissions.delete(chatId);
  }

  #handleFinished(chatId: string, exitCode: number): void {
    this.#lastTurnResult.set(chatId, {
      reason: exitCode === 0 ? 'completed' : 'failed',
      detail: exitCode !== 0 ? `exit code ${exitCode}` : undefined,
    });
  }

  #handleFailed(chatId: string, errorMessage: string): void {
    this.#lastTurnResult.set(chatId, {
      reason: 'failed',
      detail: errorMessage,
    });
  }

  #handleChatIdle(chatId: string): void {
    // If a permission request is already pending, the user was already
    // notified about that. Skip the idle notification.
    if (this.#pendingPermissions.has(chatId)) return;

    const result = this.#lastTurnResult.get(chatId);
    this.#lastTurnResult.delete(chatId);
    const reason = result?.reason ?? 'completed';
    const meta = this.#chatMeta(chatId);
    const userMsg = this.#getLastUserMessage(chatId);
    const assistantMsg = this.#lastAssistantMessage.get(chatId) ?? null;

    let status: string | null = null;
    if (reason === 'failed') {
      status = `Failed${result?.detail ? `: ${result.detail}` : ''}`;
    }

    this.#cleanupChat(chatId);
    this.#sendNotification(chatId, this.#formatMessage(
      meta, userMsg, reason === 'failed' ? null : assistantMsg, status,
    ));
  }

  #handleSessionStopped(chatId: string): void {
    this.#pendingPermissions.delete(chatId);

    const meta = this.#chatMeta(chatId);
    const userMsg = this.#getLastUserMessage(chatId);

    this.#cleanupChat(chatId);
    this.#sendNotification(chatId, this.#formatMessage(
      meta, userMsg, null, 'Stopped',
    ));
  }

  // Builds an HTML-formatted notification message.
  //
  // With generated title:        Without title:
  //   Title (bold)                 User message (bold)
  //   > user message (quote)      response or status
  //   response or status          provider · path
  //   provider · path
  #formatMessage(
    meta: { title: string; hasGeneratedTitle: boolean; provider: string; projectPath: string },
    userMsg: string | null,
    assistantMsg: string | null,
    status: string | null,
  ): string {
    const lines: string[] = [];
    const hasTitle = meta.hasGeneratedTitle;
    if (hasTitle) {
      lines.push(`<b>${escapeHtml(meta.title)}</b>`);
      if (userMsg) {
        lines.push(`<blockquote>${escapeHtml(truncate(userMsg, 200))}</blockquote>`);
      }
    } else if (userMsg) {
      lines.push(`<b>${escapeHtml(truncate(userMsg, 120))}</b>`);
    } else {
      lines.push(`<b>${escapeHtml(meta.title)}</b>`);
    }
    if (status) {
      lines.push(escapeHtml(status));
    } else if (assistantMsg) {
      lines.push(escapeHtml(truncate(assistantMsg, 400)));
    }
    const pathShort = meta.projectPath.replace(/^\/home\/[^/]+\//, '~/');
    lines.push(`<code>${escapeHtml(meta.provider)} · ${escapeHtml(pathShort)}</code>`);
    return lines.join('\n');
  }

  #cleanupChat(chatId: string): void {
    this.#lastTurnResult.delete(chatId);
    this.#lastAssistantMessage.delete(chatId);
  }

  #chatMeta(chatId: string): { title: string; hasGeneratedTitle: boolean; provider: string; projectPath: string } {
    const chat = this.#registry.getChat(chatId);
    const generatedTitle = this.#settings.getChatName(chatId);
    const title = generatedTitle
      || this.#titleFromHistory(chatId)
      || chatId.slice(0, 8);
    return {
      title,
      hasGeneratedTitle: Boolean(generatedTitle),
      provider: chat?.provider ?? 'unknown',
      projectPath: chat?.projectPath ?? '',
    };
  }

  // Falls back to the first user message as a title when no chat name exists.
  #titleFromHistory(chatId: string): string | null {
    const messages = this.#history.getMessages(chatId);
    if (!messages) return null;
    for (const msg of messages) {
      if (msg.type === 'user-message' && msg.content) {
        return truncate(msg.content, 60);
      }
    }
    return null;
  }

  async #sendNotification(chatId: string, html: string): Promise<void> {
    if (!this.#telegram.isConfigured) return;
    try {
      const config = await this.#getTelegramConfig();
      if (!config.enabled || !config.chatId) return;
      const ok = await this.#telegram.send(config.chatId, html, 'HTML');
      if (!ok) {
        console.warn(`attention: telegram delivery failed for chat ${chatId}`);
      }
    } catch (err: unknown) {
      console.warn('attention: settings read error:', (err as Error).message);
    }
  }

  async #getTelegramConfig(): Promise<TelegramConfig> {
    const ui = await this.#settings.getUiSettings();
    const notifications = (ui?.notifications ?? {}) as Record<string, unknown>;
    const telegram = (notifications?.telegram ?? {}) as Record<string, unknown>;
    return {
      enabled: telegram.enabled === true,
      chatId: typeof telegram.chatId === 'string' ? telegram.chatId : '',
    };
  }
}
