import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { AgentDispatchOutcome, AgentExecutionHandle, AgentStartRequestV5, AgentResumeRequestV5, AgentProducerEvent, AgentSteerRequest, AgentSteerResult, AgentGoalControlRequest } from '@garcon/server-agent-interface';
import { NodeNativeOccupancy } from '../native-occupancy.js';
import { executionLifetimeFixture } from './execution-lifetime-fixture.js';
import { LocalProviderExecutionService } from '../local-provider-execution.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { NodeOperationTable, type NodeExecutionRequest, type NodeControlPreparation, type NodeOperationLimits } from '../operation-table.js';
import { NodeSupervisor } from '../supervisor.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import { DomainError } from '../../lib/domain-error.js';

const supervisors: NodeSupervisor[] = [];
afterEach(async () => { for (const supervisor of supervisors.splice(0)) await supervisor.shutdown(); });

function fixture(facets: Partial<Pick<ConstructorParameters<typeof LocalProviderExecutionService>[0], 'steering' | 'goals' | 'executionLifetime'>> = {}, limits: Partial<NodeOperationLimits> = {}) {
  let elapsed = 0;
  const supervisor = new NodeSupervisor({ clock: { read: () => ({ elapsedMs: elapsed, discontinuity: false }) }, async cleanup() {} });
  supervisors.push(supervisor);
  const identity = supervisor.openSession('synthetic-controller');
  const connection = supervisor.attach(identity);
  supervisor.completeStartup(connection.session);
  supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
  const caller = new AbortController();
  const nativeHandle = Object.freeze({});
  const execution = {
    start: mock(async (_request: AgentStartRequestV5): Promise<AgentExecutionHandle> => nativeHandle),
    resume: mock(async (_request: AgentResumeRequestV5): Promise<AgentExecutionHandle> => nativeHandle),
    abort: mock(async (_handle: AgentExecutionHandle) => true),
    runningSessions: () => [],
  };
  const native = executionLifetimeFixture(execution, nativeHandle);
  const integration = {
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [] },
    execution, executionLifetime: native.lifetime, compaction: null, steering: null, goals: null, ...facets,
  } satisfies ConstructorParameters<typeof LocalProviderExecutionService>[0];
  const configuration = {
    resolve: mock(async () => ({ model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
      settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null })),
  };
  const service = new LocalProviderExecutionService(integration, configuration);
  const location = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' };
  const resources = new NodeExecutionResources(location.nodeId);
  resources.register({ location, execution: service.retained, projectPath: '/synthetic/project',
    files: { inspectProject: async () => ({ kind: 'available', effectiveProjectKey: '/synthetic/project' }) } });
  const occupancy = new NodeNativeOccupancy(limits.maxOperations ?? 1);
  const containment = mock(() => {});
  const table = new NodeOperationTable({ supervisor, connection, resources, occupancy, requestContainment: containment,
    limits: { maxOperations: 1, preparationMs: 100, receiptMs: 100, maxReceipts: 1, dispatchMs: 200, nativeSettlementMs: 300, ...limits }, scheduleTimeout: () => ({ cancel() {} }) });
  const request: NodeExecutionRequest = { kind: 'start', chatId: 'synthetic-chat', runId: 'synthetic-run',
    configuration: { model: 'synthetic-model', settings: null, endpoint: null } };
  const input = { prompt: 'synthetic input', attachments: [], carriedContext: null };
  const events: AgentProducerEvent[] = [];
  const output = { signal: connection.authoritySignal, emit: (event: AgentProducerEvent) => { events.push(event); } };
  return { native, occupancy, containment, caller, supervisor, connection, identity, execution, service, resources, configuration, table, location, request, input, output, events,
    async settleNative(index = 0) { native.settlements[index]!.resolve(); await new Promise(setImmediate); },
    nativeHandle, advance(ms: number) { elapsed += ms; },
    prepare: () => table.prepare(connection, location, request, caller.signal),
  };
}

test('dispatch is consumed once even if its native handle return remains pending', async () => {
  const f = fixture();
  const ready = Promise.withResolvers<AgentExecutionHandle>();
  f.execution.start.mockImplementation(async () => ready.promise);
  const ticket = await f.prepare();
  const pending = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'dispatched', dispatch: 'pending' } });
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  ready.resolve(f.nativeHandle);
  await pending;
  expect(f.execution.start).toHaveBeenCalledTimes(1);
});

test('abort retains exact cleanup before a handle and capacity beyond a matching terminal', async () => {
  const f = fixture();
  const ready = Promise.withResolvers<AgentExecutionHandle>();
  f.execution.start.mockImplementation(async () => ready.promise);
  const ticket = await f.prepare();
  const pending = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  const stopped = f.table.abort(f.connection, ticket.identity);
  expect(f.table.abort(f.connection, ticket.identity)).toBe(stopped);
  await new Promise(setImmediate);
  expect(f.execution.start.mock.calls[0]![0].admission.signal.aborted).toBe(true);
  expect(await stopped).toBe(true);
  ready.resolve(f.nativeHandle);
  await pending;
  expect(await stopped).toBe(true);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  f.execution.start.mock.calls[0]![0].output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'interrupted' });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  const successor = await f.prepare();
  expect(successor.identity.operationId).not.toBe(ticket.identity.operationId);
});

test('physical recovery allows status and abort without authorizing another dispatch', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.supervisor.disconnect(f.connection);
  expect(f.execution.start.mock.calls[0]![0].admission.signal.aborted).toBe(false);
  expect(() => f.table.status(f.connection, ticket.identity)).toThrow();
  const replacement = f.supervisor.attach(f.identity);
  expect(f.table.status(replacement, ticket.identity)).toMatchObject({ kind: 'completed', value: { dispatch: 'accepted' } });
  await expect(f.table.prepare(replacement, f.location, f.request, f.caller.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(await f.table.abort(replacement, ticket.identity)).toBe(true);
});

test('expired receipts never authorize reusing a ticket', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  f.advance(100);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'expired' } });
  f.advance(100);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'unknown' });
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  expect(f.execution.start).not.toHaveBeenCalled();
});

