import { normalizeAgentSettings } from './agent-settings.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from './agent-integration.js';
import type { AgentCatalogEntry, AgentModelOption } from './agents.js';
import type { ApiProtocol } from './api-providers.js';
import {
  isPermissionMode,
  isThinkingMode,
  type PermissionMode,
  type ThinkingMode,
} from './chat-modes.js';
import {
  executionDefaultsForAgent,
  isThinkingModeSupported,
  normalizeSupportedPermissionMode,
  normalizeSupportedThinkingMode,
} from './execution-defaults.js';
import type { ModelCatalogResponse } from './model-catalog.js';
import type { RemoteSettingsSnapshot } from './settings.js';

export type StartSelectionErrorCode =
  | 'UNKNOWN_AGENT'
  | 'INVALID_CATALOG'
  | 'PROVIDER_NOT_SUPPORTED'
  | 'UNKNOWN_PROVIDER'
  | 'UNKNOWN_ENDPOINT'
  | 'INCOMPATIBLE_ENDPOINT'
  | 'AMBIGUOUS_MODEL'
  | 'UNKNOWN_MODEL'
  | 'UNSUPPORTED_PERMISSION_MODE'
  | 'UNSUPPORTED_REASONING_EFFORT'
  | 'PERMISSION_OVERRIDE_REQUIRED';

export class StartSelectionError extends Error {
  constructor(
    readonly code: StartSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StartSelectionError';
  }
}

export interface RequestedModelSelection {
  readonly model: string;
  readonly providerId?: string;
  readonly endpointId?: string;
}

export interface RequestedStartSelection extends RequestedModelSelection {
  readonly agentId: string;
  readonly permissionMode?: PermissionMode;
  readonly thinkingMode?: string;
}

export interface ResolvedModelSelection {
  readonly model: string;
  readonly apiProviderId: string | null;
  readonly modelEndpointId: string | null;
  readonly modelProtocol: ApiProtocol | null;
}

export interface ResolvedStartSelection extends ResolvedModelSelection {
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
  readonly agentSettings: AgentSettingsEnvelope;
}

function fail(code: StartSelectionErrorCode, message: string): never {
  throw new StartSelectionError(code, message);
}

function availableValues(label: string, values: readonly string[]): string {
  return `${label}: ${values.length > 0 ? values.join(', ') : 'none'}`;
}

function isApiProtocol(value: unknown): value is ApiProtocol {
  return value === 'anthropic-messages' || value === 'openai-compatible';
}

export function requireCatalogAgent(
  catalog: ModelCatalogResponse,
  agentId: string,
): AgentCatalogEntry {
  const raw = catalog.catalog.agents.find((entry) => entry?.id === agentId);
  if (!raw) {
    fail(
      'UNKNOWN_AGENT',
      `unknown agent: ${agentId}; ${availableValues('available agents', catalog.catalog.agents.map((entry) => entry.id))}`,
    );
  }
  const defaultSettings = parseAgentSettingsEnvelope(raw.defaultSettings);
  if (
    !Array.isArray(raw.models)
    || !Array.isArray(raw.supportedPermissionModes)
    || !raw.supportedPermissionModes.every(isPermissionMode)
    || !Array.isArray(raw.supportedThinkingModes)
    || !raw.supportedThinkingModes.every(isThinkingMode)
    || !Array.isArray(raw.supportedProtocols)
    || !raw.supportedProtocols.every(isApiProtocol)
    || typeof raw.defaultModel !== 'string'
    || typeof raw.acceptsApiProviderEndpoints !== 'boolean'
    || typeof raw.requiresStrictModelDiscovery !== 'boolean'
    || !defaultSettings
    || defaultSettings.ownerId !== agentId
  ) {
    fail('INVALID_CATALOG', `catalog entry for ${agentId} is invalid`);
  }
  return { ...raw, defaultSettings };
}

export function requireCatalogModels(agent: AgentCatalogEntry): AgentModelOption[] {
  const valid = agent.models.every((model) => (
    model
    && typeof model.value === 'string'
    && model.value.length > 0
    && typeof model.label === 'string'
    && (model.apiProviderId === undefined || typeof model.apiProviderId === 'string')
    && (model.endpointId === undefined || typeof model.endpointId === 'string')
    && (model.rawModel === undefined || typeof model.rawModel === 'string')
    && (model.protocol === undefined || isApiProtocol(model.protocol))
  ));
  if (!valid) {
    fail('INVALID_CATALOG', `model catalog for ${agent.id} is invalid`);
  }
  return agent.models;
}

export function resolveCatalogModelSelection(
  catalog: ModelCatalogResponse,
  agent: AgentCatalogEntry,
  model: AgentModelOption,
): ResolvedModelSelection {
  if (!model.apiProviderId) {
    if (model.endpointId || model.protocol) {
      fail('INVALID_CATALOG', `model routing for ${model.value} is incomplete`);
    }
    return {
      model: model.rawModel ?? model.value,
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
    };
  }
  if (!model.endpointId || !model.protocol) {
    fail('INVALID_CATALOG', `model routing for ${model.value} is incomplete`);
  }
  const provider = catalog.catalog.apiProviders.find((entry) => entry?.id === model.apiProviderId);
  if (!provider || !Array.isArray(provider.endpoints)) {
    fail('INVALID_CATALOG', `model routing for ${model.value} is invalid`);
  }
  const endpoint = provider.endpoints.find((entry) => entry?.id === model.endpointId);
  if (!endpoint) {
    fail('INVALID_CATALOG', `model routing for ${model.value} is invalid`);
  }
  if (
    !isApiProtocol(endpoint.protocol)
    || endpoint.protocol !== model.protocol
    || !agent.supportedProtocols.includes(model.protocol)
  ) {
    fail('INVALID_CATALOG', `model routing for ${model.value} is incompatible`);
  }
  return {
    model: model.rawModel ?? model.value,
    apiProviderId: model.apiProviderId,
    modelEndpointId: model.endpointId,
    modelProtocol: model.protocol,
  };
}

