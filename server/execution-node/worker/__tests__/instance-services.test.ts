import { expect, mock, test } from 'bun:test';
import { NodeProviderCapacity } from '../../provider-capacity.js';
import { MAX_NODE_STREAM_IDENTITIES } from '../../replay-cache.js';
import { createHash } from 'node:crypto';
import { NODE_WIRE_VERSION, parseNodeOutputText, type AgentStartRequestV5, type NodeOutputFrame } from '@garcon/server-agent-interface';
import { AssistantMessage, BashToolUseMessage } from '../../../../common/chat-types.js';
import { NodeExecutionHost } from '../../execution-host.js';
import { NodeProviderCatalogHost } from '../../provider-catalog-host.js';
import { NodeProviderAuthHost } from '../../provider-auth-host.js';
import { NodeProviderCommandsHost } from '../../provider-commands-host.js';
import { NodeProviderConfigurationHost } from '../../provider-configuration-host.js';
import { NodeSessionConfigurationHost } from '../../provider-session-configuration-host.js';
import type { ProviderConfigurationUpdateRequest } from '../../../execution-nodes/provider-configuration.js';
import { NodeExecutionResources } from '../../execution-resources.js';
import { LocalProviderExecutionService } from '../../local-provider-execution.js';
import { NodeOperationTable } from '../../operation-table.js';
import { serializeNodeExecutionBody } from '../../../execution-nodes/transport/execution-body-wire.js';
import { serializeNodeBulkFrame } from '../../../execution-nodes/transport/bulk-channel-wire.js';
import type { NodePermissionReference } from '../../../execution-nodes/transport/permission-wire.js';
import { NodeWorkerAuthority } from '../authority.js';
import { NodeWorkerInstanceServices } from '../instance-services.js';
import { NodeWorkerOutputAssembler } from '../output-assembler.js';
import { parseNodeWorkerBulkText } from '../bulk-protocol.js';
import { parseNodeWorkerOutputRetirementText, serializeNodeWorkerOutputRetirement } from '../output-retirement.js';
import { NODE_WORKER_SERVICE_LIMITS, NODE_WORKER_WRITER_LIMITS } from '../limits.js';
import { NodeWorkerWriter } from '../writer.js';
import type { NodeWorkerServiceCommand } from '../service-protocol.js';
import { session, tick } from './lifecycle-fixture.js';

const settingsSnapshot = { model: 'synthetic-model', permissionMode: 'default' as const, thinkingMode: 'none' as const,
  settings: { ownerId: 'synthetic', schemaVersion: 1, values: {} }, endpoint: null };
const settingsRequest = { previous: settingsSnapshot, next: { model: 'synthetic-model', endpoint: null }, patch: {} };

