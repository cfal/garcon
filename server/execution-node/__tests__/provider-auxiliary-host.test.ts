import { expect, mock, test } from 'bun:test';
import type { AgentIntegration, AgentNativeTask, AgentSingleQueryRequest, AgentTextGenerationRequest } from '@garcon/server-agent-interface';
import type { NodeProviderAuxiliaryCommand } from '../../execution-nodes/transport/provider-auxiliary-wire.js';
import type { ProviderConfigurationResolver } from '../../execution-nodes/provider-configuration.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { NodeNativeOccupancy } from '../native-occupancy.js';
import { NodeNativeTasks } from '../native-tasks.js';
import { NodeProviderAuxiliaryHost } from '../provider-auxiliary-host.js';
import { NodeProviderCapacity } from '../provider-capacity.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const identity = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session', operationId: 'synthetic-operation' };
const instance = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance' };
const location = { ...instance, workspaceId: 'synthetic-workspace' };

function fixture() {
  const occupancy = new NodeNativeOccupancy(1);
  const controller = new AbortController();
  const native = new NodeNativeTasks({ occupancy, signal: controller.signal });
  const result = Promise.withResolvers<string>();
  const settled = Promise.withResolvers<void>();
  const abort = mock(async () => true);
  const attempt = { dispatch: Promise.resolve({ kind: 'accepted' as const }), result: result.promise, settled: settled.promise, abort } satisfies AgentNativeTask<string>;
  const begin = mock((_request: AgentSingleQueryRequest | AgentTextGenerationRequest) => attempt);
  const provider = { singleQueryLifetime: { begin }, textGenerationLifetime: { begin } } satisfies Pick<AgentIntegration, 'singleQueryLifetime' | 'textGenerationLifetime'>;
  const resources = new NodeExecutionResources(instance.nodeId);
  resources.register({ location, projectPath: '/synthetic-project', execution: null, files: {
    async inspectProject() { return { kind: 'available', effectiveProjectKey: '/synthetic-canonical' }; },
  } });
  const configuration = { resolve: mock(async () => ({
    model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
    settings: { ownerId: 'synthetic-provider', schemaVersion: 1, values: {} }, endpoint: null,
  })) } satisfies ProviderConfigurationResolver;
  const contain = mock(() => {});
  const options = { instance, provider, configuration, resources, native, capacity: new NodeProviderCapacity(), requestContainment: contain };
  const host = new NodeProviderAuxiliaryHost(options);
  const command = { method: 'provider-text-generation', instanceId: instance.instanceId, identity,
    request: { prompt: 'synthetic input', configuration: { model: 'synthetic-model', settings: null, endpoint: null }, timeoutMs: 30_000 },
  } satisfies NodeProviderAuxiliaryCommand;
  return { host, options, occupancy, native, controller, result, settled, begin, abort, resources, configuration, command, contain };
}

test('result delivery leaves the shared instance capacity charged until native settlement', async () => {
  const f = fixture();
  const running = f.host.execute(f.command, f.controller.signal);
  f.result.resolve('synthetic result');
  expect(await running).toEqual({ kind: 'provider-auxiliary-result', instanceId: instance.instanceId, identity, value: 'synthetic result' });
  expect(f.occupancy.active).toBe(1);
  expect(() => f.occupancy.reserveExecution('synthetic-chat')).toThrow('reserved by other work');
  const successor = { ...f.command, identity: { ...identity, operationId: 'synthetic-next' } };
  expect(await f.host.execute(successor, f.controller.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  expect(f.begin).toHaveBeenCalledTimes(1);
  f.settled.resolve();
  await tick();
  expect(f.occupancy.active).toBe(0);
  expect(await f.host.execute(f.command, f.controller.signal)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
});

test('single-query project paths come only from the captured workspace grant', async () => {
  const f = fixture();
  const running = f.host.execute({ ...f.command, method: 'provider-single-query', workspaceId: location.workspaceId }, f.controller.signal);
  await tick();
  expect(f.begin.mock.calls[0]![0]).toMatchObject({ projectPath: '/synthetic-canonical', prompt: 'synthetic input' });
  f.result.resolve('synthetic result'); f.settled.resolve();
  expect(await running).toMatchObject({ kind: 'provider-auxiliary-result' });
});

test('grant revocation during configuration refuses before native entry', async () => {
  const f = fixture();
  const ready = Promise.withResolvers<void>();
  const resolve = f.configuration.resolve.getMockImplementation()!;
  f.configuration.resolve.mockImplementation(async () => { await ready.promise; return resolve(); });
  const running = f.host.execute({ ...f.command, method: 'provider-single-query', workspaceId: location.workspaceId }, f.controller.signal);
  await tick();
  f.resources.revoke(location); ready.resolve();
  expect(await running).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(f.begin).not.toHaveBeenCalled();
  expect(f.occupancy.active).toBe(0);
});

test('request capture survives mutation during asynchronous configuration', async () => {
  const f = fixture();
  const running = f.host.execute(f.command, f.controller.signal);
  f.command.request.prompt = 'synthetic changed input';
  await tick();
  expect(f.begin.mock.calls[0]![0]).toMatchObject({ prompt: 'synthetic input' });
  f.result.resolve('synthetic result'); f.settled.resolve();
  await running;
});

test('cancellation keeps native capacity and exact cleanup after the physical caller leaves', async () => {
  const f = fixture();
  const caller = new AbortController();
  const observed = f.host.execute(f.command, caller.signal).catch((error: unknown) => error);
  await tick();
  const error = new Error('Synthetic physical closure');
  caller.abort(error);
  expect(await observed).toBe(error);
  expect(f.abort).toHaveBeenCalledTimes(1);
  expect(f.occupancy.active).toBe(1);
  f.result.reject(error); f.settled.resolve();
  await tick();
  expect(f.occupancy.active).toBe(0);
});

test('unattested providers refuse native work while their workspace grants remain usable', async () => {
  const f = fixture();
  const host = new NodeProviderAuxiliaryHost({ ...f.options, provider: { singleQueryLifetime: null, textGenerationLifetime: null } });
  expect(await host.execute(f.command, f.controller.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(await f.resources.prepare(location, f.controller.signal)).toMatchObject({ projectPath: '/synthetic-canonical' });
  expect(f.begin).not.toHaveBeenCalled();
});

test('auxiliary identity exhaustion refuses boundedly without forgetting old mutations', async () => {
  const f = fixture();
  const host = new NodeProviderAuxiliaryHost({ ...f.options, maxIdentities: 1 });
  const running = host.execute(f.command, f.controller.signal);
  f.result.resolve('synthetic result'); f.settled.resolve();
  await running;
  expect(f.occupancy.active).toBe(0);
  expect(await host.execute({ ...f.command, identity: { ...identity, operationId: 'synthetic-next' } }, f.controller.signal))
    .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(await host.execute(f.command, f.controller.signal)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
  expect(f.begin).toHaveBeenCalledTimes(1);
});
