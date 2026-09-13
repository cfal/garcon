import type { NodeSessionIdentity } from '../../../common/node-operation.js';
import { DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES } from './provider-history-allocation.js';
import { NodeHistoryMemoryBudget } from './provider-history-memory.js';
import { NodeHistoryBulkReceiver } from './provider-history-receiver.js';

/** Shares one controller allocation across every configured node, connection, facet, and import. */
export class NodeHistoryReceiverPool {
  readonly #memory: NodeHistoryMemoryBudget;

  constructor(memoryBytes = DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES) {
    this.#memory = new NodeHistoryMemoryBudget(memoryBytes);
  }

  createReceiver(session: NodeSessionIdentity, signal: AbortSignal): NodeHistoryBulkReceiver {
    return new NodeHistoryBulkReceiver(this.#memory, { session, authoritySignal: signal });
  }

  get reservedBytes(): number { return this.#memory.reservedBytes; }
}
