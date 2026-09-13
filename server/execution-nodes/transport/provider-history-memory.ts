import { NodeBulkError } from './bulk-transfers.js';

export interface NodeHistoryMemoryReservation {
  reduceTo(bytes: number): void;
  release(): void;
}

/** Shares retained encoding and transient codec storage across imports in one endpoint. */
export class NodeHistoryMemoryBudget {
  #reservedBytes = 0;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid history memory budget');
  }

  reserve(bytes: number): NodeHistoryMemoryReservation {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TypeError('Invalid history memory reservation');
    if (bytes > this.maxBytes - this.#reservedBytes) throw new NodeBulkError('NODE_CAPACITY', 'History transport memory is reserved');
    this.#reservedBytes += bytes;
    let retained = bytes;
    return {
      reduceTo: (remaining) => {
        if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining > retained) throw new TypeError('Invalid history reservation reduction');
        this.#reservedBytes -= retained - remaining;
        retained = remaining;
      },
      release: () => { this.#reservedBytes -= retained; retained = 0; },
    };
  }

  get reservedBytes(): number { return this.#reservedBytes; }
}
