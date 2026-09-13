import { nodeWorkerReplies } from '../worker/reply-port.js';
import { expect, mock, spyOn, test } from 'bun:test';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import type { ProviderConfigurationService, ProviderSessionConfigurationOperation, ProviderSessionConfigurationRequest, ProviderSessionConfigurationResult } from '../../execution-nodes/provider-configuration.js';
import type { NodeSessionConfigurationCommand } from '../../execution-nodes/transport/provider-session-configuration-wire.js';
import type { NodeExecutionSourceCapture } from '../execution-host.js';
import { NodeProviderCapacity } from '../provider-capacity.js';
import { NodeSessionConfigurationHost } from '../provider-session-configuration-host.js';
import { executionWireFixture } from './execution-wire-fixture.js';
import { NodeWorkerServiceClient, NodeWorkerServiceServer } from '../worker/service-channel.js';
import { parseNodeWorkerServiceText } from '../worker/service-protocol.js';
import { NODE_WORKER_WRITER_LIMITS } from '../worker/limits.js';
import { NodeWorkerWriter } from '../worker/writer.js';
import { RemoteProviderConfigurationService } from '../../execution-nodes/remote-provider-configuration.js';

function fixture(maxProviderRequests = 2, maxReceipts = 1) {
  const f = executionWireFixture();
  const operation = Object.freeze({}) as ProviderSessionConfigurationOperation;
  const source = new AbortController();
  const capacity = new NodeProviderCapacity(maxProviderRequests, 1);
  const timers: (() => void)[] = [];
  const configuration = {
    prepareApply: mock(async (_request: ProviderSessionConfigurationRequest, _signal: AbortSignal) => ({ kind: 'prepared' as const, operation })),
    commit: mock(async (_operation: ProviderSessionConfigurationOperation, _signal: AbortSignal): Promise<ProviderSessionConfigurationResult> => ({ kind: 'applied' })),
    cancel: mock(async (_operation: ProviderSessionConfigurationOperation) => {}),
  } satisfies Pick<ProviderConfigurationService, 'prepareApply' | 'commit' | 'cancel'>;
  const captureSource = mock((): NodeExecutionSourceCapture => ({ kind: 'captured', signal: source.signal, validate: () => source.signal.throwIfAborted() }));
  const host = new NodeSessionConfigurationHost({ instanceId: f.location.instanceId, connection: f.connection,
    supervisor: f.supervisor, resources: f.resources, execution: { captureSource }, capacity, configuration, maxReceipts,
    scheduleTimeout: (callback) => { timers.push(callback); return { cancel() {} }; } });
  const snapshot = { model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null };
  const request: ProviderSessionConfigurationRequest = { executionLocation: f.location,
    expected: { chatId: f.request.chatId, agentSessionId: 'synthetic-native', nativeSession: null, projectPath: '/synthetic/project' },
    permissionModeIntent: 'apply', previous: snapshot, next: { ...snapshot, permissionMode: 'manualBypass' } };
  const call = (command: NodeSessionConfigurationCommand, signal = new AbortController().signal, connection = f.connection) => host.execute(connection, command, signal);
  const command = { method: 'provider-session-configuration' as const, instanceId: f.location.instanceId };
  const prepare = async () => {
    const result = await call({ ...command, operation: 'prepare', stream: f.stream, request });
    if (result.kind !== 'provider-session-configuration-prepared' || result.preparation.kind !== 'prepared') throw new Error('Synthetic preparation failed');
    return result.preparation.identity;
  };
  return { ...f, operation, configuration, host, command, request, source, captureSource, capacity, timers, call, prepare,
    async close() { host.close(); await f.dispose(); } };
}

