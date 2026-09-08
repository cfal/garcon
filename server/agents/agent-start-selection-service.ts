import type { PermissionMode } from '../../common/chat-modes.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import type { ModelCatalogResponse } from '../../common/model-catalog.js';
import type { RemoteExecutionDefaults } from '../../common/settings.js';
import { resolveStartSelection } from '../../common/start-selection.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { AgentRegistryServiceContract } from './registry.js';

export class AgentStartSelectionService {
  constructor(private readonly deps: {
    readonly agents: Pick<AgentRegistryServiceContract, 'getAgentCatalogEntry'>;
    readonly apiProviders: Pick<ApiProviderService, 'getCatalog'>;
  }) {}

  async catalog(agentId: string): Promise<ModelCatalogResponse> {
    // Strict loading preserves discovery failures instead of enabling unlisted models.
    const entry = await this.deps.agents.getAgentCatalogEntry(agentId, { strict: true });
    return { catalog: {
      agents: entry ? [entry] : [],
      apiProviders: this.deps.apiProviders.getCatalog(),
    } };
  }

  resolve(
    catalog: ModelCatalogResponse,
    command: GarconStartAgentCommand,
    executionDefaults: RemoteExecutionDefaults,
    permissionMode: PermissionMode,
  ) {
    return resolveStartSelection(catalog, { executionDefaults }, {
      agentId: command.agentId,
      model: command.model,
      permissionMode,
      ...(command.providerId === null ? {} : { providerId: command.providerId }),
      ...(command.reasoningEffort === null ? {} : { thinkingMode: command.reasoningEffort }),
    });
  }
}
