// Notifications consume live events and cached metadata, never transcript history.

import {
  AssistantMessage,
  isAbortAcknowledged,
} from '../../../common/chat-types.js';
import type { TranscriptCommitEvent } from '../ledger/service.js';
import type { TelegramNotifier } from './telegram.js';
import { createLogger } from '../../common/log.js';
import { resolveChatTitle } from '../chats/chat-title.js';
import type { SessionStoppedCallback, TurnFailedCallback } from '../chat-execution/types.js';

const logger = createLogger('notifications:attention-tracker');

const TITLE_LENGTH = 120;
const INPUT_EXCERPT_LENGTH = 200;
const DETAIL_EXCERPT_LENGTH = 400;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(text: string, maxLen: number): string {
  const oneLine = text.slice(0, maxLen * 4).replace(/\n+/g, ' ').trim();
  if (text.length <= maxLen * 4 && oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '\u2026';
}

// Derives a human-readable tool name from a ToolUseChatMessage type field.
function toolDisplayName(requestedTool: unknown): string {
  const t = requestedTool as { type?: string; rawName?: string } | undefined;
  if (!t) return 'unknown';
  if (typeof t.type === 'string' && t.type !== 'unknown-tool-use') {
    return t.type.replace(/-tool-use$/, '').replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  if (t.rawName) return t.rawName;
  return 'unknown';
}

// Minimal interfaces for injected dependencies. Avoids importing concrete
// classes and keeps the module unit-testable with plain mocks.

interface AgentRegistryDep {
  onTranscriptCommitted(cb: (event: TranscriptCommitEvent) => void): void;
}

interface QueueManagerDep {
  onChatIdle(cb: (chatId: string) => void): void;
  onSessionStopped(cb: SessionStoppedCallback): void;
  onTurnFailed(cb: TurnFailedCallback): void;
}

interface SettingsStoreDep {
  getUiSettings(): Record<string, unknown>;
  getChatName(chatId: string): string | null;
}

interface ChatRegistryDep {
  getChat(chatId: string): { agentId: string; projectPath: string } | null;
  onChatRemoved?(cb: (chatId: string) => void): void;
}

interface ChatMetadataDep {
  getChatMetadata(chatId: string): { firstMessage: string } | null;
}

interface TurnResult {
  turnId: string | null;
  reason: 'completed' | 'failed';
  detail?: string;
}

interface TelegramSettingsDep {
  getRecipientChatId(): string;
}

export class AttentionTracker {
  #agents: AgentRegistryDep;
  #queue: QueueManagerDep;
  #settings: SettingsStoreDep;
  #registry: ChatRegistryDep;
  #metadata: ChatMetadataDep;
  #telegram: TelegramNotifier;
  #telegramSettings: TelegramSettingsDep;

  // Tracks pending permission occurrences per chat to avoid duplicate
  // notifications and to suppress idle notifications when a permission
  // is already being surfaced.
  #pendingPermissions = new Map<string, Set<string>>();

  #lastTurnResult = new Map<string, TurnResult>();
  #lastAssistantMessage = new Map<string, string>();
  #lastUserMessage = new Map<string, string>();

  // Prevents repeated idle events for one settle from composing duplicate notifications.
  #notifiedTurns = new Map<string, string | null>();

  constructor(
    agents: AgentRegistryDep,
    queue: QueueManagerDep,
    settings: SettingsStoreDep,
    registry: ChatRegistryDep,
    metadata: ChatMetadataDep,
    telegram: TelegramNotifier,
    telegramSettings: TelegramSettingsDep,
  ) {
    this.#agents = agents;
    this.#queue = queue;
    this.#settings = settings;
    this.#registry = registry;
    this.#metadata = metadata;
    this.#telegram = telegram;
    this.#telegramSettings = telegramSettings;

    this.#wire();
  }

  #wire(): void {
    this.#agents.onTranscriptCommitted((event) => this.#handleTranscriptCommit(event));
    this.#queue.onChatIdle((chatId) => this.#handleChatIdle(chatId));
    this.#queue.onTurnFailed((chatId, message, options) => {
      // Dispatch may fail before a ledger run exists; terminal events otherwise win.
      const turnId = options.turnId ?? null;
      if (this.#wasNotified(chatId, turnId)) return;
      if (turnId && this.#lastTurnResult.get(chatId)?.turnId === turnId) return;
      this.#notifiedTurns.delete(chatId);
      this.#lastTurnResult.set(chatId, {
        turnId,
        reason: 'failed',
        detail: truncate(message, DETAIL_EXCERPT_LENGTH),
      });
    });
    this.#queue.onSessionStopped((chatId, outcome, _intent, turn) => {
      if (isAbortAcknowledged(outcome)) this.#handleSessionStopped(chatId, turn?.turnId ?? null);
    });
    this.#registry.onChatRemoved?.((chatId) => {
      this.#cleanupChat(chatId);
      this.#notifiedTurns.delete(chatId);
    });
  }

  #handleTranscriptCommit(event: TranscriptCommitEvent): void {
    if (event.type === 'view-replaced') {
      this.#cleanupChat(event.chatId);
      this.#notifiedTurns.delete(event.chatId);
      return;
    }
    if (event.type === 'rows') {
      for (const row of event.rows) {
        if (row.kind === 'user-input') {
          this.#notifiedTurns.delete(event.chatId);
          this.#lastTurnResult.delete(event.chatId);
          this.#lastAssistantMessage.delete(event.chatId);
          this.#lastUserMessage.set(event.chatId, truncate(row.detail.message.content, INPUT_EXCERPT_LENGTH));
        } else if (row.kind === 'provider-row' && row.message instanceof AssistantMessage) {
          this.#lastAssistantMessage.set(event.chatId, truncate(row.message.content, DETAIL_EXCERPT_LENGTH));
        }
      }
      return;
    }
    if (event.type === 'run-ended') {
      if (this.#wasNotified(event.chatId, event.runId)) return;
      this.#pendingPermissions.delete(event.chatId);
      this.#notifiedTurns.delete(event.chatId);
      if (event.row.outcome === 'finished') {
        this.#lastTurnResult.set(event.chatId, { turnId: event.runId, reason: 'completed' });
        if (event.finalResponse) {
          this.#lastAssistantMessage.set(event.chatId, truncate(event.finalResponse.text, DETAIL_EXCERPT_LENGTH));
        }
      } else if (event.row.outcome === 'failed') {
        this.#lastTurnResult.set(event.chatId, {
          turnId: event.runId,
          reason: 'failed',
          detail: truncate(event.row.error?.message ?? event.row.error?.code ?? '', DETAIL_EXCERPT_LENGTH),
        });
      } else {
        this.#lastTurnResult.delete(event.chatId);
        this.#lastAssistantMessage.delete(event.chatId);
      }
      return;
    }
    if (event.type !== 'permission') return;
    const lifecycle = event.row.lifecycle;
    if (lifecycle.kind === 'requested') {
      if (!event.runId) return;
      this.#trackPermission(
        event.chatId,
        lifecycle.permissionOccurrenceId,
        toolDisplayName(lifecycle.requestedTool),
      );
      return;
    }
    this.#clearPermission(event.chatId, lifecycle.permissionOccurrenceId);
  }

  #trackPermission(
    chatId: string,
    permissionOccurrenceId: string,
    toolName: string,
  ): void {
    let ids = this.#pendingPermissions.get(chatId);
    if (!ids) {
      ids = new Set();
      this.#pendingPermissions.set(chatId, ids);
    }
    if (ids.has(permissionOccurrenceId)) return;
    ids.add(permissionOccurrenceId);

    void this.#sendNotification(
      chatId, this.#lastUserMessage.get(chatId) ?? null, null, `Needs permission: ${toolName}`,
    );
  }

  #clearPermission(chatId: string, permissionOccurrenceId: string): void {
    const ids = this.#pendingPermissions.get(chatId);
    if (!ids) return;
    ids.delete(permissionOccurrenceId);
    if (ids.size === 0) this.#pendingPermissions.delete(chatId);
  }

  #handleChatIdle(chatId: string): void {
    // If a permission request is already pending, the user was already
    // notified about that. Skip the idle notification.
    if (this.#pendingPermissions.has(chatId)) return;

    const result = this.#lastTurnResult.get(chatId);
    if (!result) return;
    this.#notifiedTurns.set(chatId, result.turnId);
    const userMsg = this.#lastUserMessage.get(chatId) ?? null;
    let assistantMsg = this.#lastAssistantMessage.get(chatId) ?? null;

    let status: string | null = null;
    if (result.reason === 'failed') {
      status = result.detail ? `Failed: ${result.detail}` : 'Failed';
      assistantMsg = null;
    }

    this.#cleanupChat(chatId);
    void this.#sendNotification(chatId, userMsg, assistantMsg, status);
  }

  #handleSessionStopped(chatId: string, turnId: string | null): void {
    if (this.#wasNotified(chatId, turnId)) return;
    this.#notifiedTurns.set(chatId, turnId);
    const userMsg = this.#lastUserMessage.get(chatId) ?? null;

    this.#cleanupChat(chatId);
    void this.#sendNotification(chatId, userMsg, null, 'Stopped');
  }

  // Builds an HTML-formatted notification message.
  //
  // With generated title:        Without title:
  //   Title (bold)                 User message (bold)
  //   > user message (quote)      response or status
  //   response or status          agent - path
  //   agent - path
  #formatMessage(
    meta: { title: string; hasGeneratedTitle: boolean; agentId: string; projectPath: string },
    userMsg: string | null,
    assistantMsg: string | null,
    status: string | null,
  ): string {
    const lines: string[] = [];
    const hasTitle = meta.hasGeneratedTitle;
    if (hasTitle) {
      lines.push(`<b>${escapeHtml(meta.title)}</b>`);
      if (userMsg) {
        lines.push(`<blockquote>${escapeHtml(truncate(userMsg, INPUT_EXCERPT_LENGTH))}</blockquote>`);
      }
    } else if (userMsg) {
      lines.push(`<b>${escapeHtml(truncate(userMsg, TITLE_LENGTH))}</b>`);
    } else {
      lines.push(`<b>${escapeHtml(meta.title)}</b>`);
    }
    if (status) {
      lines.push(escapeHtml(status));
    } else if (assistantMsg) {
      lines.push(escapeHtml(truncate(assistantMsg, DETAIL_EXCERPT_LENGTH)));
    }
    const pathShort = meta.projectPath.replace(/^\/home\/[^/]+\//, '~/');
    lines.push(`<code>${escapeHtml(meta.agentId)} - ${escapeHtml(pathShort)}</code>`);
    return lines.join('\n');
  }

  #cleanupChat(chatId: string): void {
    this.#pendingPermissions.delete(chatId);
    this.#lastTurnResult.delete(chatId);
    this.#lastAssistantMessage.delete(chatId);
    this.#lastUserMessage.delete(chatId);
  }

  #wasNotified(chatId: string, turnId: string | null): boolean {
    return this.#notifiedTurns.has(chatId)
      && (turnId === null || this.#notifiedTurns.get(chatId) === turnId);
  }

  #chatMeta(chatId: string): { title: string; hasGeneratedTitle: boolean; agentId: string; projectPath: string } {
    const chat = this.#registry.getChat(chatId);
    const generatedTitle = this.#settings.getChatName(chatId);
    const title = truncate(resolveChatTitle(
      generatedTitle,
      this.#metadata.getChatMetadata(chatId)?.firstMessage || chatId.slice(0, 8),
    ), TITLE_LENGTH);
    return {
      title,
      hasGeneratedTitle: Boolean(generatedTitle),
      agentId: chat?.agentId ?? 'unknown',
      projectPath: chat?.projectPath ?? '',
    };
  }

  async #sendNotification(
    chatId: string,
    userMsg: string | null,
    assistantMsg: string | null,
    status: string | null,
  ): Promise<void> {
    if (!this.#telegram.isConfigured) return;
    try {
      const ui = this.#settings.getUiSettings();
      const notifications = (ui.notifications ?? {}) as Record<string, unknown>;
      const config = (notifications.telegram ?? {}) as Record<string, unknown>;
      const recipientChatId = this.#telegramSettings.getRecipientChatId();
      if (config.enabled !== true || !recipientChatId || !this.#registry.getChat(chatId)) return;
      const html = this.#formatMessage(this.#chatMeta(chatId), userMsg, assistantMsg, status);
      const ok = await this.#telegram.send(recipientChatId, html, 'HTML');
      if (!ok) {
        logger.warn(`attention: telegram delivery failed for chat ${chatId}`);
      }
    } catch (err: unknown) {
      logger.warn('attention: settings read error:', (err as Error).message);
    }
  }
}