test('reserves the exact source without mutation and commits a consumed ticket at most once', async () => {
  const f = fixture();
  try {
    const identity = await f.prepare();
    expect(f.captureSource).toHaveBeenCalledWith({ chatId: f.request.expected.chatId, location: f.location, projectPath: f.request.expected.projectPath }, f.stream);
    expect(f.configuration.commit).not.toHaveBeenCalled();
    expect(f.capacity.reserve('work')).toBeNull();
    const releaseStatus = f.capacity.reserve('status'); expect(releaseStatus).not.toBeNull(); releaseStatus!();
    const command = { ...f.command, operation: 'commit' as const, identity };
    expect(await f.call(command)).toMatchObject({ receipt: { phase: 'settled', result: { kind: 'applied' } } });
    expect(await f.call(command)).toMatchObject({ receipt: { phase: 'settled', result: { kind: 'applied' } } });
    expect(f.configuration.commit).toHaveBeenCalledTimes(1);
    const release = f.capacity.reserve('work'); expect(release).not.toBeNull(); release!();
  } finally { await f.close(); }
});

test('a prepared capture survives its preparation caller and physical connection', async () => {
  const f = fixture();
  try {
    const caller = new AbortController();
    const result = await f.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request }, caller.signal);
    if (result.kind !== 'provider-session-configuration-prepared' || result.preparation.kind !== 'prepared') throw new Error('Expected ticket');
    const identity = result.preparation.identity;
    caller.abort(); f.supervisor.disconnect(f.connection);
    const next = f.supervisor.attach(f.session);
    expect(await f.call({ ...f.command, operation: 'status', identity }, next.signal, next)).toMatchObject({ receipt: { phase: 'prepared' } });
    expect(await f.call({ ...f.command, operation: 'commit', identity }, next.signal, next)).toMatchObject({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    f.supervisor.completeStartup(next.session);
    f.supervisor.completeRecovery(next, f.supervisor.beginRecovery(next));
    expect(await f.call({ ...f.command, operation: 'commit', identity }, next.signal, next)).toMatchObject({ receipt: { result: { kind: 'applied' } } });
    expect(f.configuration.prepareApply.mock.calls[0]![1].aborted).toBe(false);
  } finally { await f.close(); }
});

test('source retirement during workspace authorization cannot capture the replacement source', async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>(); const proceed = Promise.withResolvers<void>();
  const original = f.resources.prepare.bind(f.resources);
  const prepare = spyOn(f.resources, 'prepare').mockImplementation(async (...args) => {
    entered.resolve(); await proceed.promise; return original(...args);
  });
  try {
    const pending = f.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request });
    await entered.promise;
    f.source.abort();
    f.captureSource.mockReturnValue({ kind: 'captured', signal: new AbortController().signal, validate() {} });
    proceed.resolve();
    expect(await pending).toMatchObject({ preparation: { kind: 'rejected', reason: 'target-changed' } });
    expect(f.captureSource).toHaveBeenCalledTimes(1);
    expect(f.configuration.prepareApply).not.toHaveBeenCalled();
    const release = f.capacity.reserve('work'); expect(release).not.toBeNull(); release!();
  } finally { proceed.resolve(); prepare.mockRestore(); await f.close(); }
});

test.each(['client-capacity', 'recovering'] as const)('a commit refused by %s retains exact prepared-target cleanup', async refusal => {
  const f = fixture();
  let connection = f.connection;
  const service = new RemoteProviderConfigurationService({ instanceId: f.command.instanceId, session: f.session,
    captureSource: () => f.stream, channel: () => ({ session: f.session, service: {
      async call(command, signal) {
        if (command.method !== 'provider-session-configuration') throw new Error('Unexpected synthetic request');
        if (refusal === 'client-capacity' && command.operation === 'commit') return { kind: 'rejected', code: 'NODE_CAPACITY' };
        return f.host.execute(connection, command, signal);
      },
    } }) });
  try {
    const prepared = await service.prepareApply(f.request, new AbortController().signal);
    if (prepared.kind !== 'prepared') throw new Error('Missing synthetic target');
    if (refusal === 'recovering') {
      f.supervisor.disconnect(connection); connection = f.supervisor.attach(f.session);
    }
    expect(await service.commit(prepared.operation, connection.signal)).toEqual({ kind: 'rejected', reason: 'target-changed' });
    expect(f.capacity.reserve('work')).toBeNull();
    expect(f.configuration.commit).not.toHaveBeenCalled();
    await service.cancel(prepared.operation);
    expect(f.configuration.cancel).toHaveBeenCalledWith(f.operation);
    expect(f.configuration.cancel).toHaveBeenCalledTimes(1);
    expect(await service.status(prepared.operation, connection.signal))
      .toMatchObject({ phase: 'settled', result: { kind: 'rejected', reason: 'cancelled' } });
    const release = f.capacity.reserve('work'); expect(release).not.toBeNull(); release!();
  } finally { await f.close(); }
});