function fixture() {
  const lifetime = new AbortController();
  const authority = new NodeWorkerAuthority({ session, signal: lifetime.signal, poll: () => 1 });
  const connection = authority.attach(1); authority.openAdmissions(1);
  const location = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' };
  const stream = { ...session, streamId: 'synthetic-stream' };
  const execution = { start: mock(async (_request: AgentStartRequestV5) => ({})), resume: mock(async () => ({})),
    abort: mock(async () => true), runningSessions: () => [] };
  const service = new LocalProviderExecutionService({ descriptor: { id: 'synthetic', label: 'Synthetic', icon: null,
    supportedPermissionModes: ['default'], supportedThinkingModes: ['none'], supportsImages: false,
    supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [] },
    execution, steering: null, goals: null, compaction: null }, { resolve: async (request) => ({ ...request,
    permissionMode: request.permissionMode ?? 'default', thinkingMode: request.thinkingMode ?? 'none',
    settings: request.settings ?? { ownerId: 'synthetic', schemaVersion: 1, values: {} } }) });
  const resources = new NodeExecutionResources(location.nodeId);
  resources.register({ location, projectPath: '/synthetic/project', execution: service,
    files: { inspectProject: async () => ({ kind: 'available', effectiveProjectKey: '/synthetic/project' }) } });
  const table = new NodeOperationTable({ supervisor: authority, connection, resources, limits: { maxOperations: 4 } });
  const host = new NodeExecutionHost(connection, authority, table);
  const failed = mock((_error: unknown) => {});
  const frames: NodeOutputFrame[] = []; const controls: string[] = [];
  const assembler = new NodeWorkerOutputAssembler({ session, signal: lifetime.signal, instanceIds: new Set([location.instanceId]),
    now: () => 1, validate() {}, failed });
  const writer = new NodeWorkerWriter({ async write(bytes) {
    const text = Buffer.from(bytes.subarray(4)).toString();
    if (parseNodeWorkerBulkText(text)) controls.push(text);
    else if (parseNodeWorkerOutputRetirementText(text)) { controls.push(text); assembler.receiveRetirement(location.instanceId, text); }
    else assembler.receive(location.instanceId, text);
  }, close() {} }, { ...NODE_WORKER_WRITER_LIMITS, signal: lifetime.signal, failed });
  const catalogRead = mock(async () => ({ models: [{ value: 'synthetic-model', label: 'Synthetic' }], defaultModel: 'synthetic-model',
    requiresStrictModelDiscovery: true, generation: null }));
  const authRead = mock(async () => ({ authenticated: true, canReauth: false, label: 'Synthetic', source: 'cli' as const }));
  const commandsRead = mock(async () => [{ name: 'synthetic-review', source: 'skill' as const }]);
  const prepareUpdate = mock(async (_request: ProviderConfigurationUpdateRequest) => ({ previous: settingsSnapshot, next: settingsSnapshot }));
  const launchLogin = mock(async () => ({ launched: true, alreadyRunning: false, sessionId: 'synthetic-login' }));
  const providerCapacity = new NodeProviderCapacity();
  const services = new NodeWorkerInstanceServices({ authority, instanceId: location.instanceId, host, writer,
    sessionConfiguration: new NodeSessionConfigurationHost({ instanceId: location.instanceId, connection, supervisor: authority,
      capacity: providerCapacity, resources, execution: host, configuration: {
        prepareApply: async () => ({ kind: 'unsupported' }), commit: async () => ({ kind: 'not-required' }), cancel: async () => {},
      } }),
    configuration: new NodeProviderConfigurationHost(providerCapacity, location.instanceId, { prepareUpdate }),
    catalog: new NodeProviderCatalogHost(providerCapacity, location.instanceId, { snapshot: catalogRead }),
    commands: new NodeProviderCommandsHost(providerCapacity, location, resources, { discover: commandsRead }),
    auth: new NodeProviderAuthHost(providerCapacity, location.instanceId, { status: authRead, loginStatus: async () => ({ state: 'idle', running: false }),
      launchLogin,
      completeLogin: async ({ sessionId }) => ({ submitted: true, sessionId }) }) });
  const install = async (target = stream) => {
    assembler.install(location.instanceId, target, lifetime.signal, (text) => {
      const frame = parseNodeOutputText(text); if (!frame) throw new Error('Invalid synthetic output'); frames.push(frame);
    }, failed);
    expect(await services.service(connection, { method: 'install-output', instanceId: location.instanceId, stream: target }, connection.signal))
      .toEqual({ kind: 'output-installed', instanceId: location.instanceId, stream: target });
  };
  let requestId = 0;
  const bulk = (payload: string, connectionId = 1) => services.bulk({ type: 'node-worker-bulk', version: NODE_WIRE_VERSION,
    session, connectionId, instanceId: location.instanceId, payload });
  const prepare = async (runId = 'synthetic-run', chatId = '1789000000000001') => {
    const result = await services.execution(connection, { method: 'prepare', location, request: { kind: 'start',
      chatId, runId, configuration: { model: 'synthetic-model', settings: null, endpoint: null } } }, connection.signal);
    if (result.kind !== 'prepared') throw new Error('Synthetic preparation failed');
    const bytes = serializeNodeExecutionBody({ kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } });
    const reserved = await services.service(connection, { method: 'reserve-body', instanceId: location.instanceId,
      identity: result.ticket.identity, kind: 'execution', controlId: null,
      descriptor: { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }, connection.signal);
    if (reserved.kind !== 'body-reserved') throw new Error('Synthetic reservation failed');
    return { ticket: result.ticket, transfer: reserved.transfer, bytes };
  };
  const start = async (target = stream, runId = 'synthetic-run', chatId = '1789000000000001') => {
    const { ticket, transfer, bytes } = await prepare(runId, chatId);
    bulk(serializeNodeBulkFrame({ type: 'node-bulk-chunk', version: NODE_WIRE_VERSION, transfer, offset: 0, data: Buffer.from(bytes).toString('base64') }));
    bulk(serializeNodeBulkFrame({ type: 'node-bulk-complete', version: NODE_WIRE_VERSION, transfer, requestId: ++requestId }));
    expect(await services.execution(connection, { method: 'dispatch', identity: ticket.identity, stream: target, body: transfer }, connection.signal))
      .toEqual({ kind: 'dispatched' });
    return { ticket, output: execution.start.mock.calls.at(-1)![0].output };
  };
  return { authority, connection, location, stream, host, services, catalogRead, authRead, commandsRead, prepareUpdate, launchLogin, execution, frames, controls, failed, install, prepare, start,
    close() { lifetime.abort(); services.close(); host.close(); resources.close(); assembler.close(); writer.close(); } };
}