test('cancelled preparation holds its bounded slot until noncooperative validation settles', async () => {
  const f = fixture();
  const configured = await f.configuration.resolve();
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  f.configuration.resolve.mockImplementationOnce(async () => {
    entered.resolve(); await ready.promise; return configured;
  });
  const pending = f.prepare();
  await entered.promise;
  const outcome = pending.catch((error) => error);
  const failure = new Error('synthetic cancellation');
  f.caller.abort(failure);
  expect(await outcome).toBe(failure);
  const fresh = new AbortController();
  await expect(f.table.prepare(f.connection, f.location, f.request, fresh.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  ready.resolve();
  await new Promise(setImmediate);
  const ticket = await f.table.prepare(f.connection, f.location, f.request, fresh.signal);
  expect(ticket.runId).toBe(f.request.runId);
  expect(f.execution.start).not.toHaveBeenCalled();
});

test('the preparation caller signal cannot cancel a dispatched execution', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  f.caller.abort();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  expect(f.execution.start.mock.calls[0]![0].admission.signal.aborted).toBe(false);
  expect(f.execution.abort).not.toHaveBeenCalled();
});

test('terminal receipt eviction preserves late output without reviving native controls', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  const publisher = f.execution.start.mock.calls[0]![0].output;
  publisher.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  await f.settleNative();
  f.advance(100);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'unknown' });
  publisher.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-11T00:00:00.000Z', 'synthetic late output') }] });
  expect(f.events.at(-1)).toMatchObject({ type: 'rows', rows: [{ message: { content: 'synthetic late output' } }] });
});

test('a matching terminal before handle return retains capacity until native settlement', async () => {
  const f = fixture();
  f.execution.start.mockImplementation(async (request) => {
    request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return f.nativeHandle;
  });
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'ended', native: 'possible' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test.each(['throw', 'timeout'] as const)('a visible terminal survives a late dispatch %s while native cleanup remains owned', async (cause) => {
  const f = fixture();
  const ready = Promise.withResolvers<AgentExecutionHandle>();
  f.execution.start.mockImplementation(async (request) => {
    request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return ready.promise;
  });
  const ticket = await f.prepare();
  const pending = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  await new Promise(setImmediate);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', dispatch: 'pending' } });
  if (cause === 'throw') ready.reject(new Error('Synthetic late dispatch failure'));
  else { f.advance(200); f.table.poll(); }
  expect(await pending).toMatchObject({ kind: 'unknown' });
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', dispatch: 'unknown', native: 'possible' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  ready.resolve(f.nativeHandle);
  await f.settleNative();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', dispatch: 'unknown', native: 'settled' } });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  expect(f.events.filter((event) => event.type === 'run-ended')).toHaveLength(1);
});

test('post-entry dispatch failure is unknown and retains capacity and cleanup', async () => {
  const f = fixture();
  f.execution.start.mockImplementation(async () => { throw new Error('synthetic launch failure'); });
  const ticket = await f.prepare();
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).resolves.toMatchObject({ kind: 'unknown' });
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({
    kind: 'completed', value: { phase: 'failed', dispatch: 'unknown', native: 'possible' },
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await expect(f.table.abort(f.connection, ticket.identity)).resolves.toBe(true);
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
});

if (process.env.GARCON_NODE_DIAGNOSTICS_TEST === '1') {
  test.each([
    ['domain error', new DomainError('SESSION_BUSY', 'synthetic private detail'), 'SESSION_BUSY'],
    ['timeout', new DOMException('synthetic private detail', 'TimeoutError'), 'TimeoutError'],
    ['unclassified', new Error('synthetic private detail'), 'unclassified-provider-error'],
    ['throwing code getter', Object.defineProperty(new DomainError('SESSION_BUSY', 'synthetic private detail'), 'code', {
      get() { throw new Error('synthetic diagnostic getter failure'); },
    }), 'unclassified-provider-error'],
  ] as const)('dispatch failure records only bounded classification %s', async (_label, error, code) => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {});
    const f = fixture();
    try {
      f.execution.start.mockImplementationOnce(async () => { throw error; });
      const ticket = await f.prepare();
      await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).resolves.toEqual({ kind: 'unknown', error });
      expect(warning).toHaveBeenCalledWith('[execution-node:operations]', 'Native dispatch did not confirm admission', {
        ...ticket.identity, instanceId: f.location.instanceId, outcome: 'unknown', code,
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic private detail');
      await f.settleNative();
    } finally { warning.mockRestore(); }
  });
} else {
  test('dispatch diagnostics remain checked independently of the ambient log level', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path,
      '--test-name-pattern', '^dispatch failure records only bounded classification'], {
      env: { ...process.env, GARCON_LOG_LEVEL: 'warn', GARCON_NODE_DIAGNOSTICS_TEST: '1' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
    });
    const [code, output, diagnostic] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, output + diagnostic).toBe(0);
    expect(output + diagnostic).toMatch(/\b4 pass\b/);
  }, 30_000);
}