test('cancellation acknowledges an unsettled provider commit while retaining its capacity', async () => {
  const f = fixture(); const native = Promise.withResolvers<ProviderSessionConfigurationResult>();
  f.configuration.commit.mockImplementation(() => native.promise);
  try {
    const identity = await f.prepare();
    const caller = new AbortController();
    const commit = f.call({ ...f.command, operation: 'commit', identity }, caller.signal);
    caller.abort(); f.supervisor.disconnect(f.connection);
    const next = f.supervisor.attach(f.session);
    expect(await f.call({ ...f.command, operation: 'status', identity }, next.signal, next)).toMatchObject({ receipt: { phase: 'committing', result: null } });
    expect(await f.call({ ...f.command, operation: 'cancel', identity }, next.signal, next))
      .toMatchObject({ receipt: { phase: 'committing', result: null } });
    expect(f.capacity.reserve('work')).toBeNull();
    expect(f.configuration.commit.mock.calls[0]![1].aborted).toBe(true);
    native.resolve({ kind: 'unknown' });
    expect(await commit).toMatchObject({ receipt: { result: { kind: 'unknown' } } });
    expect(await f.call({ ...f.command, operation: 'status', identity }, next.signal, next))
      .toMatchObject({ receipt: { phase: 'settled', result: { kind: 'unknown' } } });
    expect(f.configuration.commit).toHaveBeenCalledTimes(1);
  } finally { native.resolve({ kind: 'unknown' }); await f.close(); }
});

test('acknowledged cancellation releases the wire status slot while all native work slots remain reserved', async () => {
  const f = fixture(4, 4);
  const native = Promise.withResolvers<ProviderSessionConfigurationResult>();
  const entered = Promise.withResolvers<void>();
  let commits = 0;
  f.configuration.commit.mockImplementation(() => { if (++commits === 3) entered.resolve(); return native.promise; });
  const physical = new AbortController();
  const failed = mock((error: unknown) => physical.abort(error));
  const options = { session: f.session, connectionId: 1, signal: physical.signal, validate() {}, failed };
  const requests = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame) throw new Error('Invalid synthetic configuration request');
    server.receive(frame);
  }, close() {} }, { ...NODE_WORKER_WRITER_LIMITS, ...options });
  const replies = new NodeWorkerWriter({ async write(bytes) {
    const frame = parseNodeWorkerServiceText(Buffer.from(bytes.subarray(4)).toString());
    if (!frame) throw new Error('Invalid synthetic configuration reply');
    client.receive(frame);
  }, close() {} }, { ...NODE_WORKER_WRITER_LIMITS, ...options });
  const client = new NodeWorkerServiceClient(requests, options);
  const server = new NodeWorkerServiceServer(nodeWorkerReplies(replies), (command, signal) => command.method === 'provider-session-configuration'
    ? f.host.execute(f.connection, command, signal) : Promise.resolve({ kind: 'rejected', code: 'VALIDATION_FAILED' }), options);
  try {
    const identities = [];
    for (let index = 0; index < 3; index++) {
      const prepared = await client.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request }, physical.signal);
      if (prepared.kind !== 'provider-session-configuration-prepared' || prepared.preparation.kind !== 'prepared') throw new Error('Missing synthetic ticket');
      identities.push(prepared.preparation.identity);
    }
    const pending = identities.map(identity => client.call({ ...f.command, operation: 'commit', identity }, physical.signal));
    await entered.promise;
    expect(await client.call({ ...f.command, operation: 'cancel', identity: identities[0]! }, physical.signal))
      .toMatchObject({ receipt: { phase: 'committing', result: null } });
    expect(await client.call({ ...f.command, operation: 'status', identity: identities[1]! }, physical.signal))
      .toMatchObject({ receipt: { phase: 'committing', result: null } });
    expect(await client.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request }, physical.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    expect(f.capacity.reserve('work')).toBeNull();
    expect(f.configuration.commit.mock.calls[0]![1].aborted).toBe(true);
    expect(f.configuration.commit.mock.calls[1]![1].aborted).toBe(false);
    expect(commits).toBe(3);
    native.resolve({ kind: 'unknown' });
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ receipt: { phase: 'settled', result: { kind: 'unknown' } } });
    expect(failed).not.toHaveBeenCalled();
  } finally {
    native.resolve({ kind: 'unknown' }); physical.abort();
    client.close(); server.close(); requests.close(); replies.close(); await f.close();
  }
});

