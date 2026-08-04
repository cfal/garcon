import type { AgentCatalogEntry, AgentModelOption } from '@garcon/common/agents';
import type {
  ApiProviderCatalogEntry,
  ApiProviderEndpointCatalogEntry,
  ApiProtocol,
} from '@garcon/common/api-providers';
import {
  executionDefaultsForAgent,
  normalizeSupportedPermissionMode,
  normalizeSupportedThinkingMode,
} from '@garcon/common/execution-defaults';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import type { ListCliCommand } from './args.js';
import {
  formatCatalogQueryResult,
  type CatalogQueryResult,
} from './catalog-output.js';
import {
  requireCatalogAgent,
  requireCatalogModels,
  resolveCatalogModelSelection,
} from './catalog-selection.js';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';

export interface CatalogQueryClient {
  getModelCatalog(agentId?: string, signal?: AbortSignal): Promise<ModelCatalogResponse>;
  getSettings(signal?: AbortSignal): Promise<RemoteSettingsSnapshot>;
}

type QueryResult<Resource extends CatalogQueryResult['resource']> = Extract<
  CatalogQueryResult,
  { resource: Resource }
>;

function catalogError(message: string): CliError {
  return new CliError('catalog resolution', message, 2);
}

function requireQueryAgent(
  agent: AgentCatalogEntry | undefined,
  resource: string,
): AgentCatalogEntry {
  if (!agent) throw catalogError(`list ${resource} requires --agent`);
  return agent;
}

function requireSettings(settings: RemoteSettingsSnapshot | null): RemoteSettingsSnapshot {
  if (!settings) throw new CliError('catalog resolution', 'settings were not loaded', 3);
  return settings;
}

function protocol(value: unknown): value is ApiProtocol {
  return value === 'anthropic-messages' || value === 'openai-compatible';
}

function catalogProviders(catalog: ModelCatalogResponse): ApiProviderCatalogEntry[] {
  const valid = catalog.catalog.apiProviders.every((provider) => (
    provider
    && typeof provider.id === 'string'
    && provider.id.length > 0
    && typeof provider.label === 'string'
    && Array.isArray(provider.endpoints)
    && provider.endpoints.every((endpoint) => (
      endpoint
      && typeof endpoint.id === 'string'
      && endpoint.id.length > 0
      && protocol(endpoint.protocol)
      && typeof endpoint.defaultModel === 'string'
      && typeof endpoint.supportsImages === 'boolean'
      && typeof endpoint.hasApiKey === 'boolean'
    ))
  ));
  if (!valid) throw new CliError('catalog resolution', 'API provider catalog is invalid', 3);
  return catalog.catalog.apiProviders;
}

function available(label: string, values: readonly string[]): string {
  return `${label}: ${values.length > 0 ? values.join(', ') : 'none'}`;
}

function requireProvider(
  providers: readonly ApiProviderCatalogEntry[],
  providerId: string,
): ApiProviderCatalogEntry {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw catalogError(
      `unknown API provider: ${providerId}; ${available('available providers', providers.map((entry) => entry.id))}`,
    );
  }
  return provider;
}

function requireEndpoint(
  provider: ApiProviderCatalogEntry,
  endpointId: string,
): ApiProviderEndpointCatalogEntry {
  const endpoint = provider.endpoints.find((entry) => entry.id === endpointId);
  if (!endpoint) {
    throw catalogError(
      `unknown endpoint ${endpointId} in provider ${provider.id}; ${available(
        'available endpoints',
        provider.endpoints.map((entry) => entry.id),
      )}`,
    );
  }
  return endpoint;
}

function compatibleEndpoints(
  provider: ApiProviderCatalogEntry,
  agent: AgentCatalogEntry | undefined,
): ApiProviderEndpointCatalogEntry[] {
  if (!agent) return provider.endpoints;
  if (!agent.acceptsApiProviderEndpoints) return [];
  return provider.endpoints.filter((endpoint) => agent.supportedProtocols.includes(endpoint.protocol));
}

function requireCompatibleEndpoints(
  provider: ApiProviderCatalogEntry,
  agent: AgentCatalogEntry,
  endpoints: ApiProviderEndpointCatalogEntry[],
): void {
  if (endpoints.length === 0) {
    throw catalogError(`provider ${provider.id} has no endpoints compatible with agent ${agent.id}`);
  }
}

function agentListing(catalog: ModelCatalogResponse): QueryResult<'agents'> {
  const agents = catalog.catalog.agents.map((entry) => requireCatalogAgent(catalog, entry.id));
  return {
    resource: 'agents',
    agents: agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      description: agent.description ?? null,
      defaultModel: agent.defaultModel,
      acceptsApiProviders: agent.acceptsApiProviderEndpoints,
      supportedProtocols: agent.supportedProtocols,
      permissions: agent.supportedPermissionModes,
      reasoningEfforts: agent.supportedThinkingModes,
    })),
  };
}

function providerListing(
  catalog: ModelCatalogResponse,
  command: ListCliCommand,
  agent: AgentCatalogEntry | undefined,
): QueryResult<'providers'> {
  const allProviders = catalogProviders(catalog);
  const providers = command.providerId === undefined
    ? allProviders
    : [requireProvider(allProviders, command.providerId)];
  const listed = providers.flatMap((provider) => {
    const endpoints = compatibleEndpoints(provider, agent);
    if (command.providerId !== undefined && agent) {
      requireCompatibleEndpoints(provider, agent, endpoints);
    }
    return endpoints.length === 0 && agent
      ? []
      : [{
          id: provider.id,
          label: provider.label,
          endpoints: endpoints.map((endpoint) => endpoint.id),
        }];
  });
  return {
    resource: 'providers',
    agentId: agent?.id ?? null,
    providers: listed,
  };
}

