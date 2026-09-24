// Persists user-managed API providers and their protocol-specific endpoints.
// Credentials stay server-side; catalog responses expose only redacted flags.

import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { AtomicJsonWriteError, readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { ApiProviderReferenceWrites } from './reference-writes.js';
import {
  apiProviderTemplate,
  type ApiProviderTemplate,
} from '../../common/api-provider-templates.js';
import {
  isApiProviderTemplateId,
  labelForProtocol,
  type ApiProtocol,
  type ApiProviderTemplateId,
  type ModelDiscoveryKind,
  type OpenAiEndpointCapabilities,
} from '../../common/api-providers.js';
import type { AgentModelOption } from '../../common/agents.js';
import { getConfigDir } from '../config.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { DomainError } from '../lib/domain-error.js';

const SAFE_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const MODEL_DISCOVERY_KINDS = new Set<ModelDiscoveryKind>([
  'none',
  'anthropic-models',
  'openai-models',
  'ollama-tags',
  'openrouter-models',
]);

export interface StoredApiProvider {
  id: string;
  revision: number;
  label: string;
  templateId?: ApiProviderTemplateId;
  endpoints: StoredApiProviderEndpoint[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredApiProviderEndpoint {
  id: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  apiKeyLabel?: string;
  capabilities?: OpenAiEndpointCapabilities;
  defaultModel: string;
  models: AgentModelOption[];
  supportsImages: boolean;
  modelDiscovery: ModelDiscoveryKind;
  headers?: Record<string, string>;
}

export interface CreateApiProviderInput {
  templateId: ApiProviderTemplateId;
  label: string;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKey?: string;
  capabilities?: OpenAiEndpointCapabilities;
  defaultModel: string;
  models: AgentModelOption[];
  supportsImages: boolean;
  modelDiscovery: ModelDiscoveryKind;
}

export interface UpdateApiProviderEndpointInput {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  capabilities?: OpenAiEndpointCapabilities;
  defaultModel?: string;
  models?: AgentModelOption[];
  supportsImages?: boolean;
  modelDiscovery?: ModelDiscoveryKind;
}

export interface UpdateApiProviderInput {
  revision?: number;
  label?: string;
  endpoint?: UpdateApiProviderEndpointInput;
}

export interface ApiProviderStoreSnapshot {
  version: 2;
  legacyProviderIds: string[];
  apiProviders: StoredApiProvider[];
}

function storePath(): string {
  return path.join(getConfigDir(), 'api-providers.json');
}

function redactEndpoint(endpoint: StoredApiProviderEndpoint) {
  const { apiKey: _apiKey, headers: _headers, ...rest } = endpoint;
  return {
    ...rest,
    hasApiKey: Boolean(endpoint.apiKey),
    apiKeyLabel: endpoint.apiKeyLabel ?? '',
  };
}

function createApiProviderId(label: string): string {
  const suffix = crypto.randomBytes(3).toString('hex');
  const maxBaseLength = 64 - '_anthropic'.length - suffix.length - 1;
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, maxBaseLength);
  const id = `${base}_${suffix}`;
  return SAFE_ID_RE.test(id) ? id : `custom_${suffix}`;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeBaseUrl(url: string): string {
  let normalized = normalizeRequiredString(url, 'baseUrl');
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `https://${normalized}`;
  }
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('baseUrl must not include query or fragment components');
  }
  return normalized.replace(/\/+$/, '');
}

function labelApiKey(apiKey: string | undefined): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function normalizeManualModels(models: AgentModelOption[], defaultModel: string): AgentModelOption[] {
  const fallback = normalizeRequiredString(defaultModel, 'defaultModel');
  const normalized: AgentModelOption[] = [];
  if (Array.isArray(models)) {
    for (const model of models) {
      if (!model || typeof model !== 'object') continue;
      const value = typeof model.value === 'string' ? model.value.trim() : '';
      const label = typeof model.label === 'string' ? model.label.trim() : '';
      if (!value || !label) continue;
      const normalizedModel: AgentModelOption = { value, label };
      if (typeof model.supportsImages === 'boolean') normalizedModel.supportsImages = model.supportsImages;
      if (typeof model.isLocal === 'boolean') normalizedModel.isLocal = model.isLocal;
      if (typeof model.apiProviderId === 'string') normalizedModel.apiProviderId = model.apiProviderId;
      if (typeof model.endpointId === 'string') normalizedModel.endpointId = model.endpointId;
      if (typeof model.rawModel === 'string') normalizedModel.rawModel = model.rawModel;
      if (model.protocol === 'openai-compatible' || model.protocol === 'anthropic-messages') {
        normalizedModel.protocol = model.protocol;
      }
      normalized.push(normalizedModel);
    }
  }

  if (normalized.length === 0) {
    return [{ value: fallback, label: fallback }];
  }
  const hasDefault = normalized.some((m) => m.value === fallback);
  return hasDefault ? normalized : [{ value: fallback, label: fallback }, ...normalized];
}

function normalizeProtocol(value: unknown): ApiProtocol | null {
  return value === 'anthropic-messages' || value === 'openai-compatible' ? value : null;
}

function normalizeTemplateId(value: unknown): ApiProviderTemplateId | undefined {
  if (isApiProviderTemplateId(value)) return value;
  return undefined;
}

function normalizeModelDiscovery(protocol: ApiProtocol, value: unknown): ModelDiscoveryKind {
  if (typeof value === 'string' && MODEL_DISCOVERY_KINDS.has(value as ModelDiscoveryKind)) {
    return value as ModelDiscoveryKind;
  }
  return protocol === 'openai-compatible' ? 'openai-models' : 'none';
}

function normalizeOpenAiCapabilities(
  protocol: ApiProtocol,
  value: unknown,
): OpenAiEndpointCapabilities | undefined {
  if (protocol !== 'openai-compatible') return undefined;
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const capabilities = {
    chatCompletions: raw.chatCompletions !== false,
    responses: raw.responses === true,
  };
  if (!capabilities.chatCompletions && !capabilities.responses) {
    throw new Error('OpenAI-compatible endpoints must support Chat Completions or Responses.');
  }
  return capabilities;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') headers[key] = raw;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeStoredEndpoint(value: unknown): StoredApiProviderEndpoint | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id)) return null;
  const protocol = normalizeProtocol(raw.protocol);
  if (!protocol) return null;
  if (typeof raw.baseUrl !== 'string' || typeof raw.defaultModel !== 'string') return null;
  const defaultModel = normalizeRequiredString(raw.defaultModel, 'defaultModel');
  return {
    id: raw.id,
    protocol,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    apiKeyLabel: typeof raw.apiKeyLabel === 'string' ? raw.apiKeyLabel : labelApiKey(typeof raw.apiKey === 'string' ? raw.apiKey : ''),
    capabilities: normalizeOpenAiCapabilities(protocol, raw.capabilities),
    defaultModel,
    models: normalizeManualModels(Array.isArray(raw.models) ? raw.models as AgentModelOption[] : [], defaultModel),
    supportsImages: Boolean(raw.supportsImages),
    modelDiscovery: normalizeModelDiscovery(protocol, raw.modelDiscovery),
    headers: normalizeHeaders(raw.headers),
  };
}

function normalizeStoredApiProvider(value: unknown): StoredApiProvider | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id) || typeof raw.label !== 'string') return null;
  if (!Array.isArray(raw.endpoints)) return null;

  const endpoints = raw.endpoints
    .map((endpoint) => {
      try {
        return normalizeStoredEndpoint(endpoint);
      } catch {
        return null;
      }
    })
    .filter((endpoint): endpoint is StoredApiProviderEndpoint => endpoint !== null);
  if (endpoints.length === 0 || endpoints.length !== raw.endpoints.length) return null;

  const now = new Date().toISOString();
  return {
    id: raw.id,
    revision: Number.isSafeInteger(raw.revision) && Number(raw.revision) > 0 ? Number(raw.revision) : 1,
    label: raw.label,
    templateId: normalizeTemplateId(raw.templateId),
    endpoints,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

function normalizeSnapshot(raw: unknown): ApiProviderStoreSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('API provider state must be a JSON object');
  }
  const root = raw as Record<string, unknown>;
  if ((root.version !== 1 && root.version !== 2) || !Array.isArray(root.apiProviders)) {
    throw new TypeError('Invalid API provider state');
  }
  const providers = root.apiProviders.map(normalizeStoredApiProvider);
  if (providers.some((entry) => entry === null)) throw new TypeError('Invalid API provider profile');
  const providerIds = providers.map((entry) => entry!.id);
  const endpointIds = providers.flatMap((entry) => entry!.endpoints.map((endpoint) => endpoint.id));
  if (new Set(providerIds).size !== providerIds.length || new Set(endpointIds).size !== endpointIds.length) {
    throw new TypeError('Duplicate API provider or endpoint IDs');
  }
  if (root.version === 2 && (!Array.isArray(root.legacyProviderIds)
    || !root.legacyProviderIds.every((id) => typeof id === 'string' && SAFE_ID_RE.test(id))
    || root.apiProviders.some((entry) => !Number.isSafeInteger(entry.revision) || entry.revision < 1))) {
    throw new TypeError('Invalid API provider revision or migration seed');
  }
  return {
    version: 2,
    legacyProviderIds: root.version === 1 ? providers.map((entry) => entry!.id) : root.legacyProviderIds as string[],
    apiProviders: providers as StoredApiProvider[],
  };
}

