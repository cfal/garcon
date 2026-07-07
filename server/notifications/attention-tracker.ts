// Translates low-level agent and queue events into provider-agnostic
// attention notifications when a chat requires user attention.
//
// Three notification triggers:
// 1. Permission request  - immediate, deduped by permissionRequestId
// 2. Chat idle           - turn finished and queue drained (completed/failed)
// 3. Session stopped     - user-initiated abort

import { PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage, AssistantMessage } from '../../common/chat-types.js';
import type { ChatMessage, ToolUseChatMessage } from '../../common/chat-types.js';
import { randomUUID } from 'crypto';
import type { AttentionChatMeta, AttentionNotification, AttentionReason, AttentionSink } from './attention-events.js';
import { truncateNotificationText } from './attention-events.js';
import { TelegramAttentionSink, userMessageContent } from './telegram-attention-sink.js';
import type { TelegramNotifier } from './telegram.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('notifications:attention-tracker');

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
  onMessages(cb: (chatId: string, messages: unknown[]) => void): void;
  onFinished(cb: (chatId: string, exitCode: number) => void): void;
  onFailed(cb: (chatId: string, errorMessage: string) => void): void;
}

interface QueueManagerDep {
  onChatIdle(cb: (chatId: string) => void): void;
  onSessionStopped(cb: (chatId: string, success: boolean) => void): void;
}

interface SettingsStoreDep {
  getChatName(chatId: string): string | null;
  getUiSettings(): Record<string, unknown> | Promise<Record<string, unknown>>;
}

interface ChatRegistryDep {
  getChat(chatId: string): { agentId: string; projectPath: string } | null;
  onChatRemoved?(cb: (chatId: string) => void): void;
}

interface ChatMessageReaderDep {
  getMessages(chatId: string): ChatMessage[] | null;
}

