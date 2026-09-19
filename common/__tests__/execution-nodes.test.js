import { expect, test } from 'bun:test';
import {
  effectiveNodeId, parseNodeId, parseCreateExecutionNodeRequest, parseUpdateExecutionNodeRequest,
  parseExecutionNodes,
} from '../execution-nodes.ts';

const remoteId = '22222222-2222-4222-8222-222222222222';

test('only absent or null node identity defaults to Local', () => {
  for (const value of [undefined, null, 'local']) expect(parseNodeId(value)).toBe('local');
  expect(effectiveNodeId(remoteId)).toBe(remoteId);
  expect(parseNodeId(remoteId)).toBe(remoteId);
  for (const value of ['', 'unknown', 'LOCAL', 3, {}, []]) expect(parseNodeId(value)).toBeNull();
});

test('node mutation contracts reject incomplete and extraneous fields', () => {
  expect(parseCreateExecutionNodeRequest({ label: ' Worker ', direction: 'node-connects' }))
    .toEqual({ label: 'Worker', direction: 'node-connects', allowInsecureDevelopment: undefined });
  expect(parseCreateExecutionNodeRequest({ label: 'Worker', direction: 'controller-connects' })).toBeNull();
  expect(parseCreateExecutionNodeRequest({ label: 'Worker', direction: 'node-connects', secret: 'hidden' })).toBeNull();
  expect(parseUpdateExecutionNodeRequest({})).toBeNull();
  expect(parseUpdateExecutionNodeRequest({ enabled: false })).toEqual({ enabled: false });
  expect(parseUpdateExecutionNodeRequest({ label: ' ' })).toBeNull();
  expect(parseUpdateExecutionNodeRequest({ connection: { direction: 'node-connects', connectionUrl: 'url' } })).toBeNull();
});

test('public snapshots exclude credentials and preserve unavailable remote targets', () => {
  const remote = {
    id: remoteId, label: 'Worker', enabled: true, kind: 'remote', direction: 'node-connects',
    availability: 'offline', projectBasePath: null, lastError: null,
    machineServices: { files: false, git: false, terminals: false },
  };
  expect(parseExecutionNodes([remote])).toEqual([remote]);
  for (const extra of [{ secret: 'hidden' }, { connectionUrl: 'hidden' }]) {
    expect(parseExecutionNodes([{ ...remote, ...extra }])).toBeNull();
  }
  expect(parseExecutionNodes([remote, remote])).toBeNull();
  expect(parseExecutionNodes([{ ...remote, id: 'local' }])).toBeNull();
});
