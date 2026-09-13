import { expect, test } from 'bun:test';
import { parseNativeCleanupRetryRequest, parseNativeCleanupRetryResult, parseNativeCleanupSnapshot } from '../native-cleanup.js';

test('cleanup diagnostics round-trip only identities and explicit pending states', () => {
  const snapshot = { entries: [{ chatId: '1000000000000000', operationId: 'synthetic-operation',
    sourceEpoch: 'synthetic-source', registryEpoch: 'synthetic-restored', status: 'ownership-conflict',
    owners: [{ agentId: 'synthetic', executionLocation: { nodeId: 'node', instanceId: 'instance', workspaceId: 'workspace' } }],
    createdAt: '2026-09-13T00:00:00.000Z' }] };
  expect(parseNativeCleanupSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  const entry = snapshot.entries[0];
  for (const invalid of [{ ...entry, status: 'completed' }, { ...entry, chatId: 'invalid' },
    { ...entry, sourceEpoch: 1 }, { ...entry, createdAt: 'invalid' }, { ...entry, nativeSession: {} },
    { ...entry, owners: [{ ...entry.owners[0], settings: { private: 'synthetic' } }] }]) {
    expect(parseNativeCleanupSnapshot({ entries: [invalid] })).toBeNull();
  }
});

test('cleanup retry cannot carry a replacement owner or native reference', () => {
  const request = { chatId: '1000000000000000', operationId: 'synthetic-operation' };
  expect(parseNativeCleanupRetryRequest(request)).toEqual(request);
  for (const invalid of [{ ...request, sourceEpoch: 'replacement' }, { ...request, nativeSession: {} },
    { ...request, operationId: '' }, { operationId: request.operationId }]) expect(parseNativeCleanupRetryRequest(invalid)).toBeNull();
  expect(parseNativeCleanupRetryResult({ kind: 'scheduled' })).toEqual({ kind: 'scheduled' });
  expect(parseNativeCleanupRetryResult({ kind: 'not-found' })).toEqual({ kind: 'not-found' });
  expect(parseNativeCleanupRetryResult({ kind: 'completed' })).toBeNull();
});
