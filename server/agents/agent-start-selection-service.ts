import { normalizeAgentSettings } from '../../common/agent-settings.js';
import type { GarconStartAgentCommand } from '../../common/garcon-start-agent.js';
import type { ModelCatalogResponse } from '../../common/model-catalog.js';
import type { RemoteExecutionDefaults } from '../../common/settings.js';
import { requireCatalogAgent, resolveStartSelection, StartSelectionError } from '../../common/start-selection.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { ChatRegistryEntry } from '../chats/store.js';
import type { AgentRegistryServiceContract } from './registry.js';

type ParentSelection = Pick<ChatRegistryEntry,
  'agentId' | 'model' | 'apiProviderId' | 'modelEndpointId' | 'modelProtocol'
  | 'permissionMode' | 'thinkingMode' | 'agentSettingsById'>;

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
    parent: ParentSelection,
  ) {
    const agentId = command.agentId ?? parent.agentId;
    const inheritAgent = command.agentId === null;
    const inheritRoute = inheritAgent && command.providerId === null;
    const inheritedProvider = parent.apiProviderId ?? null;
    const inheritedEndpoint = parent.modelEndpointId ?? null;
    const inheritedProtocol = parent.modelProtocol ?? null;
    if (inheritRoute) {
      const native = inheritedProvider === null && inheritedEndpoint === null && inheritedProtocol === null;
      const routed = inheritedProvider !== null && inheritedEndpoint !== null && inheritedProtocol !== null;
      if (!native && !routed) {
        throw new StartSelectionError('INCOMPATIBLE_ENDPOINT', 'parent model routing is incomplete');
      }
      if (inheritedProvider !== null && !catalog.catalog.apiProviders.some((entry) => entry.id === inheritedProvider)) {
        throw new StartSelectionError('UNKNOWN_PROVIDER', 'parent API provider is no longer available');
      }
    }
    const thinkingMode = command.reasoningEffort ?? (inheritAgent ? parent.thinkingMode : undefined);
    const selection = resolveStartSelection(catalog, { executionDefaults }, {
      agentId,
      model: command.model ?? parent.model,
      permissionMode: parent.permissionMode,
      providerId: inheritRoute ? inheritedProvider : command.providerId,
      ...(inheritRoute && inheritedEndpoint !== null ? { endpointId: inheritedEndpoint } : {}),
      ...(thinkingMode === undefined ? {} : { thinkingMode }),
    });
    if (inheritRoute && (
      selection.apiProviderId !== inheritedProvider
      || selection.modelEndpointId !== inheritedEndpoint
      || selection.modelProtocol !== inheritedProtocol
      || (command.model === null && selection.model !== parent.model)
    )) {
      throw new StartSelectionError('INCOMPATIBLE_ENDPOINT', 'parent model routing is no longer available');
    }
    return {
      ...selection,
      agentId,
      agentSettings: inheritAgent ? normalizeAgentSettings(
        agentId, parent.agentSettingsById[agentId], requireCatalogAgent(catalog, agentId).defaultSettings,
      ) : selection.agentSettings,
    };
  }
}
