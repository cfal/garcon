import { normalizeAgentSettings } from '@garcon/common/agent-settings';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentCatalogEntry, AgentModelOption } from '@garcon/common/agents';
import type { ApiProtocol } from '@garcon/common/api-providers';
import {
  isPermissionMode,
  isThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from '@garcon/common/chat-modes';
import {
  executionDefaultsForAgent,
  normalizeSupportedPermissionMode,
  normalizeSupportedThinkingMode,
} from '@garcon/common/execution-defaults';
import type { ModelCatalogResponse } from '@garcon/common/model-catalog';
import type { RemoteSettingsSnapshot } from '@garcon/common/settings';
import { CliError } from './errors.js';

export interface RequestedModelSelection {
  model: string;
  providerId?: string;
  endpointId?: string;
}

export interface ResolvedModelSelection {
  model: string;
  apiProviderId: string | null;
  modelEndpointId: string | null;
  modelProtocol: ApiProtocol | null;
}

export interface ResolvedStartSelection extends ResolvedModelSelection {
  permissionMode: PermissionMode;
  thinkingMode: ThinkingMode;
  agentSettings: AgentSettingsEnvelope;
}

function catalogError(message: string): CliError {
  return new CliError('catalog resolution', message, 2);
}

function normalizedAgent(catalog: ModelCatalogResponse, agentId: string): AgentCatalogEntry {
  const raw = catalog.catalog.agents.find((entry) => entry?.id === agentId);
  if (!raw) throw catalogError(`unknown agent: ${agentId}`);
  const defaultSettings = parseAgentSettingsEnvelope(raw.defaultSettings);
  if (
    !Array.isArray(raw.models)
    || !Array.isArray(raw.supportedPermissionModes)
    || !raw.supportedPermissionModes.every(isPermissionMode)
    || !Array.isArray(raw.supportedThinkingModes)
    || !raw.supportedThinkingModes.every(isThinkingMode)
    || typeof raw.requiresStrictModelDiscovery !== 'boolean'
    || !defaultSettings
    || defaultSettings.ownerId !== agentId
  ) {
    throw new CliError('catalog resolution', `catalog entry for ${agentId} is invalid`, 3);
  }
  return { ...raw, defaultSettings };
}

function normalizedModels(agent: AgentCatalogEntry): AgentModelOption[] {
  return agent.models.filter((model) => (
    model
    && typeof model.value === 'string'
    && model.value.length > 0
    && typeof model.label === 'string'
    && (model.apiProviderId === undefined || typeof model.apiProviderId === 'string')
    && (model.endpointId === undefined || typeof model.endpointId === 'string')
    && (model.rawModel === undefined || typeof model.rawModel === 'string')
    && (
      model.protocol === undefined
      || model.protocol === 'anthropic-messages'
      || model.protocol === 'openai-compatible'
    )
  ));
}

function assertProviderAndEndpoint(
  catalog: ModelCatalogResponse,
  agent: AgentCatalogEntry,
  requested: RequestedModelSelection,
): void {
  if (!requested.providerId) return;
  if (!agent.acceptsApiProviderEndpoints) {
    throw catalogError(`agent ${agent.id} does not accept API provider endpoints`);
  }
  const provider = catalog.catalog.apiProviders.find((entry) => entry?.id === requested.providerId);
  if (!provider || !Array.isArray(provider.endpoints)) {
    throw catalogError(`unknown API provider: ${requested.providerId}`);
  }
  if (!requested.endpointId) return;
  const endpoint = provider.endpoints.find((entry) => entry?.id === requested.endpointId);
  if (!endpoint) throw catalogError(`unknown endpoint ${requested.endpointId} in provider ${provider.id}`);
  if (!agent.supportedProtocols.includes(endpoint.protocol)) {
    throw catalogError(`endpoint ${requested.endpointId} is not compatible with agent ${agent.id}`);
  }
}

function matchingModels(
  models: readonly AgentModelOption[],
  requested: RequestedModelSelection,
): AgentModelOption[] {
  const routed = models.filter((model) => (
    (requested.providerId === undefined || model.apiProviderId === requested.providerId)
    && (requested.endpointId === undefined || model.endpointId === requested.endpointId)
  ));
  const exact = routed.filter((model) => model.value === requested.model);
  if (exact.length > 0) return exact;
  return routed.filter((model) => model.rawModel === requested.model);
}

function describeRouting(model: AgentModelOption): string {
  return [model.apiProviderId, model.endpointId].filter(Boolean).join('/') || 'native';
}

export function resolveModelSelection(
  catalog: ModelCatalogResponse,
  agentId: string,
  requested: RequestedModelSelection,
): ResolvedModelSelection {
  const agent = normalizedAgent(catalog, agentId);
  assertProviderAndEndpoint(catalog, agent, requested);
  const matches = matchingModels(normalizedModels(agent), requested);
  if (matches.length > 1) {
    const routes = matches.map(describeRouting).join(', ');
    throw catalogError(`model ${requested.model} is ambiguous across: ${routes}; specify --provider and --endpoint`);
  }
  const selected = matches[0];
  if (!selected) {
    if (requested.providerId || requested.endpointId || agent.requiresStrictModelDiscovery) {
      throw catalogError(`model ${requested.model} is not available for agent ${agentId}`);
    }
    return {
      model: requested.model,
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
    };
  }
  if ((selected.apiProviderId && !selected.endpointId) || (!selected.apiProviderId && selected.endpointId)) {
    throw new CliError('catalog resolution', `model routing for ${requested.model} is incomplete`, 3);
  }
  return {
    model: selected.rawModel ?? selected.value,
    apiProviderId: selected.apiProviderId ?? null,
    modelEndpointId: selected.endpointId ?? null,
    modelProtocol: selected.protocol ?? null,
  };
}

function strictPermissionMode(
  requested: PermissionMode | undefined,
  agent: AgentCatalogEntry,
  fallback: PermissionMode,
): PermissionMode {
  if (requested === undefined) return normalizeSupportedPermissionMode(fallback, agent.supportedPermissionModes);
  if (!agent.supportedPermissionModes.includes(requested)) {
    throw catalogError(`permission mode ${requested} is not supported by agent ${agent.id}`);
  }
  return requested;
}

function strictThinkingMode(
  requested: ThinkingMode | undefined,
  agent: AgentCatalogEntry,
  fallback: ThinkingMode,
): ThinkingMode {
  if (requested === undefined) return normalizeSupportedThinkingMode(fallback, agent.supportedThinkingModes);
  if (!agent.supportedThinkingModes.includes(requested)) {
    throw catalogError(`reasoning effort ${requested} is not supported by agent ${agent.id}`);
  }
  return requested;
}

export function validateExplicitModes(
  catalog: ModelCatalogResponse,
  agentId: string,
  requested: { permissionMode?: PermissionMode; thinkingMode?: ThinkingMode },
): void {
  const agent = normalizedAgent(catalog, agentId);
  if (requested.permissionMode !== undefined) {
    strictPermissionMode(requested.permissionMode, agent, 'default');
  }
  if (requested.thinkingMode !== undefined) {
    strictThinkingMode(requested.thinkingMode, agent, 'none');
  }
}

export function resolveStartSelection(
  catalog: ModelCatalogResponse,
  settings: RemoteSettingsSnapshot,
  requested: RequestedModelSelection & {
    agentId: string;
    permissionMode?: PermissionMode;
    thinkingMode?: ThinkingMode;
  },
): ResolvedStartSelection {
  const agent = normalizedAgent(catalog, requested.agentId);
  const executionDefaults = executionDefaultsForAgent(settings.executionDefaults, requested.agentId);
  const permissionMode = strictPermissionMode(
    requested.permissionMode,
    agent,
    executionDefaults.permissionMode,
  );
  if (
    requested.permissionMode === undefined
    && (permissionMode === 'manualBypass' || permissionMode === 'bypassPermissions')
  ) {
    throw catalogError(
      `configured permission mode ${permissionMode} requires explicit --permissions ${permissionMode}`,
    );
  }
  const thinkingMode = strictThinkingMode(
    requested.thinkingMode,
    agent,
    executionDefaults.thinkingMode,
  );
  const agentSettings = normalizeAgentSettings(
    requested.agentId,
    executionDefaults.agentSettingsById[requested.agentId],
    agent.defaultSettings,
  );
  return {
    ...resolveModelSelection(catalog, requested.agentId, requested),
    permissionMode,
    thinkingMode,
    agentSettings,
  };
}
