import { NodeNativeOccupancy } from '../../native-occupancy.js';
import { executionLifetimeFixture } from '../../__tests__/execution-lifetime-fixture.js';
import { expect, mock, test } from 'bun:test';
import type { AgentExecutionHandle, AgentResumeRequestV5, AgentStartRequestV5 } from '@garcon/server-agent-interface';
import { LocalProviderExecutionService } from '../../local-provider-execution.js';
import { NodeExecutionResources } from '../../execution-resources.js';
import { NodeOperationTable, type NodeExecutionRequest } from '../../operation-table.js';
import { NodeWorkerAuthority } from '../authority.js';
import { NodeWorkerLifeline, NODE_WORKER_PULSE_TIMEOUT_MS } from '../lifeline.js';

function fixture() {
  let now = 0;
  const lifeline = new NodeWorkerLifeline({ clock: { read: () => ({ elapsedMs: now, discontinuity: false }) },
    scheduleTimeout: () => ({ cancel() {} }), retired() {} });
  lifeline.configure();
  const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };
  const authority = new NodeWorkerAuthority({ session, signal: lifeline.signal, poll: () => lifeline.poll() });
  const connection = authority.attach(1);
  const handle = Object.freeze({});
  const execution = {
    start: mock(async (_request: AgentStartRequestV5): Promise<AgentExecutionHandle> => handle),
    resume: mock(async (_request: AgentResumeRequestV5): Promise<AgentExecutionHandle> => handle),
    abort: mock(async (_handle: AgentExecutionHandle) => true), runningSessions: () => [],
  };
  const native = executionLifetimeFixture(execution, handle);
  const service = new LocalProviderExecutionService({ execution, executionLifetime: native.lifetime, compaction: null, steering: null, goals: null,
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'],
      supportedThinkingModes: ['none'], supportsImages: false, supportsProjectPathUpdate: false,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [] },
  }, { resolve: async () => ({ model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none',
    settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null }) });
  const location = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' };
  const resources = new NodeExecutionResources(location.nodeId);
  resources.register({ location, projectPath: '/synthetic/project', execution: service.retained,
    files: { inspectProject: async () => ({ kind: 'available', effectiveProjectKey: '/synthetic/project' }) } });
  const table = new NodeOperationTable({ occupancy: new NodeNativeOccupancy(1), requestContainment() { authority.retire(); }, supervisor: authority, connection, resources, limits: { maxOperations: 1 },
    scheduleTimeout: () => ({ cancel() {} }) });
  const request: NodeExecutionRequest = { kind: 'start', chatId: '1789000000000001', runId: 'synthetic-run',
    configuration: { model: 'synthetic-model', settings: null, endpoint: null } };
  const input = { prompt: 'synthetic prompt', attachments: [], carriedContext: null };
  return { native, lifeline, authority, connection, execution, table, location, request, input, handle,
    expire() { now += NODE_WORKER_PULSE_TIMEOUT_MS; }, close() { lifeline.close(); resources.close(); table.close(); } };
}

test('worker recovery keeps the exact operation and its capacity while local admission remains closed', async () => {
  const f = fixture();
  try {
    await expect(f.table.prepare(f.connection, f.location, f.request, f.lifeline.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    f.authority.openAdmissions(1);
    const ticket = await f.table.prepare(f.connection, f.location, f.request, f.lifeline.signal);
    await f.table.dispatch(f.connection, ticket.identity, f.input, { signal: f.connection.authoritySignal, emit() {} });
    const native = f.execution.start.mock.calls[0]![0];
    f.authority.disconnect(1);
    expect(native.admission.signal.aborted).toBe(false);
    expect(f.execution.abort).not.toHaveBeenCalled();
    const replacement = f.authority.attach(2);
    expect(() => f.table.status(f.connection, ticket.identity)).toThrow();
    expect(f.table.status(replacement, ticket.identity)).toMatchObject({ kind: 'completed', value: { phase: 'dispatched' } });
    await expect(f.table.prepare(replacement, f.location, f.request, f.lifeline.signal)).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' });
    expect(await f.table.abort(replacement, ticket.identity)).toBe(true);
    f.authority.openAdmissions(2);
    await expect(f.table.prepare(replacement, f.location, f.request, f.lifeline.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    native.output.emit({ type: 'run-ended', runId: f.request.runId, outcome: 'interrupted' });
    await expect(f.table.prepare(replacement, f.location, f.request, f.lifeline.signal)).rejects.toMatchObject({ code: 'NODE_CAPACITY' });
    f.native.settlements[0]!.resolve();
    await new Promise(setImmediate);
    const next = await f.table.prepare(replacement, f.location, { ...f.request, runId: 'synthetic-next-run' }, f.lifeline.signal);
    expect(next.identity.operationId).not.toBe(ticket.identity.operationId);
  } finally { f.close(); }
});

test('worker expiry aborts a late native handle and no new physical gate can restore its session', async () => {
  const f = fixture();
  const started = Promise.withResolvers<AgentExecutionHandle>();
  try {
    f.authority.openAdmissions(1);
    f.execution.start.mockImplementationOnce(() => started.promise);
    const ticket = await f.table.prepare(f.connection, f.location, f.request, f.lifeline.signal);
    const dispatched = f.table.dispatch(f.connection, ticket.identity, f.input, { signal: f.connection.authoritySignal, emit() {} }).catch((error: unknown) => error);
    await new Promise(setImmediate);
    f.expire();
    expect(() => f.table.status(f.connection, ticket.identity)).toThrow();
    expect(f.execution.start.mock.calls[0]![0].admission.signal.aborted).toBe(true);
    expect(() => f.authority.attach(2)).toThrow();
    started.resolve(f.handle);
    await dispatched;
    expect(f.execution.abort).toHaveBeenCalledTimes(1);
    expect(f.execution.abort.mock.calls[0]![0]).toBe(f.handle);
  } finally { started.resolve(f.handle); f.close(); }
});
