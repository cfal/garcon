// API provider management service. Owns validation, redaction, endpoint
// testing, and model discovery for user-managed compatible endpoints.

import { apiProviderTemplate } from '../../common/api-provider-templates.js';
import type { AgentModelOption } from '../../common/agents.js';
import type { ApiProviderDiscoveryRequest } from '@garcon/server-agent-interface';
import {
  API_PROVIDER_TEMPLATE_IDS,
  isApiProviderTemplateId,
  labelForProtocol,
  type ApiProviderCatalogEntry,
  type ApiProviderModelDiscoveryRequest,
  type ApiProviderModelDiscoveryResponse,
  type ApiProviderTemplateId,
  type ApiProtocol,
  type ModelDiscoveryKind,
  type OpenAiEndpointCapabilities,
} from '../../common/api-providers.js';
import type { ApiProviderStore, CreateApiProviderInput, StoredApiProvider, UpdateApiProviderInput } from './store.js';

export interface ApiProviderInput {
  templateId: ApiProviderTemplateId;
  label: string;
  endpoint: {
    protocol: ApiProtocol;
    baseUrl: string;
    apiKey?: string;
    clearApiKey?: boolean;
    capabilities?: OpenAiEndpointCapabilities;
    defaultModel: string;
    models: Array<{ value: string; label: string; supportsImages?: boolean; isLocal?: boolean }>;
    supportsImages: boolean;
    modelDiscovery?: ModelDiscoveryKind;
  };
}

interface ApiProviderModelDiscoveryFlatInput {
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey?: string;
  apiProviderId?: string | null;
  endpointId?: string | null;
  modelDiscovery: ModelDiscoveryKind;
}

interface StoredDiscoveryCredentialResult {
  apiKey?: string;
  hasKeyForDifferentOrigin: boolean;
}

export interface ApiProviderServiceDeps {
  store: ApiProviderStore;
  isApiProviderReferenced(apiProviderId: string): boolean;
  discoverModels(nodeId: string, request: ApiProviderDiscoveryRequest): Promise<ApiProviderModelDiscoveryResponse>;
}

