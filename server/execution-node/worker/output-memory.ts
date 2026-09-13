import { MAX_NODE_OUTPUT_BYTES } from '@garcon/server-agent-interface';
import type { NodeReplayOptions } from '../replay-cache.js';
import { NODE_SESSION_OUTPUT_RELAY_LIMITS } from '../output-relay.js';
import { NODE_WORKER_WRITER_LIMITS } from './limits.js';
import { NODE_WORKER_OUTPUT_ASSEMBLY, NODE_WORKER_OUTPUT_QUEUE } from './output-limits.js';

export const DEFAULT_NODE_OUTPUT_MEMORY_BYTES = 512 * 1024 * 1024;

export interface NodeOutputMemoryReservation {
  readonly node: {
    readonly instanceQueues: number;
    readonly instanceEncoding: number;
    readonly workerWriters: number;
    readonly sessionAssembly: number;
    readonly replay: number;
    readonly liveDelivery: number;
    readonly sessionEncoding: number;
    readonly coordinatorRelay: number;
  };
  readonly controller: { readonly assembly: number; readonly encoding: number };
  readonly nodeBytes: number;
  readonly controllerBytes: number;
  readonly totalBytes: number;
}

/** Reserves transport storage and serialization headroom separately from provider heaps and native runtime memory. */
export function nodeOutputMemoryReservation(instanceCount: number, replay: NodeReplayOptions): NodeOutputMemoryReservation {
  if (!Number.isSafeInteger(instanceCount) || instanceCount < 0 || instanceCount > 64
    || !Number.isSafeInteger(replay.maxBytes) || replay.maxBytes < 1 || typeof replay.enabled !== 'boolean') throw new TypeError('Invalid output memory configuration');
  // Accounts for UTF-16 serialization and transient normalized/encoded copies of one maximum record per process.
  const encoding = 4 * MAX_NODE_OUTPUT_BYTES;
  const node = Object.freeze({
    instanceQueues: instanceCount * NODE_WORKER_OUTPUT_QUEUE.maxBytes,
    instanceEncoding: instanceCount * encoding,
    // Each instance pipe and the coordinator/session pipe have a writer at both ends.
    workerWriters: (2 * instanceCount + 2) * NODE_WORKER_WRITER_LIMITS.maxQueuedBytes,
    sessionAssembly: NODE_WORKER_OUTPUT_ASSEMBLY.maxBytes,
    replay: replay.enabled ? 2 * replay.maxBytes : 0,
    liveDelivery: 2 * NODE_WORKER_OUTPUT_QUEUE.maxBytes,
    sessionEncoding: encoding,
    coordinatorRelay: NODE_SESSION_OUTPUT_RELAY_LIMITS.maxBytes,
  });
  const controller = Object.freeze({ assembly: NODE_WORKER_OUTPUT_ASSEMBLY.maxBytes, encoding });
  const nodeBytes = Object.values(node).reduce((sum, bytes) => sum + bytes, 0);
  const controllerBytes = Object.values(controller).reduce((sum, bytes) => sum + bytes, 0);
  const totalBytes = nodeBytes + controllerBytes;
  if (!Number.isSafeInteger(totalBytes)) throw new TypeError('Invalid output memory reservation');
  return Object.freeze({ node, controller, nodeBytes, controllerBytes, totalBytes });
}

export function assertNodeOutputMemoryBudget(instanceCount: number, replay: NodeReplayOptions, budget = DEFAULT_NODE_OUTPUT_MEMORY_BYTES): void {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('Invalid node output memory budget');
  if (nodeOutputMemoryReservation(instanceCount, replay).nodeBytes > budget) {
    throw new RangeError('Configured instances exceed the node output memory budget');
  }
}