test.each(['kind', 'error'] as const)('a throwing dispatch %s getter cannot strand completion or cleanup', async (property) => {
  const failure = new Error('Synthetic outcome getter failure');
  const read = mock(() => { throw failure; });
  const outcome = Object.defineProperty({ kind: 'rejected', error: null } satisfies AgentDispatchOutcome, property, { get: read });
  const settled = Promise.withResolvers<void>();
  const abort = mock(async () => true);
  const f = fixture({ executionLifetime: { begin: () => ({ dispatch: Promise.resolve(outcome), settled: settled.promise, abort }) } });
  const ticket = await f.prepare();
  const completed = mock(() => {});
  const pending = f.table.dispatch(f.connection, ticket.identity, f.input, f.output).then(completed);
  void pending.catch(() => {});
  await new Promise(setImmediate);
  expect(completed).toHaveBeenCalledWith({ kind: 'unknown', error: failure });
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { dispatch: 'unknown', native: 'possible' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  settled.resolve();
  await new Promise(setImmediate);
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(abort).toHaveBeenCalledTimes(1);
});

test('terminal completion keeps an unsettled abort counted until the native call settles', async () => {
  const f = fixture();
  const abort = Promise.withResolvers<boolean>();
  f.execution.abort.mockImplementation(() => abort.promise);
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  const stopped = f.table.abort(f.connection, ticket.identity);
  const publisher = f.execution.start.mock.calls[0]![0].output;
  publisher.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', abort: 'pending' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  abort.resolve(true);
  expect(await stopped).toBe(true);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', abort: 'requested' } });
});

test.each(['true', 'false', 'throw'] as const)('an abort returning %s does not replace a matching terminal', async (outcome) => {
  const f = fixture();
  f.execution.abort.mockImplementation(async () => {
    if (outcome === 'throw') throw new Error('synthetic abort failure');
    return outcome === 'true';
  });
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  expect(await f.table.abort(f.connection, ticket.identity)).toBe(outcome === 'true');
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: {
    phase: 'dispatched', abort: outcome === 'true' ? 'requested' : 'unconfirmed',
  } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
});

test('a failed terminal publication aborts the exact handle without failing native launch', async () => {
  const f = fixture();
  const abort = Promise.withResolvers<boolean>();
  f.execution.abort.mockImplementation(() => abort.promise);
  f.execution.start.mockImplementation(async (request) => {
    request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return f.nativeHandle;
  });
  const ticket = await f.prepare();
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, {
    signal: f.connection.authoritySignal,
    emit() { throw new Error('synthetic publication failure'); },
  })).resolves.toEqual({ kind: 'accepted' });
  expect(f.execution.abort).toHaveBeenCalledWith(f.nativeHandle);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({
    value: { phase: 'failed', dispatch: 'accepted', abort: 'pending' },
  });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  abort.resolve(true);
  expect(await f.table.abort(f.connection, ticket.identity)).toBe(true);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'failed' } });
});

test('late output after failed dispatch cannot change its receipt or a successor', async () => {
  const f = fixture();
  f.execution.start.mockImplementationOnce(async () => { throw new Error('synthetic launch failure'); });
  const ticket = await f.prepare();
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).resolves.toMatchObject({ kind: 'unknown' });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  const receipt = f.table.status(f.connection, ticket.identity);
  const successor = await f.prepare();
  await f.table.dispatch(f.connection, successor.identity, f.input, f.output);
  const old = f.execution.start.mock.calls[0]![0].output;
  old.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  expect(f.events.at(-1)).toMatchObject({ type: 'run-ended' });
  expect(f.table.status(f.connection, ticket.identity)).toEqual(receipt);
  expect(f.table.status(f.connection, successor.identity)).toMatchObject({ value: { phase: 'dispatched' } });
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
});

test('table close detaches occurrence bookkeeping while the publication owner still accepts late output', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.table.close();
  const old = f.execution.start.mock.calls[0]![0].output;
  expect(() => old.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' })).not.toThrow();
  expect(f.events).toHaveLength(1);
  expect(() => f.table.status(f.connection, ticket.identity)).toThrow('unavailable node session');
});

test('a lost physical dispatch reply reconciles the original operation without starting another', async () => {
  const f = fixture();
  const ready = Promise.withResolvers<AgentExecutionHandle>();
  f.execution.start.mockImplementation(async () => ready.promise);
  const ticket = await f.prepare();
  const pending = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.supervisor.disconnect(f.connection);
  ready.resolve(f.nativeHandle);
  await pending;
  const replacement = f.supervisor.attach(f.identity);
  expect(f.table.status(replacement, ticket.identity)).toMatchObject({
    kind: 'completed', value: { phase: 'dispatched', dispatch: 'accepted' },
  });
  expect(f.supervisor.completeRecovery(replacement, f.supervisor.beginRecovery(replacement))).toBe(true);
  await expect(f.table.dispatch(replacement, ticket.identity, f.input, f.output)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  await expect(f.table.prepare(replacement, f.location, f.request, f.caller.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
});

test('unused release is idempotent and a released ticket never dispatches', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  f.table.release(f.connection, ticket.identity);
  f.table.release(f.connection, ticket.identity);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'released' } });
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  expect((await f.prepare()).identity.operationId).not.toBe(ticket.identity.operationId);
  expect(f.execution.start).not.toHaveBeenCalled();
});

test('replacing a physical connection cancels its pending validation without launching', async () => {
  const f = fixture();
  const configured = await f.configuration.resolve();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.configuration.resolve.mockImplementationOnce(async () => {
    entered.resolve(); await release.promise; return configured;
  });
  const pending = f.prepare().catch((error) => error);
  await entered.promise;
  const replacement = f.supervisor.attach(f.identity);
  expect(await pending).toMatchObject({ code: 'NODE_SESSION_EXPIRED' });
  f.supervisor.completeStartup(replacement.session);
  f.supervisor.completeRecovery(replacement, f.supervisor.beginRecovery(replacement));
  await expect(f.table.prepare(replacement, f.location, f.request, f.caller.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  release.resolve();
  await new Promise(setImmediate);
  await expect(f.table.prepare(replacement, f.location, f.request, f.caller.signal)).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.execution.start).not.toHaveBeenCalled();
});

test('grant revocation aborts only the captured operation and does not claim completion', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.resources.revoke(f.location);
  expect(await f.table.abort(f.connection, ticket.identity)).toBe(true);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
  expect(f.execution.abort.mock.calls[0]![0]).toBe(f.nativeHandle);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'dispatched', abort: 'requested' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
});

test('operation status rejects every foreign session dimension before lookup', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  for (const key of ['controllerBootId', 'nodeBootId', 'logicalSessionId'] as const) {
    expect(() => f.table.status(f.connection, { ...ticket.identity, [key]: 'synthetic-foreign' }))
      .toThrow('unavailable node session');
  }
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'prepared' } });
  expect(f.execution.start).not.toHaveBeenCalled();
});


