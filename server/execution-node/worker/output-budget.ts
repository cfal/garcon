import { NodeBulkError } from '../../execution-nodes/transport/bulk-transfers.js';

/** Shares declared assembly bytes across session-bound receivers in one process. */
export class NodeOutputAssemblyBudget {
  #reserved = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid output assembly budget');
  }

  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError('Invalid output allocation');
    if (bytes > this.maxBytes - this.#reserved) throw new NodeBulkError('NODE_CAPACITY', 'Output assembly capacity is reserved');
    this.#reserved += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= bytes;
    };
  }

  get reservedBytes(): number { return this.#reserved; }
}