function endpointSuffix(protocol: ApiProtocol): string {
  return protocol === 'anthropic-messages' ? 'anthropic' : 'openai';
}

function headersForTemplate(template: ApiProviderTemplate | null): Record<string, string> | undefined {
  if (template?.managedHeaders === 'openrouter') {
    return {
      'HTTP-Referer': 'https://github.com/cfal/garcon',
      'X-OpenRouter-Title': 'Garcon',
    };
  }
  return undefined;
}

function applyApiKeyPatch(
  endpoint: StoredApiProviderEndpoint,
  patch: { apiKey?: string; clearApiKey?: boolean },
): void {
  if (patch.clearApiKey) {
    endpoint.apiKey = '';
    endpoint.apiKeyLabel = '';
    return;
  }
  if (typeof patch.apiKey === 'string' && patch.apiKey.length > 0) {
    endpoint.apiKey = patch.apiKey;
    endpoint.apiKeyLabel = labelApiKey(patch.apiKey);
  }
}

export class ApiProviderStore {
  #snapshot: ApiProviderStoreSnapshot = { version: 2, legacyProviderIds: [], apiProviders: [] };
  #unavailable = false;
  readonly #writeLock = new KeyedPromiseLock();
  readonly referenceWrites = new ApiProviderReferenceWrites((id) => this.getApiProvider(id) !== null);
  readonly #listeners = new Set<() => void>();