async function controlFixture() {
  const target = Object.freeze({});
  const steering = {
    captureTarget: mock((): object | null => target),
    steer: mock(async (request: AgentSteerRequest): Promise<AgentSteerResult> => {
      await request.prepareDelivery();
      return { kind: 'accepted' };
    }),
  };
  const handoff = { validate: mock(() => {}), commit: mock(() => {}) };
  const goals = { submitControl: mock(async (request: AgentGoalControlRequest) => {
    await request.beforeDelivery(handoff);
    return true;
  }) };
  const f = fixture({ steering, goals });
  const ticket = await f.table.prepare(f.connection, f.location, {
    ...f.request, kind: 'resume', agentSessionId: 'synthetic-session', nativeSession: null,
  }, f.caller.signal);
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  const published = f.execution.resume.mock.calls[0]![0].output;
  const steerInput = { input: 'synthetic steering content', clientMessageId: 'synthetic-steer-input' };
  const goalInput = { prompt: 'synthetic goal content', attachments: [], runId: 'synthetic-goal-run', configuration: f.request.configuration };
  return { ...f, ticket, published, steering, goals, handoff, target, steerInput, goalInput,
    prepareSteer: () => f.table.prepareSteer(f.connection, ticket.identity, f.caller.signal),
    prepareGoal: () => f.table.prepareGoalControl(f.connection, ticket.identity, goalInput, f.caller.signal),
  };
}

function ready(result: NodeControlPreparation) {
  if (result.kind !== 'ready') throw new Error('Synthetic control preparation was refused');
  return result.ticket;
}

test('steering captures one target, consumes it once, and bounds outstanding controls', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareSteer());
  await expect(f.prepareSteer()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await expect(f.prepareGoal()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  f.steering.captureTarget.mockReturnValue(Object.freeze({}));
  const delivered = await f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput);
  expect(delivered).toEqual({ result: { kind: 'accepted' }, deliveryPrepared: true });
  expect(f.steering.captureTarget).toHaveBeenCalledTimes(1);
  expect(f.steering.steer.mock.calls[0]![0].target).toBe(f.target);
  await expect(f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput))
    .rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  const next = ready(await f.prepareSteer());
  expect(next.controlId).not.toBe(control.controlId);
  expect(() => f.table.cancelControl(f.connection, f.ticket.identity, control.controlId)).toThrow('already consumed');
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { control: {
    controlId: next.controlId, kind: 'steer', phase: 'prepared', outcome: null,
  } } });
});

test.each([
  { result: { kind: 'accepted' }, prepared: true },
  { result: { kind: 'rejected', reason: 'turn-changed', message: 'synthetic rejection' }, prepared: false },
  { result: { kind: 'rejected', reason: 'provider-rejected', message: 'synthetic rejection' }, prepared: true },
  { result: { kind: 'failed', outcome: 'not-sent', message: 'synthetic failure' }, prepared: true },
  { result: { kind: 'failed', outcome: 'unknown', message: 'synthetic failure' }, prepared: true },
] satisfies { result: AgentSteerResult; prepared: boolean }[])('steering preserves provider outcome %j', async ({ result, prepared }) => {
  const f = await controlFixture();
  f.steering.steer.mockImplementation(async (request) => {
    if (prepared) await request.prepareDelivery();
    return result;
  });
  const control = ready(await f.prepareSteer());
  expect(await f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput))
    .toEqual({ result, deliveryPrepared: prepared });
  const serialized = JSON.stringify(f.table.status(f.connection, f.ticket.identity));
  expect(serialized).not.toContain('synthetic rejection');
  expect(serialized).not.toContain('synthetic failure');
});

test.each([false, true])('a steering throw after preparation=%s reports its delivery uncertainty', async (prepared) => {
  const f = await controlFixture();
  f.steering.steer.mockImplementation(async (request) => {
    if (prepared) await request.prepareDelivery();
    throw new Error('synthetic native failure');
  });
  const control = ready(await f.prepareSteer());
  expect(await f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput))
    .toMatchObject({ result: { kind: 'failed', outcome: prepared ? 'unknown' : 'not-sent' }, deliveryPrepared: prepared });
});

test('an unsupported provider and a changed native turn have distinct steering preparations', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  f.execution.start.mockImplementation(async (request) => {
    request.output.emit({ type: 'session', session: { agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null } });
    return f.nativeHandle;
  });
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  expect(await f.table.prepareSteer(f.connection, ticket.identity, f.caller.signal)).toEqual({ kind: 'unsupported' });
  const available = await controlFixture();
  available.steering.captureTarget.mockReturnValue(null);
  expect(await available.prepareSteer()).toEqual({ kind: 'unavailable' });
  expect(available.steering.steer).not.toHaveBeenCalled();
});

test('terminal clears a prepared steer without delivering or recapturing it', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareSteer());
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  await expect(f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput)).rejects.toThrow('already consumed');
  expect(f.steering.steer).not.toHaveBeenCalled();
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: {
    phase: 'ended', control: { phase: 'settled', outcome: { kind: 'failed', outcome: 'not-sent' } },
  } });
});

test('steering preparation expiry clears only its own target and permits a fresh explicit control', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareSteer());
  f.advance(100);
  f.table.poll();
  await expect(f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput)).rejects.toThrow();
  expect(f.steering.steer).not.toHaveBeenCalled();
  expect(ready(await f.prepareSteer()).controlId).not.toBe(control.controlId);
});

test('goal capture parks the original occurrence and only commit advances terminal matching', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareGoal());
  expect(f.goals.submitControl).toHaveBeenCalledTimes(1);
  expect(f.handoff.commit).not.toHaveBeenCalled();
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: {
    runId: f.request.runId, control: { phase: 'prepared', runId: f.goalInput.runId },
  } });
  const native = f.goals.submitControl.mock.calls[0]![0];
  expect(native.output).toBe(f.published);
  expect(native.admission).toBe(f.execution.resume.mock.calls[0]![0].admission);
  const delivered = f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId);
  expect(f.handoff.commit).toHaveBeenCalledTimes(1);
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { runId: f.goalInput.runId } });
  expect(await delivered).toEqual({ kind: 'accepted' });
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { phase: 'dispatched' } });
  f.published.emit({ type: 'run-ended', runId: f.goalInput.runId, outcome: 'finished' });
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { phase: 'ended' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.execution.resume).toHaveBeenCalledTimes(1);
  expect(f.execution.start).not.toHaveBeenCalled();
});