function assertProviderAndEndpoint(
  catalog: ModelCatalogResponse,
  agent: AgentCatalogEntry,
  requested: RequestedModelSelection,
): void {
  if (!requested.providerId) return;
  if (!agent.acceptsApiProviderEndpoints) {
    fail('PROVIDER_NOT_SUPPORTED', `agent ${agent.id} does not accept API provider endpoints`);
  }
  const provider = catalog.catalog.apiProviders.find((entry) => entry?.id === requested.providerId);
  if (!provider || !Array.isArray(provider.endpoints)) {
    fail(
      'UNKNOWN_PROVIDER',
      `unknown API provider: ${requested.providerId}; ${availableValues(
        'available providers',
        catalog.catalog.apiProviders.map((entry) => entry.id),
      )}`,
    );
  }
  if (!requested.endpointId) return;
  const endpoint = provider.endpoints.find((entry) => entry?.id === requested.endpointId);
  if (!endpoint) {
    fail(
      'UNKNOWN_ENDPOINT',
      `unknown endpoint ${requested.endpointId} in provider ${provider.id}; ${availableValues(
        'available endpoints',
        provider.endpoints.map((entry) => entry.id),
      )}`,
    );
  }
  if (!agent.supportedProtocols.includes(endpoint.protocol)) {
    fail('INCOMPATIBLE_ENDPOINT', `endpoint ${requested.endpointId} is not compatible with agent ${agent.id}`);
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
  const agent = requireCatalogAgent(catalog, agentId);
  return resolveModelSelectionForAgent(catalog, agent, requested);
}

function resolveModelSelectionForAgent(
  catalog: ModelCatalogResponse,
  agent: AgentCatalogEntry,
  requested: RequestedModelSelection,
): ResolvedModelSelection {
  assertProviderAndEndpoint(catalog, agent, requested);
  const matches = matchingModels(requireCatalogModels(agent), requested);
  if (matches.length > 1) {
    const routes = matches.map(describeRouting).join(', ');
    fail(
      'AMBIGUOUS_MODEL',
      `model ${requested.model} is ambiguous across: ${routes}; specify --provider and --endpoint`,
    );
  }
  const selected = matches[0];
  if (!selected) {
    if (requested.providerId || requested.endpointId || agent.requiresStrictModelDiscovery) {
      fail('UNKNOWN_MODEL', `model ${requested.model} is not available for agent ${agent.id}`);
    }
    return {
      model: requested.model,
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
    };
  }
  return resolveCatalogModelSelection(catalog, agent, selected);
}

function strictPermissionMode(
  requested: PermissionMode | undefined,
  agent: AgentCatalogEntry,
  fallback: PermissionMode,
): PermissionMode {
  if (requested === undefined) {
    return normalizeSupportedPermissionMode(fallback, agent.supportedPermissionModes);
  }
  if (!agent.supportedPermissionModes.includes(requested)) {
    fail('UNSUPPORTED_PERMISSION_MODE', `permission mode ${requested} is not supported by agent ${agent.id}`);
  }
  return requested;
}

function strictThinkingMode(
  requested: string | undefined,
  agent: AgentCatalogEntry,
  fallback: ThinkingMode,
): ThinkingMode {
  if (requested === undefined) {
    return normalizeSupportedThinkingMode(fallback, agent.supportedThinkingModes);
  }
  if (!isThinkingMode(requested) || !isThinkingModeSupported(requested, agent.supportedThinkingModes)) {
    fail('UNSUPPORTED_REASONING_EFFORT', `reasoning effort ${requested} is not supported by agent ${agent.id}`);
  }
  return requested;
}

export function validateExplicitModes(
  catalog: ModelCatalogResponse,
  agentId: string,
  requested: { readonly permissionMode?: PermissionMode; readonly thinkingMode?: string },
): void {
  const agent = requireCatalogAgent(catalog, agentId);
  if (requested.permissionMode !== undefined) {
    strictPermissionMode(requested.permissionMode, agent, 'default');
  }
  if (requested.thinkingMode !== undefined) {
    strictThinkingMode(requested.thinkingMode, agent, 'none');
  }
}

export function resolveStartSelection(
  catalog: ModelCatalogResponse,
  settings: Pick<RemoteSettingsSnapshot, 'executionDefaults'>,
  requested: RequestedStartSelection,
): ResolvedStartSelection {
  const agent = requireCatalogAgent(catalog, requested.agentId);
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
    fail(
      'PERMISSION_OVERRIDE_REQUIRED',
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
    ...resolveModelSelectionForAgent(catalog, agent, requested),
    permissionMode,
    thinkingMode,
    agentSettings,
  };
}
