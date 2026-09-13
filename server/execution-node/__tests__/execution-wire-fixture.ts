import { expect, mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { NODE_WIRE_VERSION, type AgentExecutionHandle, type AgentStartRequestV5, type AgentProducerEvent, type AgentGoalControlRequest, type AgentSteerRequest } from '@garcon/server-agent-interface';
import { NodeNativeOccupancy } from '../native-occupancy.js';
import { executionLifetimeFixture } from './execution-lifetime-fixture.js';
import { LocalProviderExecutionService } from '../local-provider-execution.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { DEFAULT_NODE_OPERATIONS, NodeOperationTable } from '../operation-table.js';
import { NodeSupervisor, type NodeConnectionLease } from '../supervisor.js';
import { NodeExecutionWireAdapter, type NodeExecutionWireCapabilities } from '../execution-wire-adapter.js';
import { parseNodeExecutionCallText, serializeNodeExecutionCall, type NodeExecutionCommand } from '../../execution-nodes/transport/execution-wire.js';
import { parseNodeExecutionReplyText, serializeNodeExecutionReply } from '../../execution-nodes/transport/execution-receipt-wire.js';
import { NodeBulkTransfers } from '../../execution-nodes/transport/bulk-transfers.js';
import { serializeNodeExecutionBody, type NodeExecutionBody } from '../../execution-nodes/transport/execution-body-wire.js';
import type { ProviderConfigurationResolver } from '../../execution-nodes/provider-configuration.js';
import type { NodeOperationIdentity } from '../../../common/node-operation.js';

export function executionWireFixture(maxOperations = 1, preparationMs = DEFAULT_NODE_OPERATIONS.preparationMs) {
  let elapsedMs = 0;
  const supervisor = new NodeSupervisor({ clock: { read: () => ({ elapsedMs, discontinuity: false }) }, async cleanup() {} });
  const session = supervisor.openSession('synthetic-controller');
  const connection = supervisor.attach(session);
  supervisor.completeRecovery(connection, supervisor.beginRecovery(connection));
  const handle = Object.freeze({});
  const execution = {
    start: mock(async (request: AgentStartRequestV5) => {
      request.output.emit({ type: 'session', session: { agentSessionId: 'synthetic-native', nativeSession: null, nativeSeedReceipt: null } });
      return handle;
    }),
    resume: mock(async () => handle), abort: mock(async (_handle: AgentExecutionHandle) => true), runningSessions: () => [],
  };
  const steering = { captureTarget: mock(() => ({})),
    steer: mock(async (request: AgentSteerRequest) => { await request.prepareDelivery(); return { kind: 'accepted' as const }; }) };
  const goals = { submitControl: mock(async (request: AgentGoalControlRequest) => {
    let committed = false;
    await request.beforeDelivery({ validate() {}, commit() { committed = true; } });
    return committed;
  }) };
  const native = executionLifetimeFixture(execution, handle);
  const integration = { descriptor: { id: 'synthetic', label: 'Synthetic', icon: null,
    supportedPermissionModes: ['default'], supportedThinkingModes: ['none'], supportsImages: true,
    supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [] },
    execution, executionLifetime: native.lifetime, steering, goals, compaction: null,
  } satisfies ConstructorParameters<typeof LocalProviderExecutionService>[0];
  const configuration = { resolve: async (request) => ({ ...request,
    permissionMode: request.permissionMode ?? 'default', thinkingMode: request.thinkingMode ?? 'none',
    settings: request.settings ?? { ownerId: 'synthetic', schemaVersion: 1, values: {} } }),
  } satisfies ProviderConfigurationResolver;
  const service = new LocalProviderExecutionService(integration, configuration);
  const location = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', workspaceId: 'synthetic-workspace' };
  const resources = new NodeExecutionResources(location.nodeId);
  resources.register({ location, execution: service.retained, projectPath: '/synthetic/project',
    files: { inspectProject: async () => ({ kind: 'available', effectiveProjectKey: '/synthetic/project' }) } });
  const occupancy = new NodeNativeOccupancy(maxOperations);
  const containment = mock(() => {});
  const table = new NodeOperationTable({ supervisor, connection, resources, occupancy, requestContainment: containment, limits: { maxOperations, preparationMs }, scheduleTimeout: () => ({ cancel() {} }) });
  const transfers = new NodeBulkTransfers({ session, authoritySignal: connection.authoritySignal });
  const owners = new Map<string, { readonly identity: NodeOperationIdentity; readonly kind: NodeExecutionBody['kind']; readonly controlId: string | null }>();
  const stream = { ...session, streamId: 'synthetic-stream' };
  const events: AgentProducerEvent[] = [];
  const capabilities = {
    takeBody(body, identity, kind, controlId) {
      const owner = owners.get(body.transferId);
      if (!owner || owner.identity.operationId !== identity.operationId || owner.kind !== kind || owner.controlId !== controlId) throw new Error('Synthetic foreign body');
      owners.delete(body.transferId);
      return transfers.take(body, owner);
    },
    output(value) {
      if (value.streamId !== stream.streamId) throw new Error('Synthetic foreign output');
      return { signal: connection.authoritySignal, emit: (event) => { events.push(event); } };
    },
  } satisfies NodeExecutionWireCapabilities;
  const adapter = new NodeExecutionWireAdapter(table, supervisor, capabilities);
  let requestId = 0;
  const call = async (command: NodeExecutionCommand, physical: NodeConnectionLease = connection) => {
    const text = serializeNodeExecutionCall({ type: 'node-execution-request', version: NODE_WIRE_VERSION, session, requestId: ++requestId, command });
    const parsed = parseNodeExecutionCallText(text);
    if (!parsed) throw new Error('Synthetic request failed parsing');
    const result = await adapter.execute(physical, parsed.command, physical.signal);
    const reply = parseNodeExecutionReplyText(serializeNodeExecutionReply({ type: 'node-execution-result', version: NODE_WIRE_VERSION,
      session, requestId: parsed.requestId, result }));
    if (!reply) throw new Error('Synthetic reply failed parsing');
    return reply.result;
  };
  const body = (identity: NodeOperationIdentity, value: NodeExecutionBody, controlId: string | null = null) => {
    const bytes = serializeNodeExecutionBody(value);
    const owner = { identity, kind: value.kind, controlId };
    const transfer = transfers.reserve(owner, { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, connection.authoritySignal);
    transfers.append(transfer, 0, bytes); transfers.complete(transfer);
    owners.set(transfer.transferId, owner);
    return transfer;
  };
  const request = { kind: 'start' as const, chatId: '1789000000000001', runId: 'synthetic-run',
    configuration: { model: 'synthetic-model', settings: null, endpoint: null } };
  const prepare = async () => {
    const result = await call({ method: 'prepare', location, request });
    if (result.kind !== 'prepared') throw new Error('Synthetic preparation failed');
    return result.ticket;
  };
  const start = async () => {
    const ticket = await prepare();
    expect(await call({ method: 'dispatch', identity: ticket.identity, stream,
      body: body(ticket.identity, { kind: 'execution', input: { prompt: 'synthetic input', attachments: [], carriedContext: null } }) }))
      .toEqual({ kind: 'dispatched' });
    return ticket;
  };
  const dispose = async () => { table.close(); resources.close(); transfers.close(); await supervisor.shutdown(); };
  return { native, occupancy, containment, adapter, dispose, call, body, prepare, start, table, execution, steering, goals, supervisor, connection, session, stream, location, request, events, transfers, resources, service,
    async settleNative(index = native.settlements.length - 1) { native.settlements[index]!.resolve(); await new Promise(setImmediate); },
    advanceClock(ms: number) { elapsedMs += ms; } };
}