function redactApiProviderForCatalog(apiProvider: StoredApiProvider): ApiProviderCatalogEntry {
  const { endpoints, ...rest } = apiProvider;
  return {
    ...rest,
    endpoints: endpoints.map((ep) => {
      const { apiKey: _, headers: _headers, ...epRest } = ep;
      return { ...epRest, hasApiKey: Boolean(ep.apiKey), apiKeyLabel: ep.apiKeyLabel ?? '' };
    }),
  };
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireObject(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeTemplateId(value: unknown): ApiProviderTemplateId {
  if (isApiProviderTemplateId(value)) return value;
  throw new Error(`templateId must be ${API_PROVIDER_TEMPLATE_IDS.join(', ')}`);
}

function normalizeApiProviderBaseUrl(value: unknown): string {
  const trimmed = requireString(value, 'endpoint.baseUrl');
  const normalized = trimmed.startsWith('http://') || trimmed.startsWith('https://')
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('endpoint.baseUrl must use http or https');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('endpoint.baseUrl must not include query or fragment components');
  }
  return normalized.replace(/\/+$/, '');
}

function normalizeOptionalLookupId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a string`);
  }
  return value.trim();
}

function normalizeProtocol(value: unknown): ApiProtocol {
  if (value === 'anthropic-messages' || value === 'openai-compatible') return value;
  throw new Error('endpoint.protocol must be anthropic-messages or openai-compatible');
}

function normalizeApiProviderCapabilities(
  protocol: ApiProtocol,
  value: unknown,
): OpenAiEndpointCapabilities | undefined {
  if (protocol !== 'openai-compatible') return undefined;
  const raw = value === undefined ? {} : requireObject(value, 'endpoint.capabilities');
  const chatCompletions = optionalBoolean(raw.chatCompletions, 'endpoint.capabilities.chatCompletions') ?? true;
  const responses = optionalBoolean(raw.responses, 'endpoint.capabilities.responses') ?? false;
  if (!chatCompletions && !responses) {
    throw new Error('OpenAI-compatible endpoints must support Chat Completions or Responses.');
  }
  return { chatCompletions, responses };
}

function normalizeApiProviderModels(value: unknown, defaultModel: string): AgentModelOption[] {
  if (!Array.isArray(value)) {
    return [{ value: defaultModel, label: defaultModel }];
  }
  const models: AgentModelOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    const modelValue = typeof model.value === 'string' ? model.value.trim() : '';
    const label = typeof model.label === 'string' ? model.label.trim() : '';
    if (!modelValue || !label) continue;
    const normalized: AgentModelOption = { value: modelValue, label };
    if (typeof model.supportsImages === 'boolean') normalized.supportsImages = model.supportsImages;
    if (typeof model.isLocal === 'boolean') normalized.isLocal = model.isLocal;
    models.push(normalized);
  }
  if (models.length > 0) return models;
  return defaultModel ? [{ value: defaultModel, label: defaultModel }] : [];
}

function normalizeModelDiscovery(protocol: ApiProtocol, value: unknown): ModelDiscoveryKind {
  if (value === 'none') return 'none';
  if (value === 'ollama-tags') return 'ollama-tags';
  if (value === 'openrouter-models') return 'openrouter-models';
  if (value === 'anthropic-models') return 'anthropic-models';
  if (protocol === 'openai-compatible') return 'openai-models';
  return 'none';
}

function flattenApiProviderInput(input: ApiProviderInput): CreateApiProviderInput {
  const root = requireObject(input, 'API provider');
  const endpoint = requireObject(root.endpoint, 'endpoint');
  const protocol = normalizeProtocol(endpoint.protocol);
  const templateId = normalizeTemplateId(root.templateId);
  if (!apiProviderTemplate(protocol, templateId)) {
    throw new Error(`Unsupported template for ${labelForProtocol(protocol)} providers: ${templateId}`);
  }
  const defaultModel = requireString(endpoint.defaultModel, 'endpoint.defaultModel');
  return {
    templateId,
    label: requireString(root.label, 'label'),
    protocol,
    baseUrl: normalizeApiProviderBaseUrl(endpoint.baseUrl),
    apiKey: typeof endpoint.apiKey === 'string' ? endpoint.apiKey : undefined,
    capabilities: normalizeApiProviderCapabilities(protocol, endpoint.capabilities),
    defaultModel,
    models: normalizeApiProviderModels(endpoint.models, defaultModel),
    supportsImages: optionalBoolean(endpoint.supportsImages, 'endpoint.supportsImages') ?? false,
    modelDiscovery: normalizeModelDiscovery(protocol, endpoint.modelDiscovery),
  };
}

function flattenApiProviderPatch(input: Partial<ApiProviderInput>): UpdateApiProviderInput {
  const root = requireObject(input, 'API provider');
  const result: UpdateApiProviderInput = {};
  const label = optionalString(root.label, 'label');
  if (label !== undefined) result.label = label;
  const inputEndpoint = optionalObject(root.endpoint, 'endpoint');
  if (inputEndpoint) {
    const protocol = inputEndpoint.protocol === undefined ? undefined : normalizeProtocol(inputEndpoint.protocol);
    const endpoint: UpdateApiProviderInput['endpoint'] = {};
    if (inputEndpoint.baseUrl !== undefined) endpoint.baseUrl = normalizeApiProviderBaseUrl(inputEndpoint.baseUrl);
    if (inputEndpoint.apiKey !== undefined) {
      if (typeof inputEndpoint.apiKey !== 'string') throw new Error('endpoint.apiKey must be a string');
      endpoint.apiKey = inputEndpoint.apiKey;
    }
    const clearApiKey = optionalBoolean(inputEndpoint.clearApiKey, 'endpoint.clearApiKey');
    if (clearApiKey !== undefined) endpoint.clearApiKey = clearApiKey;
    if (inputEndpoint.capabilities !== undefined) {
      if (!protocol) throw new Error('endpoint.protocol is required when endpoint.capabilities is patched');
      endpoint.capabilities = normalizeApiProviderCapabilities(protocol, inputEndpoint.capabilities);
    }
    if (inputEndpoint.defaultModel !== undefined) endpoint.defaultModel = requireString(inputEndpoint.defaultModel, 'endpoint.defaultModel');
    if (inputEndpoint.models !== undefined) {
      const defaultModel = endpoint.defaultModel
        ?? (typeof inputEndpoint.defaultModel === 'string' ? inputEndpoint.defaultModel : '');
      endpoint.models = normalizeApiProviderModels(inputEndpoint.models, defaultModel);
    }
    const supportsImages = optionalBoolean(inputEndpoint.supportsImages, 'endpoint.supportsImages');
    if (supportsImages !== undefined) endpoint.supportsImages = supportsImages;
    if (inputEndpoint.modelDiscovery !== undefined) {
      if (!protocol) throw new Error('endpoint.protocol is required when endpoint.modelDiscovery is patched');
      endpoint.modelDiscovery = normalizeModelDiscovery(protocol, inputEndpoint.modelDiscovery);
    }
    if (Object.keys(endpoint).length > 0) result.endpoint = endpoint;
  }
  return result;
}

function defaultModelDiscoveryForProtocol(protocol: ApiProtocol): ModelDiscoveryKind {
  return protocol === 'anthropic-messages' ? 'anthropic-models' : 'openai-models';
}

function normalizeModelDiscoveryForFetch(protocol: ApiProtocol, value: unknown): ModelDiscoveryKind {
  const normalized = normalizeModelDiscovery(protocol, value);
  return normalized === 'none' ? defaultModelDiscoveryForProtocol(protocol) : normalized;
}

function flattenApiProviderModelDiscoveryInput(input: ApiProviderModelDiscoveryRequest): ApiProviderModelDiscoveryFlatInput {
  const root = requireObject(input, 'API provider model discovery');
  const protocol = normalizeProtocol(root.protocol);
  return {
    protocol,
    baseUrl: normalizeApiProviderBaseUrl(root.baseUrl),
    apiKey: typeof root.apiKey === 'string' && root.apiKey.length > 0 ? root.apiKey : undefined,
    apiProviderId: normalizeOptionalLookupId(root.apiProviderId, 'apiProviderId'),
    endpointId: normalizeOptionalLookupId(root.endpointId, 'endpointId'),
    modelDiscovery: normalizeModelDiscoveryForFetch(protocol, root.modelDiscovery),
  };
}

function hasSameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

export class ApiProviderService {
  constructor(private readonly deps: ApiProviderServiceDeps) {}

  getCatalog(): ApiProviderCatalogEntry[] {
    return this.deps.store.redactedList() as ApiProviderCatalogEntry[];
  }

  async create(input: ApiProviderInput): Promise<ApiProviderCatalogEntry> {
    const apiProvider = await this.deps.store.createApiProvider(flattenApiProviderInput(input));
    return redactApiProviderForCatalog(apiProvider);
  }

  async update(id: string, input: Partial<ApiProviderInput>): Promise<ApiProviderCatalogEntry> {
    const apiProvider = await this.deps.store.updateApiProvider(id, flattenApiProviderPatch(input));
    return redactApiProviderForCatalog(apiProvider);
  }

  async delete(id: string): Promise<void> {
    await this.deps.store.deleteApiProvider(id, this.deps.isApiProviderReferenced);
  }

  async test(input: ApiProviderInput, nodeId = 'local'): Promise<ApiProviderModelDiscoveryResponse> {
    const flat = flattenApiProviderInput(input);
    return this.deps.discoverModels(nodeId, {
      protocol: flat.protocol, baseUrl: flat.baseUrl, apiKey: flat.apiKey,
      modelDiscovery: flat.modelDiscovery ?? 'none',
    });
  }

  async discoverModels(input: ApiProviderModelDiscoveryRequest, nodeId = 'local'): Promise<ApiProviderModelDiscoveryResponse> {
    const flat = flattenApiProviderModelDiscoveryInput(input);
    const usesCredentials = flat.modelDiscovery !== 'ollama-tags';
    const storedCredential = flat.apiKey || !usesCredentials ? null : this.#storedApiKeyForDiscovery(flat);
    if (storedCredential?.hasKeyForDifferentOrigin) {
      return {
        success: false,
        error: 'Enter the API key for this base URL before fetching models.',
      };
    }
    return this.deps.discoverModels(nodeId, {
      protocol: flat.protocol, baseUrl: flat.baseUrl, modelDiscovery: flat.modelDiscovery,
      apiKey: usesCredentials ? flat.apiKey ?? storedCredential?.apiKey : undefined,
    });
  }

  #storedApiKeyForDiscovery(input: Pick<
    ApiProviderModelDiscoveryFlatInput,
    'apiProviderId' | 'endpointId' | 'protocol' | 'baseUrl'
  >): StoredDiscoveryCredentialResult {
    let hasKeyForDifferentOrigin = false;
    if (input.endpointId) {
      const resolved = this.deps.store.getEndpoint(input.endpointId);
      if (resolved?.endpoint.protocol === input.protocol) {
        if (hasSameOrigin(resolved.endpoint.baseUrl, input.baseUrl)) {
          return {
            apiKey: resolved.endpoint.apiKey || undefined,
            hasKeyForDifferentOrigin: false,
          };
        }
        if (resolved.endpoint.apiKey) hasKeyForDifferentOrigin = true;
      }
    }
    if (input.apiProviderId) {
      const apiProvider = this.deps.store.getApiProvider(input.apiProviderId);
      const protocolEndpoints = apiProvider?.endpoints.filter(
        (entry) => entry.protocol === input.protocol,
      );
      const endpoint = protocolEndpoints?.find(
        (entry) => hasSameOrigin(entry.baseUrl, input.baseUrl),
      );
      if (endpoint) {
        return {
          apiKey: endpoint.apiKey || undefined,
          hasKeyForDifferentOrigin: false,
        };
      }
      if (protocolEndpoints?.some((entry) => entry.apiKey)) {
        hasKeyForDifferentOrigin = true;
      }
    }
    return { hasKeyForDifferentOrigin };
  }
}
