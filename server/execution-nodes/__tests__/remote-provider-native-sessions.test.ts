import { expect, mock, test } from 'bun:test';
import type { NodeWorkerServiceClient } from '../../execution-node/worker/service-channel.js';
import type { NodeWorkerServiceCommand, NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import type { ProviderNativeSessionRequest } from '../provider-native-sessions.js';
import { RemoteProviderNativeSessionService } from '../remote-provider-native-sessions.js';

const instance = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance' };
const workspace = { nodeId: instance.nodeId, workspaceId: 'synthetic-workspace' };
const request = (): ProviderNativeSessionRequest => ({ chat: {
  chatId: '1000000000000000', agentId: 'synthetic', agentSessionId: 'same-native-id', projectPath: '/node/project',
  model: '', carryOverRevision: '', nativeSeedReceipt: null, settings: null,
  nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { sessionId: 'same-native-id' } },
} });

test('captures native evidence and the workspace before awaiting a correlated response', async () => {
  const reply = Promise.withResolvers<NodeWorkerServiceResult>();
  const call = mock((_command: NodeWorkerServiceCommand, _signal: AbortSignal) => reply.promise);
  const port = { call } satisfies Pick<NodeWorkerServiceClient, 'call'>;
  const service = new RemoteProviderNativeSessionService(port, instance, () => workspace);
  const input = request();
  const reference = structuredClone(input.chat.nativeSession);
  const pending = service.resolve(input, new AbortController().signal);
  input.chat.nativeSession!.value.sessionId = 'changed';
  Object.assign(input.chat, { agentId: 'changed', projectPath: '/changed' });
  const command = call.mock.calls[0]![0];
  expect(command).toMatchObject({ instanceId: instance.instanceId, workspaceId: workspace.workspaceId,
    chat: { agentId: 'synthetic', nativeSession: reference } });
  expect(command).not.toHaveProperty('chat.projectPath');
  reply.resolve({ kind: 'provider-native-result', instanceId: instance.instanceId, workspaceId: workspace.workspaceId,
    operation: 'resolve', reference });
  expect(await pending).toEqual(reference);
  expect(call).toHaveBeenCalledTimes(1);
});

test.each(['unknown', 'foreign-instance', 'foreign-workspace', 'wrong-operation'] as const)(
  '%s release result retains uncertainty without repeating native cleanup', async (failure) => {
    const call = mock(async (): Promise<NodeWorkerServiceResult> => failure === 'unknown' ? { kind: 'unknown' } : {
      kind: 'provider-native-result', instanceId: failure === 'foreign-instance' ? 'foreign' : instance.instanceId,
      workspaceId: failure === 'foreign-workspace' ? 'foreign' : workspace.workspaceId,
      ...(failure === 'wrong-operation' ? { operation: 'resolve', reference: null } : { operation: 'release' }),
    });
    const service = new RemoteProviderNativeSessionService({ call }, instance, () => workspace);
    await expect(service.release({ ...request(), reason: 'deleted' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
    expect(call).toHaveBeenCalledTimes(1);
  },
);

test('an unavailable workspace never submits native work', async () => {
  const call = mock(async (): Promise<NodeWorkerServiceResult> => ({ kind: 'unknown' }));
  for (const target of [null, { ...workspace, nodeId: 'foreign' }]) {
    const service = new RemoteProviderNativeSessionService({ call }, instance, () => target);
    await expect(service.resolve(request(), new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  }
  expect(call).not.toHaveBeenCalled();
});

test('cancellation before submission or after a late release response cannot report confirmed cleanup', async () => {
  const reply = Promise.withResolvers<NodeWorkerServiceResult>();
  const call = mock(() => reply.promise);
  const service = new RemoteProviderNativeSessionService({ call }, instance, () => workspace);
  const cancellation = new AbortController();
  const pending = service.release({ ...request(), reason: 'deleted' }, cancellation.signal).catch((error) => error);
  const reason = new Error('Synthetic cleanup cancelled');
  cancellation.abort(reason);
  reply.resolve({ kind: 'provider-native-result', instanceId: instance.instanceId, workspaceId: workspace.workspaceId, operation: 'release' });
  expect(await pending).toBe(reason);
  expect(await service.release({ ...request(), reason: 'deleted' }, cancellation.signal).catch((error) => error)).toBe(reason);
  expect(call).toHaveBeenCalledTimes(1);
});
