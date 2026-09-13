import { expect, mock, test } from 'bun:test';
import { MAX_NODE_NATIVE_SERVICE_BYTES, parseNodeNativeChatReference, parseNodeProviderNativeCommand, parseNodeProviderNativeReply,
  type NodeProviderNativeCommand } from '../provider-native-wire.js';
import { parseNodeWorkerServiceText, serializeNodeWorkerService } from '../../../execution-node/worker/service-protocol.js';

const nativeCommand = (): NodeProviderNativeCommand => ({ method: 'provider-native-sessions', operation: 'resolve',
  instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace', chat: {
    chatId: '1000000000000000', agentId: 'synthetic', agentSessionId: 'native / opaque', model: '', carryOverRevision: '',
    nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { sessionId: 'native / opaque', path: '/native/opaque' } },
    nativeSeedReceipt: null, settings: null,
  } });

test('native wire snapshots opaque evidence and exchanges grants without caller filesystem paths', () => {
  const input = nativeCommand();
  const command = parseNodeProviderNativeCommand(input)!;
  expect(command).toEqual(input);
  input.chat.nativeSession!.value.path = '/changed';
  expect(command.chat.nativeSession!.value.path).toBe('/native/opaque');
  expect(parseNodeProviderNativeCommand({ ...command, chat: { ...command.chat, projectPath: '/ungranted' } })).toBeNull();
  for (const operation of ['resolve', 'describe', 'release'] as const) {
    const request = { ...command, operation, ...(operation === 'release' ? { reason: 'deleted' as const } : {}) };
    const frame = { version: 1, session: { controllerBootId: 'controller', nodeBootId: 'node', logicalSessionId: 'session' },
      connectionId: 1, requestId: 1, type: 'node-worker-service-request', timeoutMs: 1000, command: parseNodeProviderNativeCommand(request)! } as const;
    expect(parseNodeWorkerServiceText(serializeNodeWorkerService(frame))).toEqual(frame);
  }
});

test('native wire rejects malformed, cross-owner and oversized private evidence before native access', () => {
  const input = nativeCommand();
  for (const chat of [{ ...input.chat, agentId: 'foreign' }, { ...input.chat, agentSessionId: '' },
    { ...input.chat, settings: { ownerId: 'foreign', schemaVersion: 1, values: {} } },
    { ...input.chat, nativeSession: { ...input.chat.nativeSession, schemaVersion: 0 } },
    { ...input.chat, nativeSeedReceipt: {} }, { ...input.chat, extra: 'field' },
    { ...input.chat, nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { large: 'x'.repeat(MAX_NODE_NATIVE_SERVICE_BYTES) } } }]) {
    expect(parseNodeNativeChatReference(chat)).toBeNull();
  }
  for (const command of [{ ...input, workspaceId: '' }, { ...input, operation: 'release' },
    { ...input, reason: 'deleted' }, { ...input, operation: 'release', reason: 'arbitrary' }]) {
    expect(parseNodeProviderNativeCommand(command)).toBeNull();
  }
  const getter = mock(() => { throw new Error('Synthetic getter must remain inert'); });
  const value = Object.defineProperty({ ...input.chat }, 'agentId', { enumerable: true, get: getter });
  expect(parseNodeNativeChatReference(value)).toBeNull();
  expect(parseNodeProviderNativeCommand(new Proxy(input, { get: getter, ownKeys: getter }))).toBeNull();
  expect(getter).not.toHaveBeenCalled();
});

test('native result contracts preserve null, opaque description and exact release acknowledgements', () => {
  const base = { kind: 'provider-native-result', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' } as const;
  for (const reply of [{ ...base, operation: 'resolve', reference: null },
    { ...base, operation: 'resolve', reference: nativeCommand().chat.nativeSession },
    { ...base, operation: 'describe', source: { kind: 'filesystem-path', value: '/native/only' } },
    { ...base, operation: 'describe', source: null }, { ...base, operation: 'release' }]) {
    expect(parseNodeProviderNativeReply(reply)).toEqual(reply);
  }
  expect(parseNodeProviderNativeReply({ ...base, operation: 'release', released: true })).toBeNull();
  expect(parseNodeProviderNativeReply({ ...base, operation: 'describe', source: { kind: 'url', value: '/native/only' } })).toBeNull();
});
