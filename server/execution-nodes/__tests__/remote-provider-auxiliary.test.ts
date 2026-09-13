import { expect, mock, test } from 'bun:test';
import type { NodeWorkerServiceClient } from '../../execution-node/worker/service-channel.js';
import type { NodeWorkerServiceCommand, NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { RemoteProviderAuxiliaryService } from '../remote-provider-auxiliary.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };
const request = { prompt: 'synthetic input', timeoutMs: 30_000,
  configuration: { model: 'synthetic-model', settings: null, endpoint: null } };

test.each(['NODE_CAPACITY', 'NODE_UNAVAILABLE'] as const)('%s auxiliary refusal distinguishes temporary capacity from retired admission', async (code) => {
  const call = mock(async (): Promise<NodeWorkerServiceResult> => ({ kind: 'rejected', code }));
  const service = new RemoteProviderAuxiliaryService({ call }, 'synthetic-instance', session);
  await expect(service.generate(request, new AbortController().signal)).rejects.toMatchObject({
    code, status: 503, retryable: code === 'NODE_CAPACITY',
  });
  expect(call).toHaveBeenCalledTimes(1);
});

test('captures the auxiliary request and correlates its exact operation without a retry', async () => {
  const reply = Promise.withResolvers<NodeWorkerServiceResult>();
  const call = mock((_command: NodeWorkerServiceCommand, _signal: AbortSignal) => reply.promise);
  const port = { call } satisfies Pick<NodeWorkerServiceClient, 'call'>;
  const service = new RemoteProviderAuxiliaryService(port, 'synthetic-instance', session);
  const input = structuredClone(request);
  const pending = service.singleQuery('synthetic-workspace', input, new AbortController().signal);
  input.prompt = 'synthetic changed input';
  const command = call.mock.calls[0]![0];
  if (command.method !== 'provider-single-query') throw new Error('Wrong synthetic command');
  expect(command.request.prompt).toBe('synthetic input');
  expect(command.workspaceId).toBe('synthetic-workspace');
  reply.resolve({ kind: 'provider-auxiliary-result', instanceId: command.instanceId, identity: command.identity, value: 'synthetic result' });
  expect(await pending).toBe('synthetic result');
  expect(call).toHaveBeenCalledTimes(1);
});

test.each(['unknown', 'foreign-operation', 'foreign-instance', 'foreign-session'] as const)('%s reply never triggers another auxiliary mutation', async (kind) => {
  const call = mock(async (command: NodeWorkerServiceCommand): Promise<NodeWorkerServiceResult> => {
    if (command.method !== 'provider-text-generation') throw new Error('Wrong synthetic command');
    if (kind === 'unknown') return { kind: 'unknown' };
    return { kind: 'provider-auxiliary-result', value: 'synthetic result',
      instanceId: kind === 'foreign-instance' ? 'foreign-instance' : command.instanceId,
      identity: { ...command.identity,
        ...(kind === 'foreign-operation' ? { operationId: 'foreign-operation' } : {}),
        ...(kind === 'foreign-session' ? { logicalSessionId: 'foreign-session' } : {}),
      } };
  });
  const service = new RemoteProviderAuxiliaryService({ call }, 'synthetic-instance', session);
  await expect(service.generate(request, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  expect(call).toHaveBeenCalledTimes(1);
});
