import { NodeProviderNativeHost } from '../provider-native-host.js';
import { LocalProviderNativeSessionService } from '../local-provider-native-sessions.js';
import { NodeNativeTasks } from '../native-tasks.js';
import { NodeProviderAuxiliaryHost } from '../provider-auxiliary-host.js';
import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { NodeNativeOccupancy } from '../native-occupancy.js';
import { NodeWorkerContainmentRelay } from './containment-relay.js';
import { loadAgentIntegration } from '../../agents/default-agent-integrations.js';
import { NodeProviderCapacity } from '../provider-capacity.js';
import { IntegrationHostFactory } from '../../agents/integration-host.js';
import { FileAgentMigrationStore } from '../../agents/integration-migration-store.js';
import { IntegrationRegistry } from '../../agents/integration-registry.js';
import { createNodeProviderManifest } from '../../execution-nodes/provider-manifest.js';
import type { NodeWorkerRuntime, NodeWorkerRuntimeContext } from './bootstrap.js';
import { prepareNodeInstanceEnvironments } from './environment.js';
import { NODE_WORKER_BUN_OPTIONS, prepareNodeInstanceStorage } from './launch.js';
import { promises as fs } from 'node:fs';
import { inspectProjectDirectory } from '../../projects/project-directory-service.js';
import { NodeExecutionHost } from '../execution-host.js';
import { NodeExecutionResources } from '../execution-resources.js';
import { LocalProviderConfigurationService } from '../local-provider-configuration.js';
import { NodeProviderConfigurationHost } from '../provider-configuration-host.js';
import { NodeSessionConfigurationHost } from '../provider-session-configuration-host.js';
import { LocalProviderCatalogService } from '../local-provider-catalog.js';
import { NodeProviderCatalogHost } from '../provider-catalog-host.js';
import { LocalProviderAuthService } from '../local-provider-auth.js';
import { NodeProviderAuthHost } from '../provider-auth-host.js';
import { LocalProviderCommandsService } from '../local-provider-commands.js';
import { NodeProviderCommandsHost } from '../provider-commands-host.js';
import { LocalProviderExecutionService } from '../local-provider-execution.js';
import { NodeOperationTable, type NodeOperationLimits, type NodeOperationTableOptions } from '../operation-table.js';
import type { ProviderRetainedExecutionService } from '../../execution-nodes/provider-execution.js';
import type { NodeInstanceConfiguration } from './configuration.js';
import { NodeWorkerExecutionRouter } from './execution-router.js';
import { NodeWorkerInstanceServices } from './instance-services.js';
import { NodeWorkerServiceRouter } from './service-router.js';
import { NodeWorkerTransportError } from './framing.js';
import type { NodeWorkerWriter } from './writer.js';
import { NodeHistoryMemoryBudget } from '../../execution-nodes/transport/provider-history-memory.js';
import { NodeHistoryBulkSender } from '../../execution-nodes/transport/provider-history-sender.js';
import { NodeWorkerHistoryBulkPort } from './history-bulk-port.js';
import { NodeProviderHistoryImportHost } from '../provider-history-host.js';
import { LocalProviderHistoryImportService } from '../local-provider-history-import.js';

interface NodeInstanceExecutionBinding {
  readonly occupancy: NodeOperationTableOptions['occupancy'];
  readonly limits: Partial<NodeOperationLimits>;
  bind(service: LocalProviderExecutionService): ProviderRetainedExecutionService | null;
}

export function startNodeInstanceRuntime(context: NodeWorkerRuntimeContext, writer: Pick<NodeWorkerWriter, 'submit'>): Promise<NodeWorkerRuntime> {
  return createNodeInstanceRuntime(context, writer, (instance, occupancy) => ({
    occupancy,
    limits: { maxOperations: instance.maxOperations },
    bind: (service) => service.retained,
  }));
}