  constructor(private readonly filePath = storePath()) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.withLock(async () => {
      const snapshot = await readJsonStateFile<ApiProviderStoreSnapshot>({
        filePath: this.filePath,
        empty: () => ({ version: 2, legacyProviderIds: [], apiProviders: [] }),
        normalize: normalizeSnapshot,
      });
      await this.#write(snapshot);
    });
  }

  get legacyProviderIds(): readonly string[] {
    this.#assertAvailable();
    return this.#snapshot.legacyProviderIds;
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  list(): StoredApiProvider[] {
    this.#assertAvailable();
    return this.#snapshot.apiProviders;
  }

  redactedList() {
    return this.list().map((apiProvider) => ({
      ...apiProvider,
      endpoints: apiProvider.endpoints.map(redactEndpoint),
    }));
  }

  getApiProvider(id: string): StoredApiProvider | null {
    return this.list().find((apiProvider) => apiProvider.id === id) ?? null;
  }

  getEndpoint(endpointId: string): { apiProvider: StoredApiProvider; endpoint: StoredApiProviderEndpoint } | null {
    for (const apiProvider of this.list()) {
      const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
      if (endpoint) return { apiProvider, endpoint };
    }
    return null;
  }

  async createApiProvider(input: CreateApiProviderInput): Promise<StoredApiProvider> {
    const label = normalizeRequiredString(input.label, 'label');
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const capabilities = normalizeOpenAiCapabilities(input.protocol, input.capabilities);
    const defaultModel = normalizeRequiredString(input.defaultModel, 'defaultModel');
    const models = normalizeManualModels(input.models, defaultModel);
    const template = apiProviderTemplate(input.protocol, input.templateId);
    if (!template) {
      throw new Error(`Unsupported template for ${labelForProtocol(input.protocol)} providers: ${input.templateId}`);
    }

    return this.withLock(async () => {
      const snapshot = structuredClone(this.#snapshot);
      const now = new Date().toISOString();
      const id = createApiProviderId(label);
      const endpointId = `${id}_${endpointSuffix(input.protocol)}`;
      const apiProvider: StoredApiProvider = {
        id,
        revision: 1,
        label,
        templateId: input.templateId,
        createdAt: now,
        updatedAt: now,
        endpoints: [{
          id: endpointId,
          protocol: input.protocol,
          baseUrl,
          apiKey: input.apiKey ?? '',
          apiKeyLabel: labelApiKey(input.apiKey),
          capabilities,
          defaultModel,
          models,
          supportsImages: Boolean(input.supportsImages),
          modelDiscovery: input.modelDiscovery,
          headers: headersForTemplate(template),
        }],
      };
      snapshot.apiProviders.push(apiProvider);
      await this.#write(snapshot);
      return apiProvider;
    });
  }

  async updateApiProvider(id: string, input: UpdateApiProviderInput): Promise<StoredApiProvider> {
    return this.withLock(async () => {
      const snapshot = structuredClone(this.#snapshot);
      const apiProvider = snapshot.apiProviders.find((entry) => entry.id === id);
      if (!apiProvider) throw new Error(`Unknown API provider: ${id}`);
      if (input.revision !== undefined && input.revision !== apiProvider.revision) {
        throw new DomainError('API_PROVIDER_CONFIGURATION_CHANGED', 'Provider configuration changed. Reload before saving.', 409);
      }
      if (apiProvider.revision >= Number.MAX_SAFE_INTEGER) throw new Error('API provider revision exhausted');
      apiProvider.revision++;

      if (input.label !== undefined) {
        apiProvider.label = normalizeRequiredString(input.label, 'label');
      }
      apiProvider.updatedAt = new Date().toISOString();

      if (input.endpoint) {
        const endpointId = input.endpoint.id ?? apiProvider.endpoints[0]?.id;
        const endpoint = apiProvider.endpoints.find((entry) => entry.id === endpointId);
        if (!endpoint) throw new Error(`Unknown endpoint: ${endpointId}`);
        endpoint.baseUrl = input.endpoint.baseUrl !== undefined ? normalizeBaseUrl(input.endpoint.baseUrl) : endpoint.baseUrl;
        endpoint.capabilities = input.endpoint.capabilities !== undefined
          ? normalizeOpenAiCapabilities(endpoint.protocol, input.endpoint.capabilities)
          : endpoint.capabilities;
        endpoint.defaultModel = input.endpoint.defaultModel !== undefined
          ? normalizeRequiredString(input.endpoint.defaultModel, 'defaultModel')
          : endpoint.defaultModel;
        endpoint.models = input.endpoint.models
          ? normalizeManualModels(input.endpoint.models, endpoint.defaultModel)
          : endpoint.models;
        endpoint.supportsImages = typeof input.endpoint.supportsImages === 'boolean'
          ? input.endpoint.supportsImages
          : endpoint.supportsImages;
        endpoint.modelDiscovery = input.endpoint.modelDiscovery !== undefined
          ? input.endpoint.modelDiscovery
          : endpoint.modelDiscovery;
        applyApiKeyPatch(endpoint, input.endpoint);
      }

      await this.#write(snapshot);
      return apiProvider;
    });
  }

  async deleteApiProvider(id: string, isReferenced: (apiProviderId: string) => boolean): Promise<void> {
    return this.withLock(async () => {
      const snapshot = structuredClone(this.#snapshot);
      const apiProvider = snapshot.apiProviders.find((entry) => entry.id === id);
      if (!apiProvider) return;
      const release = this.referenceWrites.deleting(id, () => isReferenced(id));
      try {
        snapshot.apiProviders = snapshot.apiProviders.filter((entry) => entry.id !== id);
        await this.#write(snapshot);
      } finally {
        release();
      }
    });
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.#writeLock.runExclusive('profiles', () => {
      this.#assertAvailable();
      return fn();
    });
  }

  async #write(snapshot: ApiProviderStoreSnapshot): Promise<void> {
    try {
      await writeJsonFileAtomic(this.filePath, snapshot, { mode: 0o600 });
    } catch (error) {
      if (error instanceof AtomicJsonWriteError && error.renamed) this.#unavailable = true;
      this.#notify();
      throw error;
    }
    this.#snapshot = snapshot;
    this.#notify();
  }

  #assertAvailable(): void {
    if (this.#unavailable) {
      throw new DomainError('API_PROVIDER_STORAGE_UNAVAILABLE', 'Provider write durability is unknown. Restart after checking configuration.', 503);
    }
  }
}
