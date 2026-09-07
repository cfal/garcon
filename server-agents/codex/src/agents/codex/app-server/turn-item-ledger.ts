import type { ChatMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertCodexAppServerLiveItem } from './converter.js';
import type { CodexThreadItem } from './protocol.js';
import { codexMessageSourceIdentity } from '../message-source-identity.js';

export class CodexTurnItemLedger {
  readonly #seenIds = new Set<string>();
  readonly #emit: (
    turnId: string,
    messages: ReturnType<typeof convertCodexAppServerLiveItem>,
  ) => void;
  #manualCompactionPending = false;

  constructor(
    emit: (turnId: string, messages: ReturnType<typeof convertCodexAppServerLiveItem>) => void,
  ) {
    this.#emit = emit;
  }

  markManualCompaction(): void {
    this.#manualCompactionPending = true;
  }

  emit(turnId: string, item: CodexThreadItem): void {
    if (this.#seenIds.has(item.id)) return;
    this.#seenIds.add(item.id);
    const compactionTrigger = item.type === 'contextCompaction'
      ? this.#manualCompactionPending ? 'manual' : 'auto'
      : undefined;
    if (item.type === 'contextCompaction') this.#manualCompactionPending = false;
    const messages = convertCodexAppServerLiveItem(item, undefined, compactionTrigger);
    this.#emitWithSource(turnId, item.id, messages);
  }

  emitConverted(turnId: string, itemId: string | undefined, messages: ChatMessage[]): void {
    this.#recordMessages(messages);
    this.#emitWithSource(turnId, itemId, messages);
  }

  #emitWithSource(turnId: string, itemId: string | undefined, messages: ChatMessage[]): void {
    messages.forEach((message, withinSourceOrdinal) => {
      attachNativeMessageSource(message, codexMessageSourceIdentity({
        turnId,
        itemId,
        message,
        fallbackOrdinal: withinSourceOrdinal,
      }));
    });
    if (messages.length) this.#emit(turnId, messages);
  }

  #recordMessages(messages: ChatMessage[]): void {
    for (const message of messages) {
      const toolId = messageToolId(message);
      if (toolId) this.#seenIds.add(toolId);
    }
  }
}

function messageToolId(message: ChatMessage): string | null {
  return 'toolId' in message && typeof message.toolId === 'string' ? message.toolId : null;
}
