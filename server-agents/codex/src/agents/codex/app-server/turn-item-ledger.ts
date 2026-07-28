import type { AgentLogger } from '@garcon/server-agent-interface';
import type { CodexAppServerClient } from './client.js';
import { convertCodexAppServerLiveItem } from './converter.js';
import type { CodexThreadItem, CodexTurn } from './protocol.js';

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

  beginTurn(): void {
    this.#seenIds.clear();
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

  async interruptedItems(
    client: CodexAppServerClient,
    threadId: string,
    turn: CodexTurn,
  ): Promise<CodexThreadItem[]> {
    try {
      // App-server may persist an interrupted command without item/completed, so reload that turn before teardown.
      const response = await client.listThreadTurns({
        threadId,
        cursor: null,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'full',
      });
      const storedTurn = response.data.find((candidate) => candidate.id === turn.id);
      if (!storedTurn || storedTurn.itemsView !== 'full') {
        throw new Error(`Interrupted Codex turn ${turn.id} was not available with full items`);
      }
      return storedTurn.items;
    } catch (error) {
      this.#logger.warn('Codex interrupted turn item reconciliation failed', {
        threadId,
        turnId: turn.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return turn.items;
    }
  }
}
