import { expect, test } from 'bun:test';
import { allocateNodeHistoryTransport, DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES, nodeHistoryBulkLimits } from '../provider-history-allocation.js';
import { MAX_NODE_HISTORY_ROW_BYTES } from '../provider-history-row.js';

test('all configured instances divide one endpoint allocation without multiplying its default', () => {
  expect(DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES).toBe(512 * 1024 * 1024);
  expect(allocateNodeHistoryTransport(0)).toEqual({ endpointBytes: DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES, instanceBytes: 0, allocatedBytes: 0 });
  for (const count of [1, 2, 3, 8, 64]) {
    const allocation = allocateNodeHistoryTransport(count);
    expect(allocation.instanceBytes).toBe(Math.floor(DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES / count));
    expect(allocation.allocatedBytes).toBe(count * allocation.instanceBytes);
    expect(allocation.allocatedBytes).toBeLessThanOrEqual(allocation.endpointBytes);
    expect(allocation.endpointBytes - allocation.allocatedBytes).toBeLessThan(count);
  }
  expect(allocateNodeHistoryTransport(3, 10)).toEqual({ endpointBytes: 10, instanceBytes: 3, allocatedBytes: 9 });
  expect(allocateNodeHistoryTransport(64, 64).instanceBytes).toBe(1);
  expect(() => allocateNodeHistoryTransport(64, 63)).toThrow('cannot cover');
});

test('invalid allocations fail and explicit bulk limits never exceed the local allocation or wire ceiling', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => allocateNodeHistoryTransport(1, value)).toThrow();
    expect(() => nodeHistoryBulkLimits(value)).toThrow();
    if (value !== 0) expect(() => allocateNodeHistoryTransport(value)).toThrow();
  }
  for (const bytes of [1, 1000, 8 * 1024 * 1024, DEFAULT_HISTORY_TRANSPORT_MEMORY_BYTES]) {
    const limits = nodeHistoryBulkLimits(bytes);
    expect(limits.maxBytes).toBeLessThanOrEqual(bytes);
    expect(limits.maxTransferBytes).toBeLessThanOrEqual(limits.maxBytes);
    expect(limits.maxTransferBytes).toBeLessThanOrEqual(MAX_NODE_HISTORY_ROW_BYTES);
    expect(limits.maxTransfers).toBeGreaterThan(0);
  }
});
