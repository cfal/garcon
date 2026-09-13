import { expect, mock, test } from 'bun:test';
import type { ProviderNativeReleaseRequest, ProviderNativeSessionRequest, ProviderNativeSessionService } from '../../execution-nodes/provider-native-sessions.js';
import type { NodeProviderNativeCommand } from '../../execution-nodes/transport/provider-native-wire.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { NodeProviderCapacity } from '../provider-capacity.js';
import { NodeProviderNativeHost } from '../provider-native-host.js';
import { DomainError } from '../../lib/domain-error.js';
import { NodeNativeOccupancy } from '../native-occupancy.js';

const instance = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance' };
const location = { ...instance, workspaceId: 'synthetic-workspace' };
const command = (): NodeProviderNativeCommand => ({ method: 'provider-native-sessions', instanceId: instance.instanceId, workspaceId: location.workspaceId, operation: 'resolve', chat: {
  chatId: '1000000000000000', agentId: 'synthetic', agentSessionId: 'same-id', model: '', carryOverRevision: '',
  nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { sessionId: 'same-id' } }, nativeSeedReceipt: null, settings: null,
} });

function fixture() {
  const resources = new NodeExecutionResources(instance.nodeId);
  const inspectProject = mock(async () => ({ kind: 'unavailable', reason: 'missing' } as const));
  resources.register({ location, projectPath: '/node/registered', execution: null, files: { inspectProject } });
  const sessions = { resolve: mock(async (_request: ProviderNativeSessionRequest, _signal: AbortSignal) => command().chat.nativeSession),
    describe: mock(async (_request: ProviderNativeSessionRequest, _signal: AbortSignal) => null),
    release: mock(async (_request: ProviderNativeReleaseRequest, _signal: AbortSignal) => {}) } satisfies ProviderNativeSessionService;
  const capacity = new NodeProviderCapacity(2, 1);
  const occupancy = new NodeNativeOccupancy(2);
  const host = new NodeProviderNativeHost(capacity, instance, 'synthetic', resources, sessions, occupancy);
  return { resources, inspectProject, sessions, capacity, occupancy, host };
}

test('native access uses only the installed workspace path even when the project has disappeared', async () => {
  const f = fixture();
  const reply = await f.host.execute(command(), new AbortController().signal);
  expect(reply.kind).toBe('provider-native-result');
  expect(f.sessions.resolve.mock.calls[0]![0].chat.projectPath).toBe('/node/registered');
  expect(f.inspectProject).not.toHaveBeenCalled();
  expect(await f.host.execute({ ...command(), operation: 'release', reason: 'deleted' }, new AbortController().signal))
    .toMatchObject({ kind: 'provider-native-result', operation: 'release' });
  expect(f.sessions.release).toHaveBeenCalledTimes(1);
});

test('foreign instances, providers and revoked grants cannot reach native cleanup', async () => {
  const f = fixture();
  const release = { ...command(), operation: 'release', reason: 'deleted' } as const;
  expect(await f.host.execute({ ...release, instanceId: 'foreign' }, new AbortController().signal)).toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
  expect(await f.host.execute({ ...release, workspaceId: 'foreign' }, new AbortController().signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  f.resources.revoke(location);
  expect(await f.host.execute(release, new AbortController().signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  expect(f.sessions.release).not.toHaveBeenCalled();
});

test('cancelling a release retains its provider slot through actual filesystem settlement', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<void>();
  f.sessions.release.mockImplementation(async () => pending.promise);
  const cancellation = new AbortController();
  const releasing = f.host.execute({ ...command(), operation: 'release', reason: 'deleted' }, cancellation.signal).catch((error) => error);
  cancellation.abort(new Error('Synthetic release cancelled'));
  expect(await f.host.execute(command(), new AbortController().signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  pending.resolve();
  expect(await releasing).toBe(cancellation.signal.reason);
  expect(await f.host.execute(command(), new AbortController().signal)).toMatchObject({ kind: 'provider-native-result' });
});

test('a provider failure after release entry cannot claim definite nondelivery', async () => {
  const f = fixture();
  f.sessions.release.mockImplementation(async () => { throw new DomainError('NODE_UNAVAILABLE', 'Synthetic failure after native deletion', 503); });
  expect(await f.host.execute({ ...command(), operation: 'release', reason: 'deleted' }, new AbortController().signal))
    .toEqual({ kind: 'unknown' });
  expect(f.sessions.release).toHaveBeenCalledTimes(1);
});

test('native release excludes execution for the same chat through actual release settlement', async () => {
  const f = fixture();
  const execution = f.occupancy.reserveExecution(command().chat.chatId); execution.enter();
  const release = { ...command(), operation: 'release', reason: 'deleted' } as const;
  const signal = new AbortController().signal;
  expect(await f.host.execute(release, signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
  expect(f.sessions.release).not.toHaveBeenCalled();
  expect(await f.host.execute(command(), signal)).toMatchObject({ kind: 'provider-native-result' });
  execution.release();
  const settled = Promise.withResolvers<void>();
  f.sessions.release.mockImplementation(async () => settled.promise);
  const releasing = f.host.execute(release, signal);
  expect(() => f.occupancy.reserveExecution(command().chat.chatId)).toThrow('reserved');
  settled.resolve();
  expect(await releasing).toMatchObject({ kind: 'provider-native-result', operation: 'release' });
  expect(f.occupancy.active).toBe(0);
  const next = f.occupancy.reserveExecution(command().chat.chatId); next.enter(); next.release();
});
