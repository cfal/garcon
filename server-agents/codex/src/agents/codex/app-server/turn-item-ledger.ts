import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { loadCodexChatMessages } from '../history-loader.js';
import { convertCodexAppServerLiveItem } from './converter.js';
import type { CodexThreadItem } from './protocol.js';

export class CodexTurnItemLedger {
  readonly #seenIds = new Set<string>();
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
    const messages = await loadCodexChatMessages(nativePath, this.#logger, { throwOnError: true });
    this.recordMessages(messages);
  }

  markManualCompaction(): void {
    this.#manualCompactionPending = true;
  }

  emit(item: CodexThreadItem): void {
    if (this.#seenIds.has(item.id)) return;
    this.#seenIds.add(item.id);
    const compactionTrigger = item.type === 'contextCompaction'
      ? this.#manualCompactionPending ? 'manual' : 'auto'
      : undefined;
    if (item.type === 'contextCompaction') this.#manualCompactionPending = false;
    const messages = convertCodexAppServerLiveItem(item, undefined, compactionTrigger);
    if (messages.length) this.#emit(messages);
  }

  recordMessages(messages: ChatMessage[]): void {
    for (const message of messages) {
      const toolId = messageToolId(message);
      if (toolId) this.#seenIds.add(toolId);
    }
  }

  async reconcileInterrupted(nativePath: string | null): Promise<void> {
    if (!nativePath) return;
    try {
      // Loaded turn views omit interrupted commands, while the JSONL is complete before turn/completed.
      const messages = await loadCodexChatMessages(nativePath, this.#logger, { throwOnError: true });
      const missingIds = new Set<string>();
      for (const message of messages) {
        const toolId = messageToolId(message);
        if (toolId && !this.#seenIds.has(toolId)) missingIds.add(toolId);
      }
      if (!missingIds.size) return;
      for (const id of missingIds) this.#seenIds.add(id);
      this.#emit(
        messages.filter((message) => {
          const toolId = messageToolId(message);
          return toolId ? missingIds.has(toolId) : false;
        }),
      );
    } catch (error) {
      this.#logger.warn('Codex interrupted turn item reconciliation failed', {
        nativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function messageToolId(message: ChatMessage): string | null {
  return 'toolId' in message && typeof message.toolId === 'string' ? message.toolId : null;
}