test('successive goal commits retain one operation and each successor terminal is exact', async () => {
  const f = await controlFixture();
  for (const runId of ['synthetic-goal-one', 'synthetic-goal-two']) {
    const control = ready(await f.table.prepareGoalControl(f.connection, f.ticket.identity, { ...f.goalInput, runId }, f.caller.signal));
    expect(await f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId)).toEqual({ kind: 'accepted' });
  }
  expect(f.handoff.commit).toHaveBeenCalledTimes(2);
  expect(await f.table.abort(f.connection, f.ticket.identity)).toBe(true);
  expect(f.execution.abort).toHaveBeenCalledWith(f.nativeHandle);
  f.published.emit({ type: 'run-ended', runId: 'synthetic-goal-one', outcome: 'finished' });
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { phase: 'dispatched' } });
  f.published.emit({ type: 'run-ended', runId: 'synthetic-goal-two', outcome: 'interrupted' });
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { phase: 'ended', runId: 'synthetic-goal-two' } });
});

test.each(['cancel', 'expiry', 'grant', 'terminal', 'caller', 'disconnect', 'close'] as const)('goal %s before commit is definite non-delivery', async (action) => {
  const f = await controlFixture();
  const control = ready(await f.prepareGoal());
  if (action === 'cancel') expect(f.table.cancelControl(f.connection, f.ticket.identity, control.controlId)).toBe(true);
  if (action === 'expiry') { f.advance(100); f.table.poll(); }
  if (action === 'grant') f.resources.revoke(f.location);
  if (action === 'terminal') f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  if (action === 'caller') f.caller.abort(new Error('synthetic caller cancellation'));
  if (action === 'disconnect') f.supervisor.disconnect(f.connection);
  if (action === 'close') f.table.close();
  await new Promise(setImmediate);
  expect(f.handoff.commit).not.toHaveBeenCalled();
  await expect(f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId)).rejects.toThrow();
  if (action !== 'disconnect' && action !== 'close') {
    expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { control: {
      phase: 'settled', deliveryPrepared: false, outcome: { kind: 'failed', outcome: 'not-sent' },
    } } });
  }
});

test('goal validation refusal cancels the parked handoff before entering commit', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareGoal());
  f.handoff.validate.mockImplementation(() => { throw new Error('synthetic target changed'); });
  await expect(f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId)).rejects.toThrow('synthetic target changed');
  await new Promise(setImmediate);
  expect(f.handoff.commit).not.toHaveBeenCalled();
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { control: {
    phase: 'settled', outcome: { kind: 'failed', outcome: 'not-sent' },
  } } });
});

test('an exception inside goal commit is unknown and retains the successor without retrying', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareGoal());
  f.handoff.commit.mockImplementation(() => { throw new Error('synthetic commit uncertainty'); });
  expect(await f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId))
    .toEqual({ kind: 'failed', outcome: 'unknown' });
  await expect(f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId)).rejects.toThrow();
  expect(f.handoff.commit).toHaveBeenCalledTimes(1);
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: {
    runId: f.goalInput.runId, control: { phase: 'settled', deliveryPrepared: true },
  } });
  expect(await f.table.abort(f.connection, f.ticket.identity)).toBe(true);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
  await expect(f.prepareSteer()).rejects.toThrow();
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
});

test.each(['steer', 'goal'] as const)('physical replacement preserves committed %s work and its single native call', async (kind) => {
  const f = await controlFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  if (kind === 'steer') f.steering.steer.mockImplementation(async (request) => {
    entered.resolve(); await release.promise; await request.prepareDelivery(); return { kind: 'accepted' };
  });
  else f.goals.submitControl.mockImplementation(async (request) => {
    await request.beforeDelivery(f.handoff); entered.resolve(); await release.promise; return true;
  });
  const control = ready(await (kind === 'steer' ? f.prepareSteer() : f.prepareGoal()));
  const delivered = kind === 'steer'
    ? f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput)
    : f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId);
  await entered.promise;
  f.caller.abort(new Error('synthetic disconnected caller'));
  f.supervisor.disconnect(f.connection);
  const replacement = f.supervisor.attach(f.identity);
  expect(f.table.status(replacement, f.ticket.identity)).toMatchObject({ value: { control: { phase: 'committing' } } });
  expect(f.table.cancelControl(replacement, f.ticket.identity, control.controlId)).toBe(false);
  await expect(f.table.prepareSteer(replacement, f.ticket.identity, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  release.resolve();
  await delivered;
  expect(f.table.status(replacement, f.ticket.identity)).toMatchObject({ value: { control: { outcome: { kind: 'accepted' } } } });
  f.supervisor.completeStartup(replacement.session);
  f.supervisor.completeRecovery(replacement, f.supervisor.beginRecovery(replacement));
  await expect(kind === 'steer'
    ? f.table.commitSteer(replacement, f.ticket.identity, control.controlId, f.steerInput)
    : f.table.commitGoalControl(replacement, f.ticket.identity, control.controlId)).rejects.toThrow();
  expect(kind === 'steer' ? f.steering.steer : f.goals.submitControl).toHaveBeenCalledTimes(1);
  expect(f.execution.abort).not.toHaveBeenCalled();
});

test('noncooperative goal preparation stays counted after cancellation and a terminal', async () => {
  const f = await controlFixture();
  const configured = await f.configuration.resolve();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.configuration.resolve.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return configured; });
  const preparing = f.prepareGoal().catch((error) => error);
  await entered.promise;
  const snapshot = f.table.status(f.connection, f.ticket.identity);
  if (snapshot.kind !== 'completed' || !snapshot.value.control) throw new Error('Synthetic control receipt missing');
  expect(f.table.cancelControl(f.connection, f.ticket.identity, snapshot.value.control.controlId)).toBe(true);
  expect(await preparing).toMatchObject({ name: 'AbortError' });
  await expect(f.prepareSteer()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  f.published.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  release.resolve();
  await new Promise(setImmediate);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.goals.submitControl).not.toHaveBeenCalled();
});

