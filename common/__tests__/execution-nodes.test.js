import { expect, test } from 'bun:test';
import { ExecutionNodesChangedMessage, parseServerWsMessage } from '../ws-events.ts';
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
    .toEqual({ label: 'Worker', direction: 'node-connects', allowInsecureDevelopment: undefined, allowUnverifiedTls: undefined });
  expect(parseCreateExecutionNodeRequest({ label: 'Worker', direction: 'controller-connects' })).toBeNull();
  expect(parseCreateExecutionNodeRequest({ label: 'Worker', direction: 'node-connects', secret: 'hidden' })).toBeNull();
  expect(parseUpdateExecutionNodeRequest({})).toBeNull();
  expect(parseUpdateExecutionNodeRequest({ enabled: false })).toEqual({ enabled: false });
  expect(parseUpdateExecutionNodeRequest({ label: ' ' })).toBeNull();
  expect(parseUpdateExecutionNodeRequest({ connection: { direction: 'node-connects', connectionUrl: 'url' } })).toBeNull();
});

test('certificate verification opt-out is explicit and only applies to the dialing controller', () => {
  const request = { label: 'Worker', direction: 'controller-connects', connectionUrl: 'wss://worker.test/execution-node#secret=synthetic' };
  expect(parseCreateExecutionNodeRequest({ ...request, allowUnverifiedTls: true })?.allowUnverifiedTls).toBe(true);
  expect(parseCreateExecutionNodeRequest({ ...request, allowUnverifiedTls: 'true' })).toBeNull();
  expect(parseCreateExecutionNodeRequest({ label: 'Worker', direction: 'node-connects', allowUnverifiedTls: true })).toBeNull();
  const connection = { direction: 'controller-connects', connectionUrl: request.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true };
  expect(parseUpdateExecutionNodeRequest({ connection })).toEqual({ connection });
  expect(parseUpdateExecutionNodeRequest({ connection: { ...connection, direction: 'node-connects' } })).toBeNull();
  expect(parseUpdateExecutionNodeRequest({ connection: { ...connection, allowUnverifiedTls: 1 } })).toBeNull();
});

test('public snapshots exclude credentials and preserve unavailable remote targets', () => {
  const remote = {
    id: remoteId, label: 'Worker', enabled: true, kind: 'remote', direction: 'node-connects',
    availability: 'offline', instanceId: null, projectBasePath: null, lastError: null,
    machineServices: { files: false, git: false, gh: false, terminals: false },
  };
  expect(parseExecutionNodes([remote])).toEqual([remote]);
  const ready = { ...remote, availability: 'ready', instanceId: 'synthetic-instance', projectBasePath: '/' };
  const readyMessage = new ExecutionNodesChangedMessage([ready]);
  expect(parseServerWsMessage(JSON.parse(JSON.stringify(readyMessage)))).toEqual(readyMessage);
  for (const instanceId of [undefined, '', 3, {}, 'x'.repeat(129)]) {
    expect(parseExecutionNodes([{ ...remote, instanceId }])).toBeNull();
  }
  const message = new ExecutionNodesChangedMessage([remote]);
  expect(parseServerWsMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  for (const extra of [{ secret: 'hidden' }, { connectionUrl: 'hidden' }]) {
    expect(parseExecutionNodes([{ ...remote, ...extra }])).toBeNull();
    expect(parseServerWsMessage({ type: 'execution-nodes-changed', nodes: [{ ...remote, ...extra }] })).toBeNull();
  }
  expect(parseExecutionNodes([remote, remote])).toBeNull();
  expect(parseExecutionNodes([{ ...remote, id: 'local' }])).toBeNull();
});
