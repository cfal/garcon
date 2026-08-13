import { isToolUseMessage, type ChatMessage } from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
} from '@garcon/server-agent-common/shared/native-message-source';
import { loadCodexChatMessages } from '../history-loader.js';
import { convertCodexAppServerLiveItem } from './converter.js';
import type { CodexRawResponseItem, CodexThreadItem } from './protocol.js';

export class CodexTurnItemLedger {
  readonly #seenMessageKeys = new Set<string>();
  readonly #logger: AgentLogger;
  readonly #emit: (messages: ReturnType<typeof convertCodexAppServerLiveItem>) => void;
  #manualCompactionPending = false;

  constructor(
    logger: AgentLogger,
    emit: (messages: ReturnType<typeof convertCodexAppServerLiveItem>) => void,
  ) {
    this.#logger = logger;
    this.#emit = emit;
  }

  async seedHistory(nativePath: string | null): Promise<void> {
    if (!nativePath) return;
    const messages = await loadCodexChatMessages(
      nativePath,
      this.#logger,
      { throwOnError: true },
    );
    this.#recordMessages(messages);
  }

  markManualCompaction(): void {
    this.#manualCompactionPending = true;
  }

  emit(turnId: string, item: CodexThreadItem): void {
    const itemKey = codexItemKey(turnId, item.id);
    let compactionTrigger: 'manual' | 'auto' | undefined;
    if (item.type === 'contextCompaction') {
      compactionTrigger = this.#manualCompactionPending ? 'manual' : 'auto';
      this.#manualCompactionPending = false;
    }
    const messages = convertCodexAppServerLiveItem(item, undefined, compactionTrigger);
    messages.forEach((message, withinSourceOrdinal) => {
      attachNativeMessageSource(message, {
        entryId: itemKey,
        withinSourceOrdinal,
      });
    });
    const unseen = this.#recordUnseenMessages(messages);
    if (unseen.length) this.#emit(unseen);
  }

  recordRawMessages(
    turnId: string,
    item: CodexRawResponseItem,
    messages: ChatMessage[],
  ): ChatMessage[] {
    const source = rawResponseItemSource(turnId, item);
    if (!source) return messages;
    messages.forEach((message, index) => {
      attachNativeMessageSource(message, {
        entryId: source.entryId,
        withinSourceOrdinal: source.firstOrdinal + index,
      });
    });
    return this.#recordUnseenMessages(messages);
  }

  #recordMessages(messages: ChatMessage[]): void {
    for (const message of messages) {
      const messageKey = nativeMessageKey(message);
      if (messageKey) this.#seenMessageKeys.add(messageKey);
    }
  }

  #recordUnseenMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter((message) => {
      const messageKey = nativeMessageKey(message);
      if (!messageKey) return true;
      if (this.#seenMessageKeys.has(messageKey)) return false;
      this.#seenMessageKeys.add(messageKey);
      return true;
    });
  }

  async reconcileInterrupted(nativePath: string | null): Promise<void> {
    if (!nativePath) return;
    try {
      // Loaded turn views omit interrupted commands, while the JSONL is complete before turn/completed.
      const messages = await loadCodexChatMessages(
        nativePath,
        this.#logger,
        { throwOnError: true },
      );
      const missingMessageKeys = new Set<string>();
      for (const message of messages) {
        const messageKey = nativeMessageKey(message);
        if (
          messageToolId(message)
          && messageKey
          && !this.#seenMessageKeys.has(messageKey)
        ) {
          missingMessageKeys.add(messageKey);
        }
      }
      if (!missingMessageKeys.size) return;
      const recoverableSuffix: ChatMessage[] = [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const messageKey = nativeMessageKey(message);
        if (!messageToolId(message) || !messageKey || !missingMessageKeys.has(messageKey)) break;
        recoverableSuffix.unshift(message);
      }
      if (
        !recoverableSuffix.length
        || !hasCompleteToolOccurrences(messages, recoverableSuffix, this.#seenMessageKeys)
      ) return;
      this.#recordMessages(recoverableSuffix);
      // Only a native suffix can be appended without moving recovered tools
      // after a later message. Terminal reconciliation publishes earlier gaps.
      this.#emit(recoverableSuffix);
    } catch (error) {
      this.#logger.warn('Codex interrupted turn item reconciliation failed', {
        nativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function messageToolId(message: ChatMessage): string | null {
  if (!('toolId' in message) || typeof message.toolId !== 'string') return null;
  return message.toolId;
}

function nativeMessageKey(message: ChatMessage): string | null {
  const source = getNativeMessageRevisionSource(message);
  if (!source || source.withinSourceOrdinal === undefined) return null;
  if (source.entryId) {
    return JSON.stringify(['entry', source.entryId, source.withinSourceOrdinal]);
  }
  if (source.byteOffset !== undefined) {
    return JSON.stringify(['byte', source.byteOffset, source.withinSourceOrdinal]);
  }
  if (source.lineNumber === undefined) return null;
  return JSON.stringify(['line', source.lineNumber, source.withinSourceOrdinal]);
}

function codexItemKey(turnId: string, itemId: string): string {
  return `turn:${turnId}:item:${itemId}`;
}

function rawResponseItemSource(
  turnId: string,
  item: CodexRawResponseItem,
): { entryId: string; firstOrdinal: number } | null {
  if (
    (item.type === 'function_call' || item.type === 'function_call_output')
    && item.call_id
  ) {
    return {
      entryId: codexItemKey(turnId, item.call_id),
      firstOrdinal: item.type === 'function_call_output' ? 1 : 0,
    };
  }
  let itemId = item.id;
  if (
    !itemId
    && (item.type === 'custom_tool_call' || item.type === 'custom_tool_call_output')
    && item.call_id
  ) {
    itemId = `raw:${item.type}:${item.call_id}`;
  }
  if (!itemId) return null;
  return { entryId: codexItemKey(turnId, itemId), firstOrdinal: 0 };
}

function hasCompleteToolOccurrences(
  messages: ChatMessage[],
  recoverable: ChatMessage[],
  seenMessageKeys: ReadonlySet<string>,
): boolean {
  const recoverableKeys = new Set(recoverable.flatMap((message) => {
    const key = nativeMessageKey(message);
    return key ? [key] : [];
  }));
  const counterpartByKey = new Map<string, string>();
  const pendingByToolId = new Map<string, string[]>();
  for (const message of messages) {
    const toolId = messageToolId(message);
    const messageKey = nativeMessageKey(message);
    if (!toolId || !messageKey) continue;
    if (isToolUseMessage(message)) {
      const pending = pendingByToolId.get(toolId) ?? [];
      pending.push(messageKey);
      pendingByToolId.set(toolId, pending);
      continue;
    }
    if (message.type !== 'tool-result') continue;
    const pending = pendingByToolId.get(toolId);
    if (!pending) continue;
    const toolUseKey = pending.shift();
    if (!toolUseKey) continue;
    if (pending.length === 0) pendingByToolId.delete(toolId);
    counterpartByKey.set(toolUseKey, messageKey);
    counterpartByKey.set(messageKey, toolUseKey);
  }
  return [...recoverableKeys].every((key) => {
    const counterpart = counterpartByKey.get(key);
    return Boolean(
      counterpart
      && (recoverableKeys.has(counterpart) || seenMessageKeys.has(counterpart))
    );
  });
}