export async function createNodeInstanceRuntime(
  context: NodeWorkerRuntimeContext,
  writer: Pick<NodeWorkerWriter, 'submit'>,
  executionBinding: (instance: NodeInstanceConfiguration, occupancy: NodeNativeOccupancy) => NodeInstanceExecutionBinding,
): Promise<NodeWorkerRuntime> {
  const { configuration, authority } = context;
  if (configuration.role !== 'instance') throw new TypeError('Invalid instance worker role');
  const validate = () => { authority.poll(); authority.signal.throwIfAborted(); };
  validate();
  const instance = configuration.instance;
  const prepared = (await prepareNodeInstanceEnvironments([instance], authority.signal, configuration.executableSearchPath)).get(instance.id)!;
  const environment: Readonly<Record<string, string>> = { ...prepared.values, BUN_OPTIONS: NODE_WORKER_BUN_OPTIONS };
  if (Object.keys(process.env).length !== Object.keys(environment).length
    || Object.entries(environment).some(([key, value]) => process.env[key] !== value)) throw new Error('Worker environment differs from its configured instance');
  const storageDirectory = await prepareNodeInstanceStorage(configuration.storageDirectory, instance.id);
  validate();
  const integration = await loadAgentIntegration(instance.agentId);
  validate();
  const hosts = new IntegrationHostFactory({ workspaceDir: configuration.storageDirectory, instance,
    readEnvironment: (key) => environment[key] });
  const registry = new IntegrationRegistry({ integrations: [integration], hostFactory: hosts,
    migrationStoreFor: () => new FileAgentMigrationStore(storageDirectory) });
  const resources = new NodeExecutionResources(configuration.nodeId);
  const occupancy = new NodeNativeOccupancy(instance.maxOperations);
  const binding = executionBinding(instance, occupancy);
  const nativeTasks = new NodeNativeTasks({ occupancy, signal: authority.signal });
  const containment = new NodeWorkerContainmentRelay(authority, writer);
  let table: NodeOperationTable;
  let host: NodeExecutionHost;
  let services: NodeWorkerInstanceServices;
  let requests: NodeWorkerServiceRouter;
  let execution: NodeWorkerExecutionRouter;
  let closing: Promise<void> | null = null;
  const close = () => {
    occupancy.close(); nativeTasks.close();
    execution?.close(); requests?.close(); services?.close(); host?.close(); table?.close(); resources.close();
    return closing ??= registry.stop();
  };
  try {
    table = new NodeOperationTable({ connection: context.connection, supervisor: authority, resources, occupancy: binding.occupancy,
      requestContainment: (identity, location) => containment.request({ type: 'node-worker-containment-request', version: NODE_WIRE_VERSION,
        session: authority.session, instanceId: location.instanceId, operationId: identity.operationId, reason: 'native-settlement-unconfirmed' }),
      limits: binding.limits });
    host = new NodeExecutionHost(context.connection, authority, table);
    await registry.start();
    validate();
    const provider = registry.require(instance.agentId);
    const providerCapacity = new NodeProviderCapacity();
    const configurationService = new LocalProviderConfigurationService(provider);
    const historyMemory = new NodeHistoryMemoryBudget(configuration.historyTransportMemoryBytes);
    const historySender = new NodeHistoryBulkSender(new NodeWorkerHistoryBulkPort(writer, { session: authority.session,
      instanceId: instance.id, signal: authority.signal, capture: (connectionId, bulkAttemptId) => services.captureBulk(connectionId, bulkAttemptId) }),
      { session: authority.session, signal: authority.signal, memory: historyMemory });
    const historyHost = new NodeProviderHistoryImportHost({ instance: { nodeId: configuration.nodeId, instanceId: instance.id },
      agentId: instance.agentId, session: authority.session, signal: authority.signal, capacity: providerCapacity, occupancy, resources, memory: historyMemory,
      facets: { native: provider.nativeHistoryImport ? new LocalProviderHistoryImportService(provider, provider.nativeHistoryImport) : null,
        legacy: provider.legacyHistoryImport ? new LocalProviderHistoryImportService(provider, provider.legacyHistoryImport) : null },
      assertAdmission: (target) => authority.assertAdmission(authority.connection(target.connectionId)),
      capture(target) {
        const attempt = services.captureBulk(target.connectionId, target.bulkAttemptId);
        return { signal: attempt.signal, validate: () => attempt.validate(),
          transfer: (bytes, sequence, grant, descriptor, signal) => historySender.transfer({ ...target, sequence, grant }, descriptor, bytes,
            signal, () => attempt.validate()) };
      } });
    services = new NodeWorkerInstanceServices({ authority, instanceId: instance.id, host, writer,
      history: { host: historyHost, sender: historySender },
      nativeSessions: new NodeProviderNativeHost(providerCapacity, { nodeId: configuration.nodeId, instanceId: instance.id },
        instance.agentId, resources, new LocalProviderNativeSessionService(provider), occupancy),
      auxiliary: new NodeProviderAuxiliaryHost({ instance: { nodeId: configuration.nodeId, instanceId: instance.id },
        provider, resources, capacity: providerCapacity, configuration: configurationService, native: nativeTasks,
        requestContainment: (identity) => containment.request({ type: 'node-worker-containment-request', version: NODE_WIRE_VERSION,
          session: authority.session, instanceId: instance.id, operationId: identity.operationId, reason: 'native-settlement-unconfirmed' }) }),
      sessionConfiguration: new NodeSessionConfigurationHost({ instanceId: instance.id, connection: context.connection, supervisor: authority,
        capacity: providerCapacity, configuration: configurationService, resources, execution: host }),
      configuration: new NodeProviderConfigurationHost(providerCapacity, instance.id, configurationService),
      catalog: new NodeProviderCatalogHost(providerCapacity, instance.id, new LocalProviderCatalogService(provider)),
      commands: new NodeProviderCommandsHost(providerCapacity, { nodeId: configuration.nodeId, instanceId: instance.id }, resources,
        new LocalProviderCommandsService(provider, (projectPath) => inspectProjectDirectory(projectPath, { resolvePath: fs.realpath }))),
      auth: new NodeProviderAuthHost(providerCapacity, instance.id, new LocalProviderAuthService(provider)) });
    requests = new NodeWorkerServiceRouter(context.connectionId, { authority, writer,
      execute: (_connectionId, connection, command, signal, deadline) => services.service(connection, command, signal, deadline) });
    execution = new NodeWorkerExecutionRouter(context.connectionId, { authority, writer,
      instanceIds: new Set([instance.id]), execute: (_instance, _connectionId, connection, command, signal) => services.execution(connection, command, signal) });
    const service = new LocalProviderExecutionService(provider, configurationService);
    const retained = binding.bind(service);
    for (const workspace of configuration.workspaces.filter((workspace) => instance.workspaceIds.includes(workspace.id))) resources.register({
      location: { nodeId: configuration.nodeId, instanceId: instance.id, workspaceId: workspace.id }, projectPath: workspace.projectPath, execution: retained,
      files: { async inspectProject(projectPath, signal) {
        signal.throwIfAborted();
        const result = await inspectProjectDirectory(projectPath, { resolvePath: fs.realpath });
        signal.throwIfAborted();
        return result;
      } },
    });
    const manifest = createNodeProviderManifest(configuration.nodeId, instance.id, provider, new Set(['catalog', 'auth', 'commands', 'nativeSessions']), instance.maxOperations);
    return { manifests: Object.freeze([manifest]), close,
      application(frame, text) {
        validate();
        switch (frame.type) {
          case 'node-worker-execution': execution.receive(frame); return;
          case 'node-worker-service-request': case 'node-worker-service-cancel': requests.receive(frame); return;
          case 'node-worker-bulk': services.bulk(frame); return;
          case 'node-history-bulk': services.history(frame); return;
          case 'node-worker-output-retired': services.receiveRetirement(text); return;
          default: throw new NodeWorkerTransportError('NODE_WORKER_PROTOCOL');
        }
      },
      async control(message) {
        validate();
        if (message.type === 'node-worker-attach') { execution.attach(message.connectionId); requests.attach(message.connectionId); }
        if (message.type === 'node-worker-bulk-attached' || message.type === 'node-worker-bulk-retired') services.bulkLifetime(message);
      } };
  } catch (error) {
    await close();
    throw error;
  }
}