test('cancellation acknowledges an unsettled prepared-target cleanup without releasing its capacity', async () => {
  const f = fixture(); const native = Promise.withResolvers<void>();
  f.configuration.cancel.mockImplementation(() => native.promise);
  try {
    const identity = await f.prepare();
    expect(await f.call({ ...f.command, operation: 'cancel', identity })).toMatchObject({ receipt: { phase: 'cancelling', result: null } });
    expect(f.capacity.reserve('work')).toBeNull();
    expect(f.configuration.cancel).toHaveBeenCalledTimes(1);
    native.resolve(); await native.promise;
    expect(await f.call({ ...f.command, operation: 'status', identity }))
      .toMatchObject({ receipt: { phase: 'settled', result: { kind: 'rejected', reason: 'cancelled' } } });
    const release = f.capacity.reserve('work'); expect(release).not.toBeNull(); release!();
  } finally { native.resolve(); await f.close(); }
});

test.each(['source', 'resource'] as const)('revoking the captured %s before queued delivery cancels the exact target', async (owner) => {
  const f = fixture(); const queued = Promise.withResolvers<void>();
  let mutations = 0;
  f.configuration.commit.mockImplementation(async (_operation, signal) => {
    await queued.promise;
    if (signal.aborted) return { kind: 'rejected', reason: 'cancelled' };
    mutations++; return { kind: 'applied' };
  });
  try {
    const identity = await f.prepare();
    const pending = f.call({ ...f.command, operation: 'commit', identity });
    if (owner === 'source') f.source.abort(); else f.resources.revoke(f.location);
    queued.resolve();
    expect(await pending).toMatchObject({ receipt: { result: { kind: 'rejected' } } });
    expect(mutations).toBe(0);
  } finally { queued.resolve(); await f.close(); }
});

test('preparation timeout waits for an uncooperative provider and then cancels the returned target', async () => {
  const f = fixture(); const entered = Promise.withResolvers<void>(); const native = Promise.withResolvers<void>();
  const operation = Object.freeze({}) as ProviderSessionConfigurationOperation;
  f.configuration.prepareApply.mockImplementation(async () => { entered.resolve(); await native.promise; return { kind: 'prepared', operation }; });
  try {
    let settled = false;
    const pending = f.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request }).then(result => { settled = true; return result; });
    await entered.promise; f.timers[0]!(); await Promise.resolve();
    expect(settled).toBe(false); expect(f.capacity.reserve('work')).toBeNull();
    native.resolve();
    expect(await pending).toMatchObject({ preparation: { kind: 'rejected', reason: 'cancelled' } });
    expect(f.configuration.cancel).toHaveBeenCalledWith(operation);
  } finally { native.resolve(); await f.close(); }
});

test('prepared expiry and logical retirement retain capacity until cancellation settles', async () => {
  const f = fixture(); const native = Promise.withResolvers<void>();
  f.configuration.cancel.mockImplementation(() => native.promise);
  try {
    const identity = await f.prepare(); f.timers[0]!();
    expect(await f.call({ ...f.command, operation: 'status', identity })).toMatchObject({ receipt: { phase: 'cancelling' } });
    f.host.close();
    expect(f.capacity.reserve('work')).toBeNull();
    native.resolve(); await native.promise; await Promise.resolve();
    const release = f.capacity.reserve('work'); expect(release).not.toBeNull(); release!();
    expect(f.configuration.cancel).toHaveBeenCalledTimes(1);
  } finally { native.resolve(); await f.close(); }
});

