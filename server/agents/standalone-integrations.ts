import type { AgentIntegrationClass } from '@garcon/server-agent-interface';
import { ExecutionNodesStore } from '../execution-nodes/store.js';
import { IntegrationHostFactory } from './integration-host.js';
import { IntegrationRegistry } from './integration-registry.js';
import { FileAgentMigrationStore } from './integration-migration-store.js';

/** Resolves persisted default-instance ownership before constructing local runtimes. */
export async function prepareStandaloneIntegrations(workspaceDir: string, integrations: readonly AgentIntegrationClass[]) {
  const executionNodes = new ExecutionNodesStore(workspaceDir);
  await executionNodes.init();
  const defaults = await executionNodes.ensureLocalDefaults(integrations.map((integration) => integration.integrationId));
  const localInstances = defaults.filter((instance) => (
    instance.removedAt === null && instance.storageNamespace === instance.agentId
  ));
  const hostFactory = new IntegrationHostFactory({ workspaceDir });
  const integrationRegistry = new IntegrationRegistry({
    integrations,
    executableAgentIds: localInstances.map((instance) => instance.agentId),
    hostFactory,
    migrationStoreFor: (agentId) => new FileAgentMigrationStore(hostFactory.forAgent(agentId).storage.rootDirectory),
  });
  return { executionNodes, localInstances, integrationRegistry };
}
