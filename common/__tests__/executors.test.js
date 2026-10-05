import { expect, test } from 'bun:test';
import { ExecutorsChangedMessage, parseServerWsMessage } from '../ws-events.ts';
import {
  effectiveExecutorId, parseExecutorId, parseCreateExecutorRequest, parseUpdateExecutorRequest,
  parseExecutors, isExecutorSecret,
} from '../executors.ts';

const remoteId = '22222222-2222-4222-8222-222222222222';

test('executor secrets match canonical 32-byte base64url encoding in browser and worker', () => {
  for (const suffix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    const secret = 'A'.repeat(42) + suffix;
    const bytes = Buffer.from(secret, 'base64url');
    expect(isExecutorSecret(secret)).toBe(bytes.length === 32 && bytes.toString('base64url') === secret);
  }
  for (let byte = 0; byte <= 255; byte++) expect(isExecutorSecret(Buffer.alloc(32, byte).toString('base64url'))).toBe(true);
  for (const value of [null, undefined, 3, '', 'A'.repeat(42), 'A'.repeat(44), '+'.repeat(43), '/'.repeat(43), 'A'.repeat(43) + '=']) {
    expect(isExecutorSecret(value)).toBe(false);
  }
});

test('only absent or null executor identity defaults to Local', () => {
  for (const value of [undefined, null, 'local']) expect(parseExecutorId(value)).toBe('local');
  expect(effectiveExecutorId(remoteId)).toBe(remoteId);
  expect(parseExecutorId(remoteId)).toBe(remoteId);
  for (const value of ['', 'unknown', 'LOCAL', 3, {}, []]) expect(parseExecutorId(value)).toBeNull();
});

test('executor mutation contracts reject incomplete and extraneous fields', () => {
  expect(parseCreateExecutorRequest({ label: ' Worker ', direction: 'executor-connects' }))
    .toEqual({ label: 'Worker', direction: 'executor-connects', noTls: undefined, allowUnverifiedTls: undefined });
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
  const connection = { direction: 'controller-connects', connectionUrl: request.connectionUrl, noTls: false, allowUnverifiedTls: true };
  expect(parseUpdateExecutorRequest({ connection })).toEqual({ connection });
  expect(parseUpdateExecutorRequest({ connection: { ...connection, direction: 'executor-connects' } })).toBeNull();
  expect(parseUpdateExecutorRequest({ connection: { ...connection, allowUnverifiedTls: 1 } })).toBeNull();
});

test('management grants are explicit booleans independent of workspace CLI access', () => {
  const request = { label: 'Worker', direction: 'executor-connects' };
  for (const allowExecutorManagement of [true, false]) {
    expect(parseCreateExecutorRequest({ ...request, allowExecutorManagement })?.allowExecutorManagement).toBe(allowExecutorManagement);
    expect(parseUpdateExecutorRequest({ allowExecutorManagement })).toEqual({ allowExecutorManagement });
  }
  for (const allowExecutorManagement of [null, 'true', 1, {}]) {
    expect(parseCreateExecutorRequest({ ...request, allowExecutorManagement })).toBeNull();
    expect(parseUpdateExecutorRequest({ allowExecutorManagement })).toBeNull();
  }
});

test('connection updates permit an omitted URL but reject empty or malformed URL fields', () => {
  for (const direction of ['executor-connects', 'controller-connects']) {
    const connection = { direction, noTls: true };
    expect(parseUpdateExecutorRequest({ connection })).toEqual({ connection });
    for (const connectionUrl of ['', null, 3]) {
      expect(parseUpdateExecutorRequest({ connection: { ...connection, connectionUrl } })).toBeNull();
    }
  }
});

test('public snapshots exclude credentials and preserve unavailable remote targets', () => {
  const remote = {
    id: remoteId, label: 'Worker', enabled: true, kind: 'remote', direction: 'executor-connects',
    availability: 'offline', instanceId: null, projectBasePath: null, lastError: null,
    bulk: { availability: 'offline', lastError: null },
    machineServices: { files: false, git: false, gh: false, terminals: false, directoryCreation: false },
    allowControllerCli: false, allowExecutorManagement: false,
  };
  expect(parseExecutors([remote])).toEqual([remote]);
  const ready = { ...remote, availability: 'ready', instanceId: 'synthetic-instance', projectBasePath: '/' };
  const readyMessage = new ExecutorsChangedMessage([ready]);
  expect(parseServerWsMessage(JSON.parse(JSON.stringify(readyMessage)))).toEqual(readyMessage);
  const reconnecting = { ...ready, availability: 'reconnecting' };
  expect(parseExecutors([reconnecting])).toEqual([reconnecting]);
  expect(parseExecutors([{ ...ready, availability: 'resuming' }])).toBeNull();
  for (const instanceId of [undefined, '', 3, {}, 'x'.repeat(129)]) {
    expect(parseExecutors([{ ...remote, instanceId }])).toBeNull();
  }
  const message = new ExecutorsChangedMessage([remote]);
  expect(parseServerWsMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  const { directoryCreation, ...withoutDirectoryCreation } = remote.machineServices;
  expect(directoryCreation).toBe(false);
  for (const machineServices of [withoutDirectoryCreation, { ...remote.machineServices, directoryCreation: 'yes' }]) {
    expect(parseExecutors([{ ...remote, machineServices }])).toBeNull();
  }
  for (const extra of [{ secret: 'hidden' }, { connectionUrl: 'hidden' }]) {
    expect(parseExecutors([{ ...remote, ...extra }])).toBeNull();
    expect(parseServerWsMessage({ type: 'executors-changed', executors: [{ ...remote, ...extra }] })).toBeNull();
  }
  expect(parseExecutors([remote, remote])).toBeNull();
  expect(parseExecutors([{ ...remote, id: 'local' }])).toBeNull();
  for (const availability of ['connecting', 'ready', 'reconnecting', 'offline']) {
    const partial = { ...ready, bulk: { availability, lastError: { code: 'EXECUTOR_BULK_UNAVAILABLE', message: 'Synthetic failure' } } };
    expect(parseExecutors([partial])).toEqual([partial]);
    const message = new ExecutorsChangedMessage([partial]);
    expect(parseServerWsMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  }
  for (const bulk of [null, undefined, {}, { availability: 'waiting', lastError: null },
    { availability: 'ready', lastError: { code: 1, message: 'Invalid' } },
    { availability: 'ready', lastError: null, secret: 'hidden' }]) {
    expect(parseExecutors([{ ...remote, bulk }])).toBeNull();
  }
  const local = { ...ready, id: 'local', kind: 'local', direction: null, bulk: null };
  expect(parseExecutors([local])).toEqual([local]);
  expect(parseExecutors([{ ...local, bulk: ready.bulk }])).toBeNull();
});
