import type { AgentHistoryImport, AgentIntegration } from '@garcon/server-agent-interface';
import { NodeExecutionResources } from '../../execution-node/execution-resources.js';
import { LocalProviderHistoryImportService } from '../../execution-node/local-provider-history-import.js';
import { NodeNativeOccupancy } from '../../execution-node/native-occupancy.js';
import { NodeProviderCapacity } from '../../execution-node/provider-capacity.js';
import { NodeProviderHistoryImportHost } from '../../execution-node/provider-history-host.js';
import type { NodeWorkerServiceResult } from '../../execution-node/worker/service-protocol.js';
import { NodeDeadline } from '../deadline.js';
import { NodeHistoryOperationIssuer } from '../provider-history-operations.js';
import type { ProviderHistoryImportRequest } from '../provider-history-import.js';
import { RemoteProviderHistoryImportService, type RemoteProviderHistoryConnection } from '../remote-provider-history-import.js';
import type { NodeHistoryBulkFrame } from '../transport/provider-history-bulk-wire.js';
import { NodeHistoryMemoryBudget } from '../transport/provider-history-memory.js';
import { NodeHistoryBulkReceiver } from '../transport/provider-history-receiver.js';
import { NodeHistoryBulkSender } from '../transport/provider-history-sender.js';
import type { NodeHistoryFacet, NodeProviderHistoryCommand, NodeProviderHistoryReply } from '../transport/provider-history-wire.js';

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' };

export function historyFixture(load: AgentHistoryImport['load']) {
  const integration = {
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [] },
    settings: { defaults: () => ({ ownerId: 'synthetic', schemaVersion: 1, values: {} }), describe: () => [],
      migrate: async (input) => input, parse: (input) => input, applyPatch: (input) => input },
  } satisfies Pick<AgentIntegration, 'descriptor' | 'settings'>;
  const control = new AbortController(); const bulkLifetime = new AbortController();
  const physical = AbortSignal.any([control.signal, bulkLifetime.signal]);
  const instance = { nodeId: 'synthetic-node', instanceId: 'synthetic-instance' };
  const resources = new NodeExecutionResources(instance.nodeId);
  resources.register({ location: { ...instance, workspaceId: 'synthetic-workspace' }, projectPath: '/synthetic/node-project', execution: null,
    files: { inspectProject: async () => ({ kind: 'unavailable', reason: 'missing' }) } });
  const senderMemory = new NodeHistoryMemoryBudget(32 * 1024 * 1024);
  const receiverMemory = new NodeHistoryMemoryBudget(32 * 1024 * 1024);
  const limits = { maxTransfers: 2, maxBytes: 2 * 1024 * 1024, maxTransferBytes: 2 * 1024 * 1024 };
  const receiver = new NodeHistoryBulkReceiver(receiverMemory, { session, authoritySignal: control.signal, limits });
  const creditTimers = new Set<() => void>();
  let upstream = (frame: NodeHistoryBulkFrame) => { sender.receive(frame); return true; };
  let downstream = (frame: NodeHistoryBulkFrame) => receiver.receive(frame);
  const sender = new NodeHistoryBulkSender({
    send(frame) { downstream(frame); return true; },
    async sendWhenWritable(frame, signal, validate) { signal.throwIfAborted(); validate(); downstream(frame); },
  }, { session, signal: control.signal, memory: senderMemory, limits,
    scheduleTimeout(callback) { creditTimers.add(callback); return { cancel: () => creditTimers.delete(callback) }; } });
  const capacity = new NodeProviderCapacity(2, 1); const occupancy = new NodeNativeOccupancy(2);
  const source = new LocalProviderHistoryImportService(integration, { load });
  const host = new NodeProviderHistoryImportHost({ instance, session, agentId: 'synthetic', signal: control.signal,
    capacity, occupancy, memory: senderMemory, resources, facets: { native: source, legacy: null }, assertAdmission() {},
    capture(target) {
      if (target.connectionId !== 1 || target.bulkAttemptId !== '1') throw new Error('Synthetic wrong physical target');
      return { signal: physical, validate: () => physical.throwIfAborted(),
        transfer: (bytes, sequence, grant, descriptor, signal) => sender.transfer({ ...target, sequence, grant }, descriptor, bytes,
          signal, () => physical.throwIfAborted()) };
    },
  });
  const operations = new NodeHistoryOperationIssuer(session, [instance.instanceId]);
  const commands: NodeProviderHistoryCommand[] = [];
  const deadlines: number[] = [];
  let afterReply = async (_command: NodeProviderHistoryCommand, reply: NodeProviderHistoryReply): Promise<NodeWorkerServiceResult> => reply;
  const binding: RemoteProviderHistoryConnection = {
    nodeId: instance.nodeId, session, connectionId: 1, bulkAttemptId: '1', signal: physical, controlSignal: control.signal,
    receiver, operations, bulk: { send: (frame) => upstream(frame), async sendWhenWritable(frame) { upstream(frame); } },
    validate: () => physical.throwIfAborted(), validateControl: () => control.signal.throwIfAborted(),
    service: { async call(command, signal, deadline) {
      if (command.method !== 'provider-history-import') throw new Error('Synthetic unexpected command');
      commands.push(command); deadlines.push(deadline?.remainingMs ?? 0);
      return afterReply(command, await host.execute(command, signal, deadline ?? new NodeDeadline(60_000)));
    } },
  };
  const request: ProviderHistoryImportRequest = { chat: { chatId: '1000000000000001', agentId: 'synthetic', agentSessionId: 'synthetic-native',
    projectPath: '/synthetic/controller-label', model: 'synthetic-model', nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { key: 'original' } },
    carryOverRevision: '', nativeSeedReceipt: null, settings: { ownerId: 'synthetic', schemaVersion: 1, values: { key: 'original' } } } };
  const importer = (facet: NodeHistoryFacet = 'native') => new RemoteProviderHistoryImportService(instance, facet,
    () => ({ nodeId: instance.nodeId, workspaceId: 'synthetic-workspace' }), () => binding);
  return { importer, request, binding, control, bulkLifetime, capacity, occupancy, receiver, host, sender, creditTimers, commands, deadlines,
    senderMemory, receiverMemory, afterReply(callback: typeof afterReply) { afterReply = callback; },
    upstream(callback: typeof upstream) { upstream = callback; }, downstream(callback: typeof downstream) { downstream = callback; },
    async close() { operations.close(); control.abort(); host.close(); receiver.close(); sender.close(); await tick(); },
  };
}