interface TurnResult {
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
  #history: ChatMessageReaderDep;
  #sinks: AttentionSink[];

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
    agents: AgentRegistryDep,
    queue: QueueManagerDep,
    settings: SettingsStoreDep,
    registry: ChatRegistryDep,
    history: ChatMessageReaderDep,
    sinks: AttentionSink[],
  );
  constructor(
    agents: AgentRegistryDep,
    queue: QueueManagerDep,
    settings: SettingsStoreDep,
    registry: ChatRegistryDep,
    history: ChatMessageReaderDep,
    telegram: TelegramNotifier,
    telegramSettings: TelegramSettingsDep,
  );
  constructor(
    agents: AgentRegistryDep,
    queue: QueueManagerDep,
    settings: SettingsStoreDep,
    registry: ChatRegistryDep,
    history: ChatMessageReaderDep,
    sinksOrTelegram: AttentionSink[] | TelegramNotifier,
    telegramSettings?: TelegramSettingsDep,
  ) {
    this.#agents = agents;
    this.#queue = queue;
    this.#settings = settings;
    this.#registry = registry;
    this.#history = history;
    this.#sinks = Array.isArray(sinksOrTelegram)
      ? sinksOrTelegram
      : [
        new TelegramAttentionSink({
          settings,
          telegram: sinksOrTelegram,
          telegramSettings: telegramSettings!,
        }),
      ];

    this.#wire();
  }

  #wire(): void {
    this.#agents.onMessages((chatId, messages) => this.#handleMessages(chatId, messages));
    this.#agents.onFinished((chatId, exitCode) => this.#handleFinished(chatId, exitCode));
    this.#agents.onFailed((chatId, errorMessage) => this.#handleFailed(chatId, errorMessage));
    this.#queue.onChatIdle((chatId) => this.#handleChatIdle(chatId));
    this.#queue.onSessionStopped((chatId) => this.#handleSessionStopped(chatId));
    this.#registry.onChatRemoved?.((chatId) => this.#cleanupChat(chatId));
  }

  #handleMessages(chatId: string, messages: unknown[]): void {
    for (const msg of messages) {
      if (msg instanceof AssistantMessage) {
        this.#lastAssistantMessage.set(chatId, msg.content);
      } else if (msg instanceof PermissionRequestMessage) {
        this.#trackPermission(chatId, msg.permissionRequestId, msg.requestedTool);
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
      const content = userMessageContent(messages[i]);
      if (content) return content;
    }
    return null;
  }

  #trackPermission(chatId: string, permissionRequestId: string, requestedTool: ToolUseChatMessage): void {
    let ids = this.#pendingPermissions.get(chatId);
    if (!ids) {
      ids = new Set();
      this.#pendingPermissions.set(chatId, ids);
    }
    if (ids.has(permissionRequestId)) return;
    ids.add(permissionRequestId);

    const meta = this.#chatMeta(chatId);
    const userMsg = this.#getLastUserMessage(chatId);
    const toolName = toolDisplayName(requestedTool);
    this.#publish(this.#createNotification({
      chatId,
      reason: 'permission-required',
      meta,
      userMessage: userMsg,
      assistantMessage: null,
      status: `Needs permission: ${toolName}`,
      requestedTool,
    }));
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
    this.#publish(this.#createNotification({
      chatId,
      reason,
      meta,
      userMessage: userMsg,
      assistantMessage: reason === 'failed' ? null : assistantMsg,
      status,
    }));
  }

  #handleSessionStopped(chatId: string): void {
    this.#pendingPermissions.delete(chatId);

    const meta = this.#chatMeta(chatId);
    const userMsg = this.#getLastUserMessage(chatId);

    this.#cleanupChat(chatId);
    this.#publish(this.#createNotification({
      chatId,
      reason: 'stopped',
      meta,
      userMessage: userMsg,
      assistantMessage: null,
      status: 'Stopped',
    }));
  }

  #cleanupChat(chatId: string): void {
    this.#pendingPermissions.delete(chatId);
    this.#lastTurnResult.delete(chatId);
    this.#lastAssistantMessage.delete(chatId);
  }

  #chatMeta(chatId: string): AttentionChatMeta {
    const chat = this.#registry.getChat(chatId);
    const generatedTitle = this.#settings.getChatName(chatId);
    const title = generatedTitle
      || this.#titleFromHistory(chatId)
      || chatId.slice(0, 8);
    return {
      title,
      hasGeneratedTitle: Boolean(generatedTitle),
      agentId: chat?.agentId ?? 'unknown',
      projectPath: chat?.projectPath ?? '',
    };
  }

  // Falls back to the first user message as a title when no chat name exists.
  #titleFromHistory(chatId: string): string | null {
    const messages = this.#history.getMessages(chatId);
    if (!messages) return null;
    for (const msg of messages) {
      const content = userMessageContent(msg);
      if (content) return truncateNotificationText(content, 60);
    }
    return null;
  }

  #createNotification({
    chatId,
    reason,
    meta,
    userMessage,
    assistantMessage,
    status,
    requestedTool,
  }: {
    chatId: string;
    reason: AttentionReason;
    meta: AttentionChatMeta;
    userMessage: string | null;
    assistantMessage: string | null;
    status: string | null;
    requestedTool?: ToolUseChatMessage;
  }): AttentionNotification {
    const title = meta.hasGeneratedTitle
      ? meta.title
      : userMessage
        ? truncateNotificationText(userMessage, 80)
        : meta.title;
    const body = status
      ?? (assistantMessage ? truncateNotificationText(assistantMessage, 120) : title);
    return {
      id: `${chatId}:${reason}:${Date.now()}:${randomUUID()}`,
      chatId,
      reason,
      title,
      body,
      status,
      userMessage,
      assistantMessage,
      requestedTool,
      createdAt: new Date().toISOString(),
      meta,
    };
  }

  async #publish(event: AttentionNotification): Promise<void> {
    const results = await Promise.allSettled(this.#sinks.map((sink) => sink.notify(event)));
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('attention: sink delivery failed:', (result.reason as Error).message);
      }
    }
  }
}