test('goal preparation expires from reservation time while provider validation is pending', async () => {
  const f = await controlFixture();
  const configured = await f.configuration.resolve();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.configuration.resolve.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return configured; });
  const preparing = f.prepareGoal().catch((error) => error);
  await entered.promise;
  f.advance(100); f.table.poll();
  expect(await preparing).toMatchObject({ name: 'TimeoutError' });
  release.resolve();
  await new Promise(setImmediate);
  expect(f.goals.submitControl).not.toHaveBeenCalled();
  expect(ready(await f.prepareSteer()).kind).toBe('steer');
});

test('operation and control receipts contain only body-free identities and outcomes', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareGoal());
  const body = JSON.stringify(f.table.status(f.connection, f.ticket.identity));
  expect(body).not.toContain(f.goalInput.prompt);
  expect(body).not.toContain(f.steerInput.input);
  expect(body).not.toContain('synthetic-model');
  expect(body).not.toContain('synthetic-session');
  expect(body).not.toContain('configuration');
  expect(body).not.toContain('handoff');
  expect(body).not.toContain('credential');
  expect(body).not.toContain('target');
  expect(f.table.cancelControl(f.connection, f.ticket.identity, control.controlId)).toBe(true);
});


test.each(['steer', 'goal'] as const)('terminal keeps an unsettled %s call counted until it settles', async (kind) => {
  const f = await controlFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  if (kind === 'steer') f.steering.steer.mockImplementation(async (request) => {
    await request.prepareDelivery(); entered.resolve(); await release.promise; return { kind: 'accepted' };
  });
  else f.goals.submitControl.mockImplementation(async (request) => {
    await request.beforeDelivery(f.handoff); entered.resolve(); await release.promise; return true;
  });
  const control = ready(await (kind === 'steer' ? f.prepareSteer() : f.prepareGoal()));
  const delivered = kind === 'steer'
    ? f.table.commitSteer(f.connection, f.ticket.identity, control.controlId, f.steerInput)
    : f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId);
  await entered.promise;
  f.published.emit({ type: 'run-ended', runId: kind === 'steer' ? f.request.runId : f.goalInput.runId, outcome: 'finished' });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  release.resolve();
  await delivered;
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  await f.settleNative();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test('an already revoked resource cannot enter provider preparation', async () => {
  const f = fixture();
  const revoked = new AbortController();
  revoked.abort(new Error('synthetic revoked grant'));
  const prepare = mock(f.service.prepare.bind(f.service));
  const resource = await f.resources.prepare(f.location, f.caller.signal);
  const table = new NodeOperationTable({ occupancy: new NodeNativeOccupancy(128), requestContainment: f.containment, connection: f.connection, supervisor: f.supervisor,
    resources: { prepare: async () => ({ ...resource, signal: revoked.signal, execution: { ...f.service,
      prepare, beginDispatch: f.service.retained!.beginDispatch, release: f.service.release.bind(f.service), abort: f.service.abort.bind(f.service),
      prepareSteer: f.service.prepareSteer.bind(f.service), steer: f.service.steer.bind(f.service), submitGoalControl: f.service.submitGoalControl.bind(f.service),
    } }) },
  });
  await expect(table.prepare(f.connection, f.location, f.request, f.caller.signal)).rejects.toThrow('synthetic revoked grant');
  expect(prepare).not.toHaveBeenCalled();
});

test('steering cancellation during noncooperative target capture stays bounded until capture settles', async () => {
  const f = await controlFixture();
  const prepare = f.service.prepareSteer.bind(f.service);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.service.prepareSteer = async (operation, signal) => {
    entered.resolve(); await release.promise; return prepare(operation, signal);
  };
  const capturing = f.prepareSteer().catch((error) => error);
  await entered.promise;
  f.caller.abort(new Error('synthetic capture cancellation'));
  expect(await capturing).toMatchObject({ message: 'synthetic capture cancellation' });
  await expect(f.table.prepareSteer(f.connection, f.ticket.identity, new AbortController().signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  release.resolve();
  await new Promise(setImmediate);
  expect(f.steering.captureTarget).not.toHaveBeenCalled();
  expect((await f.table.prepareSteer(f.connection, f.ticket.identity, new AbortController().signal)).kind).toBe('ready');
});

test('a current recovery connection can cancel an uncommitted control but cannot deliver it', async () => {
  const f = await controlFixture();
  const control = ready(await f.prepareGoal());
  f.supervisor.beginRecovery(f.connection);
  await expect(f.table.commitGoalControl(f.connection, f.ticket.identity, control.controlId)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(f.table.cancelControl(f.connection, f.ticket.identity, control.controlId)).toBe(true);
  await new Promise(setImmediate);
  expect(f.handoff.commit).not.toHaveBeenCalled();
});

test('preparation rejects a deadline crossed during validation even before its timer callback runs', async () => {
  const f = fixture();
  const configured = await f.configuration.resolve();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.configuration.resolve.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return configured; });
  const preparation = f.prepare();
  await entered.promise;
  f.advance(100);
  release.resolve();
  await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
});

test('native admission observes lease expiry before a delayed liveness timer runs', async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.execution.start.mockImplementation(async (request) => {
    entered.resolve(); await release.promise; await request.admission.markStarted(); return f.nativeHandle;
  });
  const ticket = await f.prepare();
  const pending = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  await entered.promise;
  f.advance(15_000);
  release.resolve();
  await expect(pending).resolves.toMatchObject({ kind: 'unknown' });
});

test('a native admission callback cannot reopen an ended occurrence while late output remains valid', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  const { output, admission } = f.execution.start.mock.calls[0]![0];
  output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  await expect(admission.markStarted()).rejects.toThrow('already consumed');
  output.emit({ type: 'notice', runId: f.request.runId, content: 'synthetic late notice' });
  expect(f.events.at(-1)).toMatchObject({ type: 'notice' });
});

test('invalid abort targets reject through the promise surface', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await expect(f.table.abort(f.connection, { ...ticket.identity, operationId: 'synthetic-missing' }))
    .rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  await expect(f.table.abort(f.connection, { ...ticket.identity, logicalSessionId: 'synthetic-foreign' }))
    .rejects.toMatchObject({ code: 'NODE_SESSION_EXPIRED' });
});

test.each(['', 'bad/run', 'synthetic-run'])('rejects invalid goal run identity %s with a validation error', async (runId) => {
  const f = await controlFixture();
  await expect(f.table.prepareGoalControl(f.connection, f.ticket.identity, { ...f.goalInput, runId }, f.caller.signal))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  expect(f.goals.submitControl).not.toHaveBeenCalled();
});