test.each(['catalog', 'commands', 'configuration', 'login'] as const)('unsettled %s work shares native capacity with every provider facet after reconnect', async (facet) => {
  const f = fixture();
  const capacity = NODE_WORKER_SERVICE_LIMITS.maxProviderRequests - NODE_WORKER_SERVICE_LIMITS.reservedProviderStatusRequests;
  const native = Promise.withResolvers<void>();
  const status = Promise.withResolvers<void>();
  const catalogValue = await f.catalogRead(); f.catalogRead.mockClear();
  const commandsValue = await f.commandsRead(); f.commandsRead.mockClear();
  const loginValue = await f.launchLogin(); f.launchLogin.mockClear();
  const statusValue = await f.authRead(); f.authRead.mockClear();
  const configurationValue = await f.prepareUpdate(settingsRequest); f.prepareUpdate.mockClear();
  const requests = {
    catalog: { method: 'provider-catalog', instanceId: f.location.instanceId, strict: true },
    commands: { method: 'provider-commands', instanceId: f.location.instanceId, workspaceId: f.location.workspaceId },
    configuration: { method: 'provider-configuration', instanceId: f.location.instanceId, operation: 'prepare-update', request: settingsRequest },
    login: { method: 'provider-auth', instanceId: f.location.instanceId, operation: 'launch-login' },
  } satisfies Record<typeof facet, NodeWorkerServiceCommand>;
  for (let i = 0; i < capacity; i++) {
    if (facet === 'catalog') f.catalogRead.mockImplementationOnce(async () => { await native.promise; return catalogValue; });
    if (facet === 'commands') f.commandsRead.mockImplementationOnce(async () => { await native.promise; return commandsValue; });
    if (facet === 'configuration') f.prepareUpdate.mockImplementationOnce(async () => { await native.promise; return configurationValue; });
    if (facet === 'login') f.launchLogin.mockImplementationOnce(async () => { await native.promise; return loginValue; });
  }
  const pending = Array.from({ length: capacity }, () => f.services.service(f.connection, requests[facet], f.connection.signal));
  try {
    await tick();
    const reads = { catalog: f.catalogRead, commands: f.commandsRead, configuration: f.prepareUpdate, login: f.launchLogin };
    expect(reads[facet]).toHaveBeenCalledTimes(capacity);
    f.authority.disconnect(1);
    const connection = f.authority.attach(2); f.authority.openAdmissions(2);
    for (const command of Object.values(requests)) {
      expect(await f.services.service(connection, command, connection.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    }
    const poll = { method: 'provider-auth', instanceId: f.location.instanceId, operation: 'status' } as const;
    f.authRead.mockImplementationOnce(async () => { await status.promise; return statusValue; });
    const pendingStatus = f.services.service(connection, poll, connection.signal);
    expect(f.authRead).toHaveBeenCalledTimes(1);
    expect(await f.services.service(connection, poll, connection.signal)).toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    status.resolve();
    expect(await pendingStatus).toMatchObject({ kind: 'provider-auth-status', status: statusValue });
    expect(await f.services.service(connection, { ...poll, operation: 'login-status', sessionId: null }, connection.signal))
      .toMatchObject({ kind: 'provider-login-status', status: { state: 'idle' } });
    expect(await f.services.service(connection, { method: 'install-output', instanceId: f.location.instanceId, stream: f.stream }, connection.signal))
      .toMatchObject({ kind: 'output-installed' });
    native.resolve(); await Promise.all(pending);
    for (const command of Object.values(requests)) {
      expect(await f.services.service(connection, command, connection.signal)).not.toHaveProperty('kind', 'rejected');
    }
    expect(f.failed).not.toHaveBeenCalled();
  } finally { native.resolve(); status.resolve(); await Promise.all(pending); f.close(); }
});

test('settings validation requires the exact instance and recovered admission', async () => {
  const f = fixture();
  const command = { method: 'provider-configuration', instanceId: f.location.instanceId, operation: 'prepare-update', request: settingsRequest } as const;
  try {
    expect(await f.services.service(f.connection, { ...command, instanceId: 'foreign' }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(f.prepareUpdate).not.toHaveBeenCalled();
    expect(await f.services.service(f.connection, command, f.connection.signal)).toMatchObject({ kind: 'provider-configuration-prepared', instanceId: f.location.instanceId });
    const recovering = f.authority.attach(2);
    expect(await f.services.service(recovering, command, recovering.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.prepareUpdate).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('command discovery requires exact instance, workspace grant, and recovered admission', async () => {
  const f = fixture();
  const command = { method: 'provider-commands', instanceId: f.location.instanceId, workspaceId: f.location.workspaceId } as const;
  try {
    expect(await f.services.service(f.connection, { ...command, instanceId: 'foreign' }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(await f.services.service(f.connection, { ...command, workspaceId: 'foreign' }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.commandsRead).not.toHaveBeenCalled();
    expect(await f.services.service(f.connection, command, f.connection.signal)).toMatchObject({ kind: 'provider-commands',
      instanceId: f.location.instanceId, workspaceId: f.location.workspaceId, commands: [{ name: 'synthetic-review' }] });
    expect(f.commandsRead).toHaveBeenCalledWith({ projectPath: '/synthetic/project' }, expect.any(AbortSignal));
    const recovering = f.authority.attach(2);
    expect(await f.services.service(recovering, command, recovering.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.commandsRead).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('native authentication validates the exact instance and admission before reading credentials', async () => {
  const f = fixture();
  const command = { method: 'provider-auth', instanceId: f.location.instanceId, operation: 'status' } as const;
  try {
    expect(await f.services.service(f.connection, { ...command, instanceId: 'foreign' }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(f.authRead).not.toHaveBeenCalled();
    expect(await f.services.service(f.connection, command, f.connection.signal))
      .toMatchObject({ kind: 'provider-auth-status', instanceId: f.location.instanceId, status: { authenticated: true } });
    const reconnecting = f.authority.attach(2);
    expect(await f.services.service(reconnecting, command, reconnecting.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.authRead).toHaveBeenCalledTimes(1);
  } finally { f.close(); }
});

test('the instance installs its byte and output capabilities before provider dispatch and publishes immutable bytes', async () => {
  const f = fixture();
  try {
    await f.install();
    const { output } = await f.start();
    const message = new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic output');
    output.emit({ type: 'rows', rows: [{ message }] });
    message.content = 'mutated after admission';
    await tick();
    expect(f.frames).toHaveLength(1);
    expect(JSON.stringify(f.frames[0])).toContain('synthetic output');
    expect(f.execution.start.mock.calls[0]![0].prompt).toBe('synthetic input');
    expect(f.host.transfers.reservedBytes).toBe(0);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('logical output and one-shot permission responses survive physical disconnect and caller cancellation', async () => {
  const f = fixture(); const native = Promise.withResolvers<void>();
  try {
    await f.install(); const { ticket, output } = await f.start();
    const occurrence = '00000000-0000-4000-8000-000000000001'; const respond = mock(() => native.promise);
    f.authority.disconnect(1);
    output.emit({ type: 'permission', runId: ticket.runId, decision: { permissionOccurrenceId: occurrence, respond },
      lifecycle: { kind: 'requested', permissionOccurrenceId: occurrence,
        requestedTool: new BashToolUseMessage('2026-09-09T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [{ id: 'allow', label: 'Allow' }] } });
    await tick();
    const frame = f.frames[0]!;
    if (frame.event.type !== 'permission' || !frame.event.decisionHandle) throw new Error('Missing synthetic permission');
    const permission: NodePermissionReference = { stream: frame.stream, runId: ticket.runId, permissionOccurrenceId: occurrence, handle: frame.event.decisionHandle };
    const next = f.authority.attach(2); f.authority.openAdmissions(2);
    const caller = new AbortController();
    const command = { method: 'permission' as const, command: { method: 'permission-respond' as const, permission, decision: { allow: true } } };
    const first = f.services.service(next, command, caller.signal); await tick(); caller.abort();
    await first;
    expect(respond).toHaveBeenCalledTimes(1);
    const retry = f.services.service(next, command, next.signal); native.resolve();
    expect(await retry).toMatchObject({ kind: 'permission-result', result: { receipt: { phase: 'resolved' } } });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(f.authority.signal.aborted).toBe(false); expect(f.failed).not.toHaveBeenCalled();
  } finally { native.resolve(); f.close(); }
});

test('parent stream retirement aborts only its captured operations and does not echo a retirement', async () => {
  const f = fixture();
  try {
    const sibling = { ...f.stream, streamId: 'synthetic-sibling' };
    await f.install(); await f.install(sibling);
    const first = await f.start(); const second = await f.start(sibling, 'synthetic-successor', '1789000000000002');
    await tick(); const prior = f.controls.length;
    const retirement = serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', reason: 'output-retired', version: NODE_WIRE_VERSION,
      instanceId: f.location.instanceId, stream: f.stream });
    f.services.receiveRetirement(retirement); f.services.receiveRetirement(retirement);
    first.output.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'retired') }] });
    second.output.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'sibling') }] });
    await tick();
    expect(f.execution.abort).toHaveBeenCalledTimes(1); expect(f.controls).toHaveLength(prior);
    expect(f.frames).toHaveLength(1); expect(f.frames[0]?.stream).toEqual(sibling);
    expect(f.authority.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('acknowledged retirement fences output once without releasing active native execution capacity', async () => {
  const f = fixture();
  try {
    const starts = [];
    for (let i = 0; i < 4; i++) {
      const stream = { ...f.stream, streamId: `synthetic-capacity-${i}` };
      await f.install(stream);
      starts.push({ stream, ...await f.start(stream, `synthetic-run-${i}`, `178900000000000${i + 1}`) });
    }
    const first = starts[0]!;
    const command = { method: 'retire-output', instanceId: f.location.instanceId, stream: first.stream } as const;
    const expected = { kind: 'output-fenced', instanceId: f.location.instanceId, stream: first.stream };
    expect(await f.services.service(f.connection, command, f.connection.signal)).toEqual(expected);
    expect(await f.services.service(f.connection, command, f.connection.signal)).toEqual(expected);
    await tick();
    expect(f.execution.abort).toHaveBeenCalledTimes(1);
    expect(await f.services.execution(f.connection, { method: 'prepare', location: f.location, request: { kind: 'start',
      chatId: '1789000000000005', runId: 'synthetic-next', configuration: { model: 'synthetic-model', settings: null, endpoint: null } } }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_CAPACITY' });
    first.output.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic retired output') }] });
    starts[1]!.output.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic sibling output') }] });
    await tick();
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]?.stream).toEqual(starts[1]!.stream);
    expect(f.authority.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('recovery admits exact retirement and preinstall tombstones without admitting new output', async () => {
  const f = fixture();
  try {
    const recovery = f.authority.attach(2);
    const command = { method: 'retire-output', instanceId: f.location.instanceId, stream: f.stream } as const;
    expect(await f.services.service(recovery, { ...command, instanceId: 'synthetic-foreign' }, recovery.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(await f.services.service(recovery, command, recovery.signal))
      .toEqual({ kind: 'output-fenced', instanceId: f.location.instanceId, stream: f.stream });
    expect(await f.services.service(recovery, { ...command, method: 'install-output' }, recovery.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    f.authority.openAdmissions(2);
    expect(await f.services.service(recovery, { ...command, method: 'install-output' }, recovery.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(f.execution.abort).not.toHaveBeenCalled();
    expect(f.authority.signal.aborted).toBe(false);
  } finally { f.close(); }
});

test('disconnect releases incomplete physical bodies while retaining prepared logical operations', async () => {
  const f = fixture();
  try {
    await f.install(); const { ticket, transfer, bytes } = await f.prepare();
    expect(f.host.transfers.reservedBytes).toBe(bytes.length);
    f.authority.disconnect(1); const next = f.authority.attach(2); f.authority.openAdmissions(2);
    expect(f.host.transfers.status(transfer)).toBeNull(); expect(f.host.transfers.reservedBytes).toBe(0);
    expect(await f.services.execution(next, { method: 'status', identity: ticket.identity }, next.signal))
      .toMatchObject({ kind: 'status', receipt: { phase: 'prepared' } });
    expect(f.execution.start).not.toHaveBeenCalled();
  } finally { f.close(); }
});

test('native catalog discovery checks exact instance and admission before invoking the provider', async () => {
  const f = fixture();
  try {
    const command = { method: 'provider-catalog', instanceId: f.location.instanceId, strict: true } as const;
    expect(await f.services.service(f.connection, { ...command, instanceId: 'foreign' }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    expect(f.catalogRead).not.toHaveBeenCalled();
    expect(await f.services.service(f.connection, command, f.connection.signal)).toMatchObject({ kind: 'provider-catalog', instanceId: f.location.instanceId });
    expect(f.catalogRead).toHaveBeenCalledWith({ strict: true }, expect.any(AbortSignal));
    const next = f.authority.attach(2);
    expect(await f.services.service(next, command, next.signal)).toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
    expect(f.catalogRead).toHaveBeenCalledTimes(1);
    f.authority.openAdmissions(2);
    expect(await f.services.service(next, command, next.signal)).toMatchObject({ kind: 'provider-catalog' });
    expect(f.catalogRead).toHaveBeenCalledTimes(2);
  } finally { f.close(); }
});

test('stream installation rejects foreign instances, recovery gates and reused identities', async () => {
  const f = fixture();
  try {
    expect(await f.services.service(f.connection, { method: 'install-output', instanceId: 'foreign', stream: f.stream }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    await f.install();
    expect(await f.services.service(f.connection, { method: 'install-output', instanceId: f.location.instanceId, stream: f.stream }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const retired = { ...f.stream, streamId: 'retired-before-installation' };
    f.services.receiveRetirement(serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', reason: 'output-retired', version: NODE_WIRE_VERSION,
      instanceId: f.location.instanceId, stream: retired }));
    expect(await f.services.service(f.connection, { method: 'install-output', instanceId: f.location.instanceId, stream: retired }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'VALIDATION_FAILED' });
    const next = f.authority.attach(2);
    expect(await f.services.service(next, { method: 'install-output', instanceId: f.location.instanceId, stream: { ...f.stream, streamId: 'new' } }, next.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_UNAVAILABLE' });
  } finally { f.close(); }
});

test('unknown retirement at the identity ceiling remains inert after install refusal', async () => {
  const f = fixture();
  try {
    await f.install();
    const { output } = await f.start();
    for (let i = 1; i < MAX_NODE_STREAM_IDENTITIES; i++) f.services.receiveRetirement(serializeNodeWorkerOutputRetirement({
      type: 'node-worker-output-retired', reason: 'output-retired', version: NODE_WIRE_VERSION, instanceId: f.location.instanceId,
      stream: { ...f.stream, streamId: `retired-${i}` },
    }));
    const unknown = { ...f.stream, streamId: 'never-installed' };
    expect(await f.services.service(f.connection, { method: 'install-output', instanceId: f.location.instanceId, stream: unknown }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_STREAM_IDENTITIES_EXHAUSTED' });
    expect(() => f.services.receiveRetirement(serializeNodeWorkerOutputRetirement({ type: 'node-worker-output-retired', reason: 'output-retired', version: NODE_WIRE_VERSION,
      instanceId: f.location.instanceId, stream: unknown }))).not.toThrow();
    expect(await f.services.service(f.connection, { method: 'retire-output', instanceId: f.location.instanceId, stream: unknown }, f.connection.signal))
      .toEqual({ kind: 'rejected', code: 'NODE_STREAM_IDENTITIES_EXHAUSTED' });
    expect(await f.services.service(f.connection, { method: 'retire-output', instanceId: f.location.instanceId,
      stream: { ...f.stream, streamId: 'retired-1' } }, f.connection.signal)).toMatchObject({ kind: 'output-fenced' });
    output.emit({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic sibling output') }] });
    await tick();
    expect(f.frames).toHaveLength(1);
    expect(f.authority.signal.aborted).toBe(false);
    expect(f.failed).not.toHaveBeenCalled();
  } finally { f.close(); }
});
