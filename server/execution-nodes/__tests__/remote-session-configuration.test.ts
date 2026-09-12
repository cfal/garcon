import { expect, mock, test } from 'bun:test';
import type { NodeWorkerServiceCommand, NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import type { ProviderSessionConfigurationRequest } from '../provider-configuration.js';
import { RemoteProviderConfigurationService } from '../remote-provider-configuration.js';

function fixture() {
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
  const identity = { ...session, operationId: 'synthetic-operation' };
  const instanceId = 'synthetic-instance';
  const signal = new AbortController().signal;
  const stream = { ...session, streamId: 'synthetic-source' };
  const captureSource = mock(() => stream);
  const call = mock(async (command: NodeWorkerServiceCommand): Promise<NodeWorkerServiceResult> => {
    if (command.method !== 'provider-session-configuration') throw new Error('Unexpected configuration request');
    return command.operation === 'prepare' ? { kind: 'provider-session-configuration-prepared', instanceId, preparation: { kind: 'prepared', identity } }
      : { kind: 'provider-session-configuration-receipt', instanceId, identity, receipt: { phase: 'settled', result: { kind: 'applied' } } };
  });
  let channel: { session: typeof session; service: { call: typeof call } } | null = { session, service: { call } };
  const service = new RemoteProviderConfigurationService({ instanceId, session, captureSource, channel: () => channel });
  const snapshot = { model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null };
  const request: ProviderSessionConfigurationRequest = {
    executionLocation: { nodeId: 'synthetic-node', instanceId, workspaceId: 'synthetic-workspace' },
    expected: { chatId: '1789000000000001', agentSessionId: 'synthetic-native', nativeSession: null, projectPath: '/synthetic/project' },
    permissionModeIntent: 'apply', previous: snapshot, next: { ...snapshot, permissionMode: 'manualBypass' },
  };
  const prepare = async () => {
    const result = await service.prepareApply(request, signal);
    if (result.kind !== 'prepared') throw new Error('Missing synthetic operation');
    return result.operation;
  };
  return { service, prepare, request, call, identity, instanceId, signal, stream, captureSource,
    channel(value: typeof channel) { channel = value; } };
}

test('a lost commit reply stays unknown, supports receipt inspection, and is never redispatched', async () => {
  const f = fixture(); const operation = await f.prepare();
  f.call.mockResolvedValueOnce({ kind: 'unknown' });
  expect(await f.service.commit(operation, f.signal)).toEqual({ kind: 'unknown' });
  expect(await f.service.status(operation, f.signal)).toEqual({ phase: 'settled', result: { kind: 'applied' } });
  expect(await f.service.commit(operation, f.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
  expect(f.call.mock.calls.map(([command]) => 'operation' in command && command.operation)).toEqual(['prepare', 'commit', 'status']);
});

test('a replacement channel must belong to the original logical session and instance', async () => {
  const f = fixture(); const operation = await f.prepare();
  f.channel({ session: { ...f.identity, logicalSessionId: 'foreign' }, service: { call: f.call } });
  expect(await f.service.commit(operation, f.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
  expect(f.call).toHaveBeenCalledTimes(1);
  await expect(f.service.status(operation, f.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
});

test('cancellation before commit consumes only the original prepared capability', async () => {
  const f = fixture(); const caller = new AbortController();
  const result = await f.service.prepareApply(f.request, caller.signal);
  if (result.kind !== 'prepared') throw new Error('Missing synthetic operation');
  caller.abort();
  expect(await f.service.commit(result.operation, f.signal)).toEqual({ kind: 'rejected', reason: 'cancelled' });
  await f.service.cancel(result.operation);
  expect(f.call.mock.calls.map(([command]) => 'operation' in command && command.operation)).toEqual(['prepare', 'cancel']);
  expect(await fixture().service.commit(result.operation, f.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
});

test('a mismatched receipt cannot report native success', async () => {
  const f = fixture(); const operation = await f.prepare();
  f.call.mockResolvedValueOnce({ kind: 'provider-session-configuration-receipt', instanceId: f.instanceId,
    identity: { ...f.identity, operationId: 'foreign' }, receipt: { phase: 'settled', result: { kind: 'applied' } } });
  expect(await f.service.commit(operation, f.signal)).toEqual({ kind: 'unknown' });
});

test('captures the sender source and request values before asynchronous delivery', async () => {
  const f = fixture(); const deliver = Promise.withResolvers<void>();
  const original = { ...f.stream };
  f.call.mockImplementationOnce(async command => {
    await deliver.promise;
    expect(command).toMatchObject({ operation: 'prepare', stream: original });
    if (command.method !== 'provider-session-configuration' || command.operation !== 'prepare') throw new Error('Unexpected request');
    expect(command.request.expected.agentSessionId).toBe('synthetic-native');
    expect(command.request.permissionModeIntent).toBe('apply');
    return { kind: 'provider-session-configuration-prepared', instanceId: f.instanceId, preparation: { kind: 'prepared', identity: f.identity } };
  });
  const pending = f.service.prepareApply(f.request, f.signal);
  f.stream.streamId = 'synthetic-replacement';
  Object.assign(f.request.expected, { agentSessionId: 'synthetic-replacement' });
  Object.assign(f.request, { permissionModeIntent: 'preserve' });
  deliver.resolve();
  expect((await pending).kind).toBe('prepared');
  expect(f.captureSource).toHaveBeenCalledTimes(1);
});

test.each(['INVALID_SETTINGS', 'INVALID_ENDPOINT', 'OPERATION_UNSUPPORTED', 'SESSION_BUSY'] as const)('returns a sanitized typed %s refusal without creating a commit capability', async code => {
  const f = fixture();
  const retryable = code === 'SESSION_BUSY';
  f.call.mockResolvedValueOnce({ kind: 'provider-session-configuration-prepared', instanceId: f.instanceId,
    preparation: { kind: 'refused', code, retryable } });
  await expect(f.service.prepareApply(f.request, f.signal)).rejects.toMatchObject({ code, retryable,
    message: 'The instance refused the session settings update.' });
  expect(f.call).toHaveBeenCalledTimes(1);
});
