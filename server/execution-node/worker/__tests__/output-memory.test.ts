import { expect, test } from 'bun:test';
import { MAX_NODE_OUTPUT_BYTES } from '@garcon/server-agent-interface';
import { DEFAULT_NODE_REPLAY } from '../../replay-cache.js';
import { NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NODE_WORKER_OUTPUT_ASSEMBLY, NODE_WORKER_OUTPUT_QUEUE } from '../output-limits.js';
import { assertNodeOutputMemoryBudget, DEFAULT_NODE_OUTPUT_MEMORY_BYTES, nodeOutputMemoryReservation } from '../output-memory.js';

test('output capacity includes raw instance queues, string storage, assembly, writers and encoding without large allocations', () => {
  const allocation = nodeOutputMemoryReservation(64, DEFAULT_NODE_REPLAY);
  expect(allocation.instanceQueues).toBe(64 * NODE_WORKER_OUTPUT_QUEUE.maxBytes);
  expect(allocation.instanceEncoding).toBe(64 * 4 * MAX_NODE_OUTPUT_BYTES);
  expect(allocation.workerWriters).toBe(66 * NODE_WORKER_WRITER_LIMITS.maxQueuedBytes);
  expect(allocation.sessionAssembly).toBe(NODE_WORKER_OUTPUT_ASSEMBLY.maxBytes);
  expect(allocation.coordinatorAssembly).toBe(NODE_WORKER_OUTPUT_ASSEMBLY.maxBytes);
  expect(allocation.replay).toBe(2 * DEFAULT_NODE_REPLAY.maxBytes);
  expect(allocation.liveDelivery).toBe(2 * NODE_WORKER_OUTPUT_QUEUE.maxBytes);
  const { total, ...parts } = allocation;
  expect(total).toBe(Object.values(parts).reduce((sum, bytes) => sum + bytes, 0));
  expect(() => assertNodeOutputMemoryBudget(64, DEFAULT_NODE_REPLAY)).toThrow('memory budget');
  expect(() => assertNodeOutputMemoryBudget(64, DEFAULT_NODE_REPLAY, total)).not.toThrow();
  expect(() => assertNodeOutputMemoryBudget(64, DEFAULT_NODE_REPLAY, total - 1)).toThrow('memory budget');
});

test('disabled replay keeps live transit and every non-replay reservation', () => {
  const enabled = nodeOutputMemoryReservation(2, DEFAULT_NODE_REPLAY);
  const disabled = nodeOutputMemoryReservation(2, { ...DEFAULT_NODE_REPLAY, enabled: false });
  expect(disabled.replay).toBe(0);
  expect(disabled.total).toBe(enabled.total - enabled.replay);
  expect(disabled.liveDelivery).toBeGreaterThan(0);
  expect(enabled.total).toBeLessThan(DEFAULT_NODE_OUTPUT_MEMORY_BYTES);
  expect(() => assertNodeOutputMemoryBudget(2, DEFAULT_NODE_REPLAY)).not.toThrow();
});

test('the default output budget admits two instances; larger configurations require an explicit sufficient budget', () => {
  expect(nodeOutputMemoryReservation(2, DEFAULT_NODE_REPLAY).total).toBe(504 * 1024 * 1024);
  expect(() => assertNodeOutputMemoryBudget(2, DEFAULT_NODE_REPLAY)).not.toThrow();
  expect(nodeOutputMemoryReservation(3, DEFAULT_NODE_REPLAY).total).toBe(604 * 1024 * 1024);
  expect(() => assertNodeOutputMemoryBudget(3, DEFAULT_NODE_REPLAY)).toThrow('memory budget');
  expect(() => assertNodeOutputMemoryBudget(3, DEFAULT_NODE_REPLAY, 604 * 1024 * 1024)).not.toThrow();
});

test('invalid instance counts, cache sizes and declared budgets are rejected before allocation', () => {
  for (const value of [-1, 1.5, 65, NaN, Infinity]) expect(() => nodeOutputMemoryReservation(value, DEFAULT_NODE_REPLAY)).toThrow();
  for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => assertNodeOutputMemoryBudget(1, DEFAULT_NODE_REPLAY, value)).toThrow();
    expect(() => nodeOutputMemoryReservation(1, { ...DEFAULT_NODE_REPLAY, maxBytes: value })).toThrow();
  }
});

test('a session rejects output overcommit before preparing environments or spawning instance workers', async () => {
  const { NodeWorkerAuthority } = await import('../authority.js');
  const { configuration, session } = await import('./lifecycle-fixture.js');
  const { startNodeSessionRuntime } = await import('../session-runtime.js');
  const authority = new NodeWorkerAuthority({ session, signal: new AbortController().signal, poll: () => 0 });
  const connection = authority.attach(1);
  try {
    await expect(startNodeSessionRuntime({ configuration: { ...configuration(), outputMemoryBytes: 1 },
      connectionId: 1, connection, authority }, { submit() { throw new Error('Unexpected writer use'); },
      async waitForRelease() { throw new Error('Unexpected writer wait'); } })).rejects.toThrow('memory budget');
  } finally { authority.retire(); }
});