test('a provider claiming goal delivery without a handoff rejects uncertain preparation', async () => {
  const f = await controlFixture();
  f.goals.submitControl.mockImplementation(async () => true);
  await expect(f.prepareGoal()).rejects.toThrow();
  expect(f.table.status(f.connection, f.ticket.identity)).toMatchObject({ value: { control: {
    deliveryPrepared: false, outcome: { kind: 'failed', outcome: 'unknown' },
  } } });
});

test('provider release failure frees capacity and cannot interrupt repeated release', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  f.service.release = () => { throw new Error('synthetic release failure'); };
  expect(() => f.table.release(f.connection, ticket.identity)).toThrow('synthetic release failure');
  expect(() => f.table.release(f.connection, ticket.identity)).not.toThrow();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'released' } });
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(() => f.table.close()).not.toThrow();
});

test('expiry contains release failure and still retires the ticket', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  f.service.release = () => { throw new Error('synthetic release failure'); };
  f.advance(100);
  expect(() => f.table.poll()).not.toThrow();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'expired' } });
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(() => f.table.close()).not.toThrow();
});

test.each(['prepare', 'status'] as const)('authority expiry inside table polling fences %s', async (action) => {
  const f = fixture();
  let expire = false;
  const resources = { prepare: mock(f.resources.prepare.bind(f.resources)) };
  const table = new NodeOperationTable({ occupancy: new NodeNativeOccupancy(128), requestContainment: f.containment, connection: f.connection, resources,
    supervisor: {
      assertConnection: f.supervisor.assertConnection.bind(f.supervisor),
      assertAdmission: f.supervisor.assertAdmission.bind(f.supervisor),
      poll() { if (expire) f.advance(15_000); return f.supervisor.poll(); },
    },
    scheduleTimeout: () => ({ cancel() {} }),
  });
  if (action === 'prepare') {
    expire = true;
    await expect(table.prepare(f.connection, f.location, f.request, f.caller.signal))
      .rejects.toMatchObject({ code: 'NODE_SESSION_EXPIRED' });
    expect(resources.prepare).not.toHaveBeenCalled();
  } else {
    const ticket = await table.prepare(f.connection, f.location, f.request, f.caller.signal);
    expire = true;
    expect(() => table.status(f.connection, ticket.identity)).toThrow('unavailable node session');
  }
});

test('a provider ticket returned after expiry is released once before capacity is reused', async () => {
  const f = fixture();
  const prepare = f.service.prepare.bind(f.service);
  const release = mock(f.service.release.bind(f.service));
  f.service.release = release;
  const entered = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  f.service.prepare = async (request, signal) => {
    const operation = await prepare(request, signal);
    entered.resolve();
    await returned.promise;
    return operation;
  };
  const pending = f.prepare().catch((error) => error);
  await entered.promise;
  f.advance(100);
  f.table.poll();
  expect(await pending).toMatchObject({ name: 'AbortError' });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  returned.resolve();
  await new Promise(setImmediate);
  expect(release).toHaveBeenCalledTimes(1);
  f.service.prepare = prepare;
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test('close attempts every unused ticket release even when each provider release throws', async () => {
  const f = fixture();
  const table = new NodeOperationTable({ occupancy: new NodeNativeOccupancy(128), requestContainment: f.containment, connection: f.connection, supervisor: f.supervisor, resources: f.resources,
    limits: { maxOperations: 2 }, scheduleTimeout: () => ({ cancel() {} }),
  });
  await table.prepare(f.connection, f.location, f.request, f.caller.signal);
  await table.prepare(f.connection, f.location, { ...f.request, chatId: 'synthetic-second-chat', runId: 'synthetic-second-run' }, f.caller.signal);
  const release = mock(() => { throw new Error('synthetic release failure'); });
  f.service.release = release;
  expect(() => table.close()).not.toThrow();
  expect(release).toHaveBeenCalledTimes(2);
  await expect(table.prepare(f.connection, f.location, f.request, f.caller.signal))
    .rejects.toMatchObject({ code: 'NODE_SESSION_EXPIRED' });
});

test.each(['', 'bad/run'])('invalid execution run identity %s never reaches preparation', async (runId) => {
  const f = fixture();
  await expect(f.table.prepare(f.connection, f.location, { ...f.request, runId }, f.caller.signal))
    .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  expect(f.configuration.resolve).not.toHaveBeenCalled();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test('settlement without a terminal retires as failed without inventing a terminal event', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  await f.settleNative();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: {
    phase: 'failed', dispatch: 'accepted', native: 'settled', containment: null,
  } });
  expect(f.occupancy.active).toBe(0);
  expect(f.events).toEqual([]);
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test.each(['terminal', 'abort'] as const)('%s starts one bounded settlement grace without releasing occupancy', async (trigger) => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  if (trigger === 'terminal') f.execution.start.mock.calls[0]![0].output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  else expect(await f.table.abort(f.connection, ticket.identity)).toBe(true);
  f.advance(299);
  f.table.poll();
  expect(f.containment).not.toHaveBeenCalled();
  expect(await f.table.abort(f.connection, ticket.identity)).toBe(true);
  f.advance(1);
  f.table.poll();
  expect(f.containment).toHaveBeenCalledTimes(1);
  expect(f.containment).toHaveBeenCalledWith(ticket.identity, f.location);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { native: 'possible', containment: 'requested' } });
  expect(f.occupancy.active).toBe(1);
  await f.settleNative();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { native: 'possible', containment: 'requested' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  f.table.poll();
  expect(f.containment).toHaveBeenCalledTimes(1);
});

test('uninterrupted native execution has no settlement deadline until terminal or cancellation', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.advance(1_000);
  f.table.poll();
  expect(f.containment).not.toHaveBeenCalled();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'dispatched', native: 'possible' } });
});

