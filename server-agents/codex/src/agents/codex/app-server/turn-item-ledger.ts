import type { ChatMessage } from '@garcon/common/chat-types';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import { convertCodexAppServerLiveItem } from './converter.js';
import type { CodexThreadItem } from './protocol.js';
import { codexMessageSourceIdentity } from '../message-source-identity.js';

type EmitTurnRows = (turnId: string, messages: ChatMessage[], live: boolean) => void;

export class CodexTurnItemLedger {
  readonly #seenIds = new Set<string>();
  readonly #emit: EmitTurnRows;
  #manualCompactionPending = false;

  constructor(emit: EmitTurnRows) {
    this.#emit = emit;
  }

  markManualCompaction(): void {
    this.#manualCompactionPending = true;
  }

  emit(turnId: string, item: CodexThreadItem, live = false): void {
    if (this.#seenIds.has(item.id)) return;
    this.#seenIds.add(item.id);
    const compactionTrigger = item.type === 'contextCompaction'
      ? this.#manualCompactionPending ? 'manual' : 'auto'
      : undefined;
    if (item.type === 'contextCompaction') this.#manualCompactionPending = false;
    const messages = convertCodexAppServerLiveItem(item, undefined, compactionTrigger);
    this.#emitWithSource(turnId, item.id, messages, live && item.type === 'agentMessage' && item.delivery !== 'async');
  }

  emitConverted(turnId: string, itemId: string | undefined, messages: ChatMessage[]): void {
    this.#recordMessages(messages);
    this.#emitWithSource(turnId, itemId, messages, false);
  }

  #emitWithSource(turnId: string, itemId: string | undefined, messages: ChatMessage[], mayEmitSignal: boolean): void {
    messages.forEach((message, withinSourceOrdinal) => {
      attachNativeMessageSource(message, codexMessageSourceIdentity({
        turnId,
        itemId,
        message,
        fallbackOrdinal: withinSourceOrdinal,
      }));
    });
    if (messages.length) this.#emit(turnId, messages, mayEmitSignal);
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
