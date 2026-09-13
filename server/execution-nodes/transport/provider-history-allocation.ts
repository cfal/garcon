import { DEFAULT_NODE_BULK_LIMITS, type NodeBulkLimits } from './bulk-transfers.js';
import { MAX_NODE_HISTORY_ROW_BYTES } from './provider-history-row.js';

export const DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES = 512 * 1024 * 1024;

/** Divides transport charges across configured workers; provider snapshots and caller-owned rows are separate. */
export function allocateNodeHistoryTransport(instanceCount: number, endpointBytes = DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES) {
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0 || !Number.isSafeInteger(endpointBytes) || endpointBytes < 1)
    throw new RangeError('Invalid history transport allocation');
  const instanceBytes = instanceCount ? Math.floor(endpointBytes / instanceCount) : 0;
  if (instanceCount && instanceBytes < 1) throw new RangeError('History transport budget cannot cover configured instances');
  return Object.freeze({ endpointBytes, instanceBytes, allocatedBytes: instanceCount * instanceBytes });
}

export function nodeHistoryBulkLimits(memoryBytes: number): NodeBulkLimits {
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1) throw new RangeError('Invalid history transport allocation');
  const maxBytes = Math.min(memoryBytes, DEFAULT_NODE_BULK_LIMITS.maxBytes);
  return Object.freeze({ ...DEFAULT_NODE_BULK_LIMITS, maxBytes, maxTransferBytes: Math.min(maxBytes, MAX_NODE_HISTORY_ROW_BYTES) });
}