test('dispatch timeout stays unknown after a late successful handle and preserves cancellation', async () => {
  const f = fixture();
  const handle = Promise.withResolvers<AgentExecutionHandle>();
  f.execution.start.mockImplementationOnce(() => handle.promise);
  const ticket = await f.prepare();
  const dispatch = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.advance(200);
  f.table.poll();
  await expect(dispatch).resolves.toMatchObject({ kind: 'unknown' });
  expect(await f.table.abort(f.connection, ticket.identity)).toBe(true);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
  handle.resolve(f.nativeHandle);
  await new Promise(setImmediate);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'failed', dispatch: 'unknown', native: 'possible' } });
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).rejects.toMatchObject({ code: 'NODE_OPERATION_UNKNOWN' });
  expect(f.execution.start).toHaveBeenCalledTimes(1);
  await f.settleNative();
  expect(f.occupancy.active).toBe(0);
});

test('rejected settlement observation requests containment and never certifies native completion', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.native.settlements[0]!.reject(new Error('synthetic observation failure'));
  await new Promise(setImmediate);
  expect(f.containment).toHaveBeenCalledTimes(1);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { native: 'possible', containment: 'requested' } });
  expect(f.occupancy.active).toBe(1);
});

test.each(['resolve', 'reject'] as const)('native settlement releases a timed-out dispatch before its late %s', async (late) => {
  const f = fixture();
  const handle = Promise.withResolvers<AgentExecutionHandle>();
  f.execution.start.mockImplementationOnce(() => handle.promise);
  const ticket = await f.prepare();
  const dispatched = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.advance(200);
  f.table.poll();
  await expect(dispatched).resolves.toMatchObject({ kind: 'unknown' });
  expect(await f.table.abort(f.connection, ticket.identity)).toBe(true);
  expect(f.occupancy.active).toBe(1);
  await f.settleNative();
  expect(f.occupancy.active).toBe(0);
  const receipt = f.table.status(f.connection, ticket.identity);
  expect(receipt).toMatchObject({ value: { phase: 'failed', dispatch: 'unknown', native: 'settled' } });
  const successor = await f.prepare();
  await f.table.dispatch(f.connection, successor.identity, f.input, f.output);
  if (late === 'resolve') handle.resolve(f.nativeHandle);
  else handle.reject(new Error('Synthetic late dispatch failure'));
  await new Promise(setImmediate);
  expect(f.table.status(f.connection, ticket.identity)).toEqual(receipt);
  expect(f.table.status(f.connection, successor.identity)).toMatchObject({ value: { phase: 'dispatched', native: 'possible' } });
  expect(f.occupancy.active).toBe(1);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
  expect(f.containment).not.toHaveBeenCalled();
});

test('native settlement before a pending dispatch deadline preserves its receipt until timeout', async () => {
  const f = fixture();
  f.execution.start.mockImplementationOnce(async (request) => {
    request.output.emit({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
    return new Promise<AgentExecutionHandle>(() => {});
  });
  const ticket = await f.prepare();
  const dispatched = f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  await f.settleNative();
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', dispatch: 'pending', native: 'settled' } });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  f.advance(200);
  f.table.poll();
  await expect(dispatched).resolves.toMatchObject({ kind: 'unknown' });
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'ended', dispatch: 'unknown', native: 'settled' } });
  expect(f.occupancy.active).toBe(0);
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
  expect(f.execution.abort).not.toHaveBeenCalled();
  expect(f.containment).not.toHaveBeenCalled();
});

test.each(['throw', 'outcome'] as const)('proven pre-entry refusal by %s releases unused capacity', async (refusal) => {
  const error = new Error('synthetic refused before native entry');
  const f = fixture({ executionLifetime: { begin() {
    if (refusal === 'throw') throw error;
    return { dispatch: Promise.resolve({ kind: 'rejected', error }), settled: Promise.resolve(), abort: async () => false };
  } } });
  const ticket = await f.prepare();
  await expect(f.table.dispatch(f.connection, ticket.identity, f.input, f.output)).resolves.toEqual({ kind: 'rejected', error });
  await new Promise(setImmediate);
  expect(f.table.status(f.connection, ticket.identity)).toMatchObject({ value: { phase: 'failed', dispatch: 'rejected', native: 'none' } });
  expect(f.occupancy.active).toBe(0);
  expect(f.execution.start).not.toHaveBeenCalled();
  expect(f.execution.abort).not.toHaveBeenCalled();
  expect(f.containment).not.toHaveBeenCalled();
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test('a provider without native attestation retains workspace grants but cannot prepare execution', async () => {
  const f = fixture({ executionLifetime: null });
  await expect(f.resources.prepare(f.location, f.caller.signal)).resolves.toMatchObject({ projectPath: '/synthetic/project', execution: null });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
  expect(f.occupancy.active).toBe(0);
  expect(f.configuration.resolve).not.toHaveBeenCalled();
});

test('ended native work blocks its chat successor while an unrelated chat remains usable', async () => {
  const f = fixture({}, { maxOperations: 2 });
  const first = await f.prepare();
  await f.table.dispatch(f.connection, first.identity, f.input, f.output);
  f.execution.start.mock.calls[0]![0].output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'finished' });
  await expect(f.prepare()).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
  const sibling = await f.table.prepare(f.connection, f.location, { ...f.request, chatId: 'synthetic-sibling', runId: 'synthetic-sibling-run' }, f.caller.signal);
  await expect(f.table.dispatch(f.connection, sibling.identity, f.input, f.output)).resolves.toEqual({ kind: 'accepted' });
  expect(f.occupancy.active).toBe(2);
  await f.settleNative();
  expect(f.occupancy.active).toBe(1);
  expect(f.table.status(f.connection, sibling.identity)).toMatchObject({ value: { phase: 'dispatched', native: 'possible' } });
  await expect(f.prepare()).resolves.toMatchObject({ runId: f.request.runId });
});

test('table shutdown retains native capacity until exact settlement', async () => {
  const f = fixture();
  const ticket = await f.prepare();
  await f.table.dispatch(f.connection, ticket.identity, f.input, f.output);
  f.table.close();
  await new Promise(setImmediate);
  expect(f.execution.abort).toHaveBeenCalledTimes(1);
  expect(f.occupancy.active).toBe(1);
  await f.settleNative();
  expect(f.occupancy.active).toBe(0);
});
