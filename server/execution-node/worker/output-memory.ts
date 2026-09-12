import { MAX_NODE_OUTPUT_BYTES } from '@garcon/server-agent-interface';
import type { NodeReplayOptions } from '../replay-cache.js';
import { NODE_WORKER_WRITER_LIMITS } from './limits.js';
import { NODE_WORKER_OUTPUT_ASSEMBLY, NODE_WORKER_OUTPUT_QUEUE } from './output-limits.js';

export const DEFAULT_NODE_OUTPUT_MEMORY_BYTES = 512 * 1024 * 1024;

export interface NodeOutputMemoryReservation {
  readonly instanceQueues: number;
  readonly instanceEncoding: number;
  readonly workerWriters: number;
  readonly sessionAssembly: number;
  readonly replay: number;
  readonly liveDelivery: number;
  readonly sessionEncoding: number;
  readonly coordinatorAssembly: number;
  readonly coordinatorEncoding: number;
  readonly total: number;
}

/** Reserves transport storage and serialization headroom separately from provider heaps and native runtime memory. */
export function nodeOutputMemoryReservation(instanceCount: number, replay: NodeReplayOptions): NodeOutputMemoryReservation {
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0 || instanceCount > 64
    || !Number.isSafeInteger(replay.maxBytes) || replay.maxBytes < 1 || typeof replay.enabled !== 'boolean') throw new TypeError('Invalid output memory configuration');
  // Accounts for UTF-16 serialization and transient normalized/encoded copies of one maximum record per process.
  const encoding = 4 * MAX_NODE_OUTPUT_BYTES;
  const allocation = {
    instanceQueues: instanceCount * NODE_WORKER_OUTPUT_QUEUE.maxBytes,
    instanceEncoding: instanceCount * encoding,
    workerWriters: (instanceCount + 2) * NODE_WORKER_WRITER_LIMITS.maxQueuedBytes,
    sessionAssembly: NODE_WORKER_OUTPUT_ASSEMBLY.maxBytes,
    replay: replay.enabled ? 2 * replay.maxBytes : 0,
    liveDelivery: 2 * NODE_WORKER_OUTPUT_QUEUE.maxBytes,
    sessionEncoding: encoding,
    coordinatorAssembly: NODE_WORKER_OUTPUT_ASSEMBLY.maxBytes,
    coordinatorEncoding: encoding,
  };
  const total = Object.values(allocation).reduce((sum, bytes) => sum + bytes, 0);
  if (!Number.isSafeInteger(total)) throw new TypeError('Invalid output memory reservation');
  return Object.freeze({ ...allocation, total });
}

export function assertNodeOutputMemoryBudget(instanceCount: number, replay: NodeReplayOptions, budget = DEFAULT_NODE_OUTPUT_MEMORY_BYTES): void {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('Invalid node output memory budget');
  if (nodeOutputMemoryReservation(instanceCount, replay).total > budget) {
    throw new RangeError('Configured instances exceed the node output memory budget');
  }
}