function endpointListing(
  catalog: ModelCatalogResponse,
  command: ListCliCommand,
  agent: AgentCatalogEntry | undefined,
): QueryResult<'endpoints'> {
  if (!command.providerId) throw catalogError('list endpoints requires --provider');
  const provider = requireProvider(catalogProviders(catalog), command.providerId);
  const compatible = compatibleEndpoints(provider, agent);
  if (agent) requireCompatibleEndpoints(provider, agent, compatible);
  let endpoints = compatible;
  if (command.endpointId !== undefined) {
    const endpoint = requireEndpoint(provider, command.endpointId);
    if (agent && !compatible.includes(endpoint)) {
      throw catalogError(`endpoint ${endpoint.id} is not compatible with agent ${agent.id}`);
    }
    endpoints = [endpoint];
  }
  const listed = endpoints.map((endpoint) => ({
    providerId: provider.id,
    id: endpoint.id,
    protocol: endpoint.protocol,
    defaultModel: endpoint.defaultModel,
    supportsImages: endpoint.supportsImages,
    hasApiKey: endpoint.hasApiKey,
  }));
  return {
    resource: 'endpoints',
    agentId: agent?.id ?? null,
    endpoints: listed,
  };
}

function modelListing(
  catalog: ModelCatalogResponse,
  command: ListCliCommand,
  agent: AgentCatalogEntry,
): QueryResult<'models'> {
  if (command.providerId !== undefined) {
    if (!agent.acceptsApiProviderEndpoints) {
      throw catalogError(`agent ${agent.id} does not accept API provider endpoints`);
    }
    const provider = requireProvider(catalogProviders(catalog), command.providerId);
    if (command.endpointId !== undefined) {
      const endpoint = requireEndpoint(provider, command.endpointId);
      if (!agent.supportedProtocols.includes(endpoint.protocol)) {
        throw catalogError(`endpoint ${endpoint.id} is not compatible with agent ${agent.id}`);
      }
    }
  }
  const models = requireCatalogModels(agent).filter((model) => (
    (command.providerId === undefined || model.apiProviderId === command.providerId)
    && (command.endpointId === undefined || model.endpointId === command.endpointId)
  ));
  const listed = models.map((model) => modelDetails(catalog, agent, model));
  return {
    resource: 'models',
    agentId: agent.id,
    defaultModel: agent.defaultModel,
    models: listed,
  };
}

function modelDetails(
  catalog: ModelCatalogResponse,
  agent: AgentCatalogEntry,
  model: AgentModelOption,
): {
  value: string;
  label: string;
  rawModel: string;
  providerId: string | null;
  endpointId: string | null;
  protocol: ApiProtocol | null;
  isDefault: boolean;
  supportsImages: boolean;
  isLocal: boolean;
} {
  const selection = resolveCatalogModelSelection(catalog, agent, model);
  return {
    value: model.value,
    label: model.label,
    rawModel: selection.model,
    providerId: selection.apiProviderId,
    endpointId: selection.modelEndpointId,
    protocol: selection.modelProtocol,
    isDefault: model.value === agent.defaultModel,
    supportsImages: model.supportsImages ?? agent.supportsImages,
    isLocal: model.isLocal ?? false,
  };
}

function permissionListing(
  agent: AgentCatalogEntry,
  settings: RemoteSettingsSnapshot,
): QueryResult<'permissions'> {
  const defaults = executionDefaultsForAgent(settings.executionDefaults, agent.id);
  const defaultPermission = normalizeSupportedPermissionMode(
    defaults.permissionMode,
    agent.supportedPermissionModes,
  );
  return {
    resource: 'permissions',
    agentId: agent.id,
    defaultPermission,
    permissions: agent.supportedPermissionModes,
  };
}

function reasoningEffortListing(
  agent: AgentCatalogEntry,
  settings: RemoteSettingsSnapshot,
): QueryResult<'reasoning-efforts'> {
  const defaults = executionDefaultsForAgent(settings.executionDefaults, agent.id);
  const defaultReasoningEffort = normalizeSupportedThinkingMode(
    defaults.thinkingMode,
    agent.supportedThinkingModes,
  );
  return {
    resource: 'reasoning-efforts',
    agentId: agent.id,
    defaultReasoningEffort,
    reasoningEfforts: agent.supportedThinkingModes,
  };
}

export async function runCatalogQuery(
  command: ListCliCommand,
  client: CatalogQueryClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const needsSettings = command.resource === 'permissions'
    || command.resource === 'reasoning-efforts';
  const [catalog, settings] = await Promise.all([
    client.getModelCatalog(command.resource === 'models' ? command.agentId : undefined, signal),
    needsSettings ? client.getSettings(signal) : Promise.resolve(null),
  ]);
  const agent = command.agentId === undefined
    ? undefined
    : requireCatalogAgent(catalog, command.agentId);

  let result: CatalogQueryResult;
  switch (command.resource) {
    case 'agents':
      result = agentListing(catalog);
      break;
    case 'providers':
      result = providerListing(catalog, command, agent);
      break;
    case 'endpoints':
      result = endpointListing(catalog, command, agent);
      break;
    case 'models':
      result = modelListing(catalog, command, requireQueryAgent(agent, command.resource));
      break;
    case 'permissions':
      result = permissionListing(
        requireQueryAgent(agent, command.resource),
        requireSettings(settings),
      );
      break;
    case 'reasoning-efforts':
      result = reasoningEffortListing(
        requireQueryAgent(agent, command.resource),
        requireSettings(settings),
      );
      break;
  }
  output.listing(formatCatalogQueryResult(result, command.json));
}
