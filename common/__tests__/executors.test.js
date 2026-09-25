import { expect, test } from 'bun:test';
import { ExecutorsChangedMessage, parseServerWsMessage } from '../ws-events.ts';
import {
  effectiveExecutorId, parseExecutorId, parseCreateExecutorRequest, parseUpdateExecutorRequest,
  parseExecutors,
} from '../executors.ts';

const remoteId = '22222222-2222-4222-8222-222222222222';

test('only absent or null executor identity defaults to Local', () => {
  for (const value of [undefined, null, 'local']) expect(parseExecutorId(value)).toBe('local');
  expect(effectiveExecutorId(remoteId)).toBe(remoteId);
  expect(parseExecutorId(remoteId)).toBe(remoteId);
  for (const value of ['', 'unknown', 'LOCAL', 3, {}, []]) expect(parseExecutorId(value)).toBeNull();
});

test('executor mutation contracts reject incomplete and extraneous fields', () => {
  expect(parseCreateExecutorRequest({ label: ' Worker ', direction: 'executor-connects' }))
    .toEqual({ label: 'Worker', direction: 'executor-connects', allowInsecureDevelopment: undefined, allowUnverifiedTls: undefined });
  expect(parseCreateExecutorRequest({ label: 'Worker', direction: 'controller-connects' })).toBeNull();
  expect(parseCreateExecutorRequest({ label: 'Worker', direction: 'executor-connects', secret: 'hidden' })).toBeNull();
  expect(parseUpdateExecutorRequest({})).toBeNull();
  expect(parseUpdateExecutorRequest({ enabled: false })).toEqual({ enabled: false });
  expect(parseUpdateExecutorRequest({ label: ' ' })).toBeNull();
  expect(parseUpdateExecutorRequest({ connection: { direction: 'executor-connects', connectionUrl: 'url' } })).toBeNull();
});

test('certificate verification opt-out is explicit and only applies to the dialing controller', () => {
  const request = { label: 'Worker', direction: 'controller-connects', connectionUrl: 'wss://worker.test/executor#secret=synthetic' };
  expect(parseCreateExecutorRequest({ ...request, allowUnverifiedTls: true })?.allowUnverifiedTls).toBe(true);
  expect(parseCreateExecutorRequest({ ...request, allowUnverifiedTls: 'true' })).toBeNull();
  expect(parseCreateExecutorRequest({ label: 'Worker', direction: 'executor-connects', allowUnverifiedTls: true })).toBeNull();
  const connection = { direction: 'controller-connects', connectionUrl: request.connectionUrl, allowInsecureDevelopment: false, allowUnverifiedTls: true };
  expect(parseUpdateExecutorRequest({ connection })).toEqual({ connection });
  expect(parseUpdateExecutorRequest({ connection: { ...connection, direction: 'executor-connects' } })).toBeNull();
  expect(parseUpdateExecutorRequest({ connection: { ...connection, allowUnverifiedTls: 1 } })).toBeNull();
});

test('public snapshots exclude credentials and preserve unavailable remote targets', () => {
  const remote = {
    id: remoteId, label: 'Worker', enabled: true, kind: 'remote', direction: 'executor-connects',
    availability: 'offline', instanceId: null, projectBasePath: null, lastError: null,
    machineServices: { files: false, git: false, gh: false, terminals: false },
    allowControllerCli: false,
  };
  expect(parseExecutors([remote])).toEqual([remote]);
  const ready = { ...remote, availability: 'ready', instanceId: 'synthetic-instance', projectBasePath: '/' };
  const readyMessage = new ExecutorsChangedMessage([ready]);
  expect(parseServerWsMessage(JSON.parse(JSON.stringify(readyMessage)))).toEqual(readyMessage);
  for (const instanceId of [undefined, '', 3, {}, 'x'.repeat(129)]) {
    expect(parseExecutors([{ ...remote, instanceId }])).toBeNull();
  }
  const message = new ExecutorsChangedMessage([remote]);
  expect(parseServerWsMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  for (const extra of [{ secret: 'hidden' }, { connectionUrl: 'hidden' }]) {
    expect(parseExecutors([{ ...remote, ...extra }])).toBeNull();
    expect(parseServerWsMessage({ type: 'executors-changed', executors: [{ ...remote, ...extra }] })).toBeNull();
  }
  expect(parseExecutors([remote, remote])).toBeNull();
  expect(parseExecutors([{ ...remote, id: 'local' }])).toBeNull();
});