test.each(['path', 'workspace', 'source'] as const)('rejects %s conflicts before provider preparation', async owner => {
  const f = fixture();
  try {
    const request = { ...f.request,
      expected: owner === 'path' ? { ...f.request.expected, projectPath: '/foreign' } : f.request.expected,
      executionLocation: owner === 'workspace' ? { ...f.location, workspaceId: 'foreign' } : f.location };
    if (owner === 'source') f.captureSource.mockReturnValue({ kind: 'conflict' });
    expect(await f.call({ ...f.command, operation: 'prepare', stream: f.stream, request })).toMatchObject({ preparation: { kind: 'rejected' } });
    expect(f.configuration.prepareApply).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('a live provider target without a retained node source cannot become a ticket', async () => {
  const f = fixture();
  try {
    f.captureSource.mockReturnValue({ kind: 'absent', validate() {} });
    expect(await f.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request })).toMatchObject({ preparation: { kind: 'rejected' } });
    expect(f.configuration.cancel).toHaveBeenCalledTimes(1);
    expect(f.configuration.commit).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test.each(['INVALID_SETTINGS', 'INVALID_ENDPOINT', 'OPERATION_UNSUPPORTED', 'SESSION_BUSY'] as const)('preserves a known %s refusal only before commit', async code => {
  const f = fixture();
  const retryable = code === 'SESSION_BUSY';
  const error = new AgentIntegrationError(code, 'synthetic private native detail', retryable);
  try {
    f.configuration.prepareApply.mockRejectedValueOnce(error);
    expect(await f.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request }))
      .toEqual({ kind: 'provider-session-configuration-prepared', instanceId: f.command.instanceId,
        preparation: { kind: 'refused', code, retryable } });
    expect(f.configuration.commit).not.toHaveBeenCalled();
    const identity = await f.prepare();
    f.configuration.commit.mockRejectedValueOnce(error);
    expect(await f.call({ ...f.command, operation: 'commit', identity }))
      .toMatchObject({ receipt: { phase: 'settled', result: { kind: 'unknown' } } });
  } finally { await f.close(); }
});

test('source cancellation during preparation supersedes a later native refusal', async () => {
  const f = fixture();
  f.configuration.prepareApply.mockImplementation(async () => {
    f.source.abort();
    throw new AgentIntegrationError('INVALID_SETTINGS', 'synthetic private native detail', false);
  });
  try {
    expect(await f.call({ ...f.command, operation: 'prepare', stream: f.stream, request: f.request }))
      .toMatchObject({ preparation: { kind: 'rejected', reason: 'target-changed' } });
  } finally { await f.close(); }
});

test('receipt eviction cannot revive an old target, and foreign sessions or instances cannot use a ticket', async () => {
  const f = fixture();
  try {
    const first = await f.prepare();
    expect(await f.call({ ...f.command, operation: 'cancel', identity: first })).toMatchObject({ receipt: { phase: 'cancelling' } });
    expect(await f.call({ ...f.command, operation: 'status', identity: first })).toMatchObject({ receipt: { phase: 'settled' } });
    const second = await f.prepare();
    expect(await f.call({ ...f.command, operation: 'commit', identity: { ...second, logicalSessionId: 'foreign' } }))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(await f.call({ ...f.command, instanceId: 'foreign', operation: 'commit', identity: second }))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    await f.call({ ...f.command, operation: 'cancel', identity: second });
    expect(await f.call({ ...f.command, operation: 'commit', identity: first })).toMatchObject({ receipt: null });
    expect(f.configuration.commit).not.toHaveBeenCalled();
    const reply = await f.call({ ...f.command, operation: 'status', identity: second });
    expect(JSON.stringify(reply)).not.toContain('settings'); expect(JSON.stringify(reply)).not.toContain('projectPath');
  } finally { await f.close(); }
});
