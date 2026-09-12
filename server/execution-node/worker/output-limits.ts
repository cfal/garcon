import { MAX_NODE_OUTPUT_BYTES } from '@garcon/server-agent-interface';

export interface NodeWorkerOutputQueueLimits {
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly retentionMs: number;
}

export const NODE_WORKER_OUTPUT_QUEUE: NodeWorkerOutputQueueLimits = Object.freeze({
  // A finalized response can occur in both its rows and terminal before the next drain.
  maxBytes: 2 * MAX_NODE_OUTPUT_BYTES, maxRecords: 256, retentionMs: 10_000,
});

export const NODE_WORKER_OUTPUT_ASSEMBLY = Object.freeze({
  maxBytes: 32 * 1024 * 1024, maxTransferBytes: MAX_NODE_OUTPUT_BYTES, maxTransfers: 64, retentionMs: 10_000,
});
